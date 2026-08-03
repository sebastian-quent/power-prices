import datetime as dt
import logging
from pathlib import Path
from typing import Optional

import pandas as pd
from prefect import flow

import clients.epex.endpoints.ida as ida
from core import PriceStore, setup_logging  # noqa: E402 (must precede Database import, see core/dev_paths.py)
from Database.db_connect import engine

logger = logging.getLogger(__name__)

price_store = PriceStore(engine)

MARKET = "IDA3"
ZoneFile = ida.ZoneFile

OUTPUT_DIR = Path("output/epex/ida3")

# TODO: expand eventually to all EPEX bidding zones
ZONE_FILE_CONFIG = {
    "BE": ZoneFile("belgium", "belgium"),
}


def fetch_and_parse(bidding_zones: list, from_date: dt.date, to_date: dt.date) -> pd.DataFrame:
    return ida.fetch_and_parse(MARKET, ZONE_FILE_CONFIG, dump, bidding_zones, from_date, to_date)


def dump(df: pd.DataFrame) -> None:
    """write IDA3 intraday auction prices to prod.prices via PriceStore."""
    # OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # for bidding_zone, zone_df in df.groupby("bidding_zone"):
    #     zone_df.to_csv(OUTPUT_DIR / f"{bidding_zone}.csv", index=False)

    written = price_store.dump(df)
    logger.info("PriceStore.dump: wrote %d row(s) for EPEX IDA3", written)


# cron: 5,20,35,50 10-11 * * *  (CET/CEST; IDA3 gate closure ~10:00 CET/CEST on delivery day D
# itself, catch-up starts 10:05 - unlike IDA1/IDA2, this is a same-day auction, not D-1)
@flow
def run(
    bidding_zones: Optional[list] = None, from_date: Optional[dt.date] = None, to_date: Optional[dt.date] = None
) -> pd.DataFrame:
    """fetch EPEX Pan-European IDA3 intraday auction prices and dump to prod.prices.

    bidding_zones optional, defaults to every zone in ZONE_FILE_CONFIG.
    from_date/to_date optional for historical backfill; defaults to today only - IDA3 gate
    closure is ~10:00 CET/CEST on delivery day D itself (covers only the day's remaining
    periods, Hour 13 Q1 onward), not D-1 like IDA1/IDA2.
    """
    setup_logging()
    today = dt.date.today()
    from_date = from_date or today
    to_date = to_date or today
    bidding_zones = bidding_zones or list(ZONE_FILE_CONFIG)

    df = fetch_and_parse(bidding_zones, from_date=from_date, to_date=to_date)
    if df.empty:
        logger.warning("no EPEX IDA3 data fetched for %s to %s", from_date, to_date)
    return df


if __name__ == "__main__":
    run()
