import datetime as dt
import io
import logging
import re
import zipfile
from pathlib import Path
from typing import NamedTuple, Optional

import pandas as pd
from prefect import flow

import clients.epex.client as epex_client
from core import PriceStore, setup_logging  # noqa: E402 (must precede Database import, see core/dev_paths.py)
from Database.db_connect import engine

logger = logging.getLogger(__name__)

price_store = PriceStore(engine)

SOURCE = "EPEX"
MARKET_TYPE = "INTRADAY"

OUTPUT_DIR = Path("output/epex/vwap")

# Only 15min (BE's actual settlement granularity) is kept;
# 30min/60min are dropped as redundant re-aggregations of the same data.
RESOLUTION_MINUTES = 15
INDEX_NAMES = {"ID1", "ID3", "IDFULL"}


class ZoneFile(NamedTuple):
    folder: str  # SFTP top-level folder, e.g. "belgium"
    zone_code: str  # bidding_zone code as used in the filename itself, e.g. "BE"


# TODO: expand eventually to all EPEX bidding zones
ZONE_FILE_CONFIG = {
    "BE": ZoneFile("belgium", "BE"),
}


def _current_dir(zone: ZoneFile) -> str:
    return f"/{zone.folder}/Intraday Continuous/Indices/Intraday indices"


def _historical_zip_path(zone: ZoneFile, year: int) -> str:
    return f"/{zone.folder}/Intraday Continuous/Indices/Historical/Intraday indices/Continuous_Index-{zone.zone_code}-{year}.zip"


def _filename_pattern(zone: ZoneFile) -> re.Pattern:
    return re.compile(rf"Continuous_Index-{re.escape(zone.zone_code)}-(\d{{8}})-.*\.csv$")


def _list_current_year_files(zone: ZoneFile) -> dict:
    """date -> filename for the current year's per-day index files - filenames embed an
    unpredictable publish timestamp, so the date they cover must be resolved via listing
    rather than constructed like every other EPEX endpoint's fixed annual filename."""
    filenames = epex_client.list_dir(_current_dir(zone))
    if filenames is None:
        return {}
    pattern = _filename_pattern(zone)
    mapping = {}
    for filename in filenames:
        match = pattern.match(filename)
        if match:
            mapping[dt.datetime.strptime(match.group(1), "%Y%m%d").date()] = filename
    return mapping


def _index_zip_entries(zf: zipfile.ZipFile, zone: ZoneFile) -> dict:
    """date -> zip entry name for one historical year's archive of per-day index files."""
    pattern = _filename_pattern(zone)
    mapping = {}
    for name in zf.namelist():
        match = pattern.match(name)
        if match:
            mapping[dt.datetime.strptime(match.group(1), "%Y%m%d").date()] = name
    return mapping


def parse_csv(content: bytes, bidding_zone: str, forecasttime: pd.Timestamp) -> pd.DataFrame:
    """parse one delivery day's Continuous_Index CSV into prod.prices-shaped rows.

    unlike day-ahead/IDA2's "Hour N"/"3A"/"3B" columns, DeliveryStart is already full UTC
    ISO-8601 - no DST disambiguation needed. Currency is read per row directly from the file,
    not parsed out of a header line.
    """
    df = pd.read_csv(io.BytesIO(content), skiprows=1)
    df = df.loc[(df["TimeResolution"] == "15min") & df["IndexName"].isin(INDEX_NAMES)]

    df = df.assign(
        valuetime=pd.to_datetime(df["DeliveryStart"], utc=True),
        forecasttime=forecasttime,
        bidding_zone=bidding_zone,
        market_type=MARKET_TYPE,
        market=df["IndexName"],
        source=SOURCE,
        resolution=RESOLUTION_MINUTES,
        currency=df["Currency"],
        price=df["IndexPrice"],
    )

    columns = ["valuetime", "forecasttime", "bidding_zone", "market_type", "market", "source", "resolution", "currency", "price"]
    return df[columns].reset_index(drop=True)


def fetch_and_parse(bidding_zones: list, from_date: dt.date, to_date: dt.date) -> pd.DataFrame:
    """fetch, parse, and dump EPEX intraday continuous VWAP indices (ID1/ID3/FULL) one zone at a time.

    dates in the current calendar year are resolved against the live per-day folder; dates in
    past years against that year's zip archive - the same function transparently serves a
    same-day scheduled run and an arbitrary historical backfill range. dumping per zone (rather
    than once for the whole batch) mirrors day_ahead.py's/ida2.py's fetch_and_parse.
    """
    dates = list(pd.date_range(from_date, to_date, freq="D").date)
    current_year = dt.date.today().year

    frames = []
    for bidding_zone in bidding_zones:
        zone = ZONE_FILE_CONFIG[bidding_zone]
        zone_frames = []

        current_dates = [date for date in dates if date.year == current_year]
        if current_dates:
            file_map = _list_current_year_files(zone)
            for date in current_dates:
                filename = file_map.get(date)
                if filename is None:
                    logger.warning("skipping %s VWAP %s: no file published yet", bidding_zone, date)
                    continue
                remote_path = f"{_current_dir(zone)}/{filename}"
                content = epex_client.fetch_file(remote_path)
                if content is None:
                    logger.warning("skipping %s VWAP %s: EPEX fetch failed", bidding_zone, date)
                    continue
                forecasttime = epex_client.stat_mtime(remote_path)
                try:
                    zone_frames.append(parse_csv(content, bidding_zone, forecasttime))
                except (KeyError, ValueError):
                    logger.error("skipping %s VWAP %s: failed to parse EPEX file", bidding_zone, date, exc_info=True)

        historical_years = sorted({date.year for date in dates if date.year != current_year})
        for year in historical_years:
            zip_path = _historical_zip_path(zone, year)
            zip_content = epex_client.fetch_file(zip_path)
            if zip_content is None:
                logger.warning("skipping %s VWAP %s: EPEX historical zip fetch failed", bidding_zone, year)
                continue
            zip_forecasttime = epex_client.stat_mtime(zip_path)
            zf = zipfile.ZipFile(io.BytesIO(zip_content))
            entry_map = _index_zip_entries(zf, zone)
            for date in [date for date in dates if date.year == year]:
                entry_name = entry_map.get(date)
                if entry_name is None:
                    logger.warning("skipping %s VWAP %s: not found in historical zip", bidding_zone, date)
                    continue
                with zf.open(entry_name) as f:
                    content = f.read()
                try:
                    zone_frames.append(parse_csv(content, bidding_zone, zip_forecasttime))
                except (KeyError, ValueError):
                    logger.error("skipping %s VWAP %s: failed to parse EPEX file", bidding_zone, date, exc_info=True)

        if not zone_frames:
            continue
        zone_df = pd.concat(zone_frames, ignore_index=True)
        if zone_df.empty:
            continue
        try:
            dump(zone_df)
        except Exception:
            logger.error("skipping dump for %s: PriceStore.dump failed", bidding_zone, exc_info=True)
            continue
        frames.append(zone_df)

    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def dump(df: pd.DataFrame) -> None:
    """write intraday continuous VWAP indices (ID1/ID3/FULL) to prod.prices via PriceStore."""
    # OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # for bidding_zone, zone_df in df.groupby("bidding_zone"):
    #     zone_df.to_csv(OUTPUT_DIR / f"{bidding_zone}.csv", index=False)

    written = price_store.dump(df)
    logger.info("PriceStore.dump: wrote %d row(s) for EPEX VWAP", written)


@flow
def run(
    bidding_zones: Optional[list] = None, from_date: Optional[dt.date] = None, to_date: Optional[dt.date] = None
) -> pd.DataFrame:
    """fetch EPEX intraday continuous VWAP indices (ID1/ID3/FULL) and dump to prod.prices.

    bidding_zones optional, defaults to every zone in ZONE_FILE_CONFIG.
    from_date/to_date optional for historical backfill;
    defaults to yesterday, file isn't available until the delivery day has fully closed.
    """
    setup_logging()
    yesterday = dt.date.today() - dt.timedelta(days=1)
    from_date = from_date or yesterday
    to_date = to_date or yesterday
    bidding_zones = bidding_zones or list(ZONE_FILE_CONFIG)

    df = fetch_and_parse(bidding_zones, from_date=from_date, to_date=to_date)
    if df.empty:
        logger.warning("no EPEX VWAP data fetched for %s to %s", from_date, to_date)
    return df


if __name__ == "__main__":
    run()
