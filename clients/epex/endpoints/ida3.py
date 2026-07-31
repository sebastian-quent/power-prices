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

# empty until IDA3 scraping is confirmed needed (see project-overview.md Open items) -
# add zones here to go live, same shape as ida2.py's ZONE_FILE_CONFIG, e.g.:
# "BE": ZoneFile("belgium", "belgium"),
ZONE_FILE_CONFIG = {}


def fetch_and_parse(bidding_zones: list, from_date: dt.date, to_date: dt.date) -> pd.DataFrame:
    return ida.fetch_and_parse(MARKET, ZONE_FILE_CONFIG, dump, bidding_zones, from_date, to_date)


def dump(df: pd.DataFrame) -> None:
    """write IDA3 intraday auction prices to prod.prices via PriceStore."""
    # OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # for bidding_zone, zone_df in df.groupby("bidding_zone"):
    #     zone_df.to_csv(OUTPUT_DIR / f"{bidding_zone}.csv", index=False)

    written = price_store.dump(df)
    logger.info("PriceStore.dump: wrote %d row(s) for EPEX IDA3", written)


# not yet scheduled - ZONE_FILE_CONFIG is intentionally empty until IDA3 scraping is
# confirmed needed (see project-overview.md Open items); confirm gate closure timing
# before adding a cron and zones
@flow
def run(
    bidding_zones: Optional[list] = None, from_date: Optional[dt.date] = None, to_date: Optional[dt.date] = None
) -> pd.DataFrame:
    """fetch EPEX Pan-European IDA3 intraday auction prices and dump to prod.prices.

    bidding_zones optional, defaults to every zone in ZONE_FILE_CONFIG (empty for now)
    from_date/to_date optional for historical backfill; defaults to tomorrow only, matching
    ida2.py's D-1 gate-closure assumption - revisit once IDA3's own gate closure is confirmed.
    """
    setup_logging()
    tomorrow = dt.date.today() + dt.timedelta(days=1)
    from_date = from_date or tomorrow
    to_date = to_date or tomorrow
    bidding_zones = bidding_zones or list(ZONE_FILE_CONFIG)

    df = fetch_and_parse(bidding_zones, from_date=from_date, to_date=to_date)
    if df.empty:
        logger.warning("no EPEX IDA3 data fetched for %s to %s", from_date, to_date)
    return df


if __name__ == "__main__":
    run()
