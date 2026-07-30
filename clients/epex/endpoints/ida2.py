import datetime as dt
import io
import logging
from pathlib import Path
from typing import NamedTuple, Optional

import pandas as pd
import pytz
from prefect import flow

import clients.epex.client as epex_client
from core import PriceStore, setup_logging  # noqa: E402 (must precede Database import, see core/dev_paths.py)
from Database.db_connect import engine

logger = logging.getLogger(__name__)

price_store = PriceStore(engine)

SOURCE = "EPEX"
MARKET_TYPE = "INTRADAY"
MARKET = "IDA2"
DEFAULT_CURRENCY = "EUR"
RESOLUTION_MINUTES = 15

OUTPUT_DIR = Path("output/epex/ida2")

DELIVERY_DAY_TZ = pytz.timezone("Europe/Copenhagen")


class ZoneFile(NamedTuple):
    folder: str  # SFTP top-level folder, e.g. "belgium"
    filename_slug: str  # filename segment, e.g. "belgium"


# TODO: expand eventually to all EPEX bidding zones
ZONE_FILE_CONFIG = {
    "BE": ZoneFile("belgium", "belgium"),
}


def _day_bounds_utc(date: dt.date) -> tuple:
    start = DELIVERY_DAY_TZ.localize(dt.datetime.combine(date, dt.time.min)).astimezone(dt.timezone.utc)
    end = DELIVERY_DAY_TZ.localize(dt.datetime.combine(date + dt.timedelta(days=1), dt.time.min)).astimezone(dt.timezone.utc)
    return start, end


def _convert_subhour_to_timestamp(date: pd.Timestamp, slot: str) -> pd.Timestamp:
    """"Hour 3 Q2" -> that quarter-hour slot's start, handling the DST-ambiguous "Hour 3A"/"3B" columns."""
    _, hour_str, quarter_str = slot.split(" ")
    if hour_str == "3A":
        hour, ambiguous = 2, True  # CEST (spring/summer)
    elif hour_str == "3B":
        hour, ambiguous = 2, False  # CET (winter)
    else:
        hour, ambiguous = int(hour_str) - 1, "raise"

    slot_index = int(quarter_str[1]) - 1
    naive = pd.Timestamp(date) + pd.Timedelta(hours=hour) + pd.Timedelta(minutes=slot_index * RESOLUTION_MINUTES)
    return naive.tz_localize(tz="Europe/Copenhagen", ambiguous=ambiguous)


def _remote_path(zone: ZoneFile, year: int) -> str:
    freshness = "Current" if year == dt.date.today().year else "Historical"
    return (
        f"/{zone.folder}/Intraday Auction/Pan-European IDA2/{freshness}/Prices_Volumes/"
        f"pan-european_prices_{zone.filename_slug}_IDA2_{year}.csv"
    )


def fetch_ida2_file(zone: ZoneFile, year: int) -> tuple:
    """fetch one zone's rolling annual Pan-European IDA2 price file."""
    remote_path = _remote_path(zone, year)
    logger.info("fetching EPEX file %s", remote_path)
    content = epex_client.fetch_file(remote_path)
    if content is None:
        return None, None
    forecasttime = epex_client.stat_mtime(remote_path)
    return content, forecasttime


def _extract_currency(content: bytes) -> str:
    """EPEX's skipped first line reads like "...Prices - pan-european IDA2 - belgium - Currency: EUR"."""
    first_line = content.split(b"\n", 1)[0].decode("utf-8", errors="replace")
    if "Currency:" in first_line:
        return first_line.rsplit("Currency:", 1)[1].strip()
    return DEFAULT_CURRENCY


def parse_csv(content: bytes, bidding_zone: str, forecasttime: pd.Timestamp) -> pd.DataFrame:
    """parse one zone's annual Pan-European IDA2 CSV into prod.prices-shaped rows."""
    currency = _extract_currency(content)

    df = pd.read_csv(io.BytesIO(content), skiprows=1)
    hour_cols = [c for c in df.columns if c.startswith("Hour ")]
    df = df.assign(Date=pd.to_datetime(df["Delivery day"], dayfirst=True)).set_index("Date")[hour_cols]
    df.columns.name = "slot"
    df = df.unstack().rename("price").reset_index()
    df = df.loc[df["price"].notnull()]

    valuetime = df.apply(lambda row: _convert_subhour_to_timestamp(row["Date"], row["slot"]), axis=1).dt.tz_convert("UTC")

    df = df.assign(
        valuetime=valuetime,
        forecasttime=forecasttime,
        bidding_zone=bidding_zone,
        market_type=MARKET_TYPE,
        market=MARKET,
        source=SOURCE,
        resolution=RESOLUTION_MINUTES,
        currency=currency,
    )

    columns = ["valuetime", "forecasttime", "bidding_zone", "market_type", "market", "source", "resolution", "currency", "price"]
    return df[columns].reset_index(drop=True)


def fetch_and_parse(bidding_zones: list, from_date: dt.date, to_date: dt.date) -> pd.DataFrame:
    """fetch, parse, and dump EPEX Pan-European IDA2 prices one zone at a time.

    dumping per zone means a single zone's SFTP fetch, parse, or dump failure
    only costs that zone - mirrors day_ahead.py's fetch_and_parse.
    """
    years = sorted(set(range(from_date.year, to_date.year + 1)))
    window_start, _ = _day_bounds_utc(from_date)
    _, window_end = _day_bounds_utc(to_date)

    frames = []
    for bidding_zone in bidding_zones:
        zone = ZONE_FILE_CONFIG[bidding_zone]
        zone_frames = []
        for year in years:
            content, forecasttime = fetch_ida2_file(zone, year)
            if content is None:
                logger.warning("skipping %s IDA2 %s: EPEX fetch failed", bidding_zone, year)
                continue
            try:
                zone_frames.append(parse_csv(content, bidding_zone, forecasttime))
            except (KeyError, ValueError):
                logger.error("skipping %s IDA2 %s: failed to parse EPEX file", bidding_zone, year, exc_info=True)

        if not zone_frames:
            continue
        zone_df = pd.concat(zone_frames, ignore_index=True)
        zone_df = zone_df.loc[(zone_df["valuetime"] >= window_start) & (zone_df["valuetime"] < window_end)].reset_index(
            drop=True
        )
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
    """write IDA2 intraday auction prices to prod.prices via PriceStore."""
    # OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # for bidding_zone, zone_df in df.groupby("bidding_zone"):
    #     zone_df.to_csv(OUTPUT_DIR / f"{bidding_zone}.csv", index=False)

    written = price_store.dump(df)
    logger.info("PriceStore.dump: wrote %d row(s) for EPEX IDA2", written)


# cron: 5,20,35,50 10-11 * * *  (CET/CEST; gate closure 10:00 CET/CEST)
@flow
def run(
    bidding_zones: Optional[list] = None, from_date: Optional[dt.date] = None, to_date: Optional[dt.date] = None
) -> pd.DataFrame:
    """fetch EPEX Pan-European IDA2 intraday auction prices and dump to prod.prices.

    bidding_zones optional, defaults to every zone in ZONE_FILE_CONFIG
    from_date/to_date optional for historical backfill; defaults to today only - IDA2 publishes
    same-day (gate closure 10:00 CET/CEST on the delivery day).
    """
    setup_logging()
    today = dt.date.today()
    from_date = from_date or today
    to_date = to_date or today
    bidding_zones = bidding_zones or list(ZONE_FILE_CONFIG)

    df = fetch_and_parse(bidding_zones, from_date=from_date, to_date=to_date)
    if df.empty:
        logger.warning("no EPEX IDA2 data fetched for %s to %s", from_date, to_date)
    return df


if __name__ == "__main__":
    run()
