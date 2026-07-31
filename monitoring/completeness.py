import datetime as dt
import logging
from typing import Optional

import pandas as pd
import pytz
from prefect import flow

import clients.epex.endpoints.ida2 as epex_ida2
import clients.epex.endpoints.vwap as epex_vwap
from core import PriceStore, setup_logging  # noqa: E402 (must precede Database import, see core/dev_paths.py)
from Database.db_connect import engine
from quent_core.utils.email_utils import send_email

logger = logging.getLogger(__name__)

price_store = PriceStore(engine)

MARKET_TYPE = "DAY_AHEAD"
INTRADAY_MARKET_TYPE = "INTRADAY"

DELIVERY_DAY_TZ = pytz.timezone("Europe/Copenhagen")

# every bidding_zone from project-overview.md's matrix with >=1 live source today. static
# list, not shared via core/, since scrapers may split into their own repos later and a shared
# constant would complicate that split; revisit as a core/ constant if this needs to be reused.
IN_SCOPE_ZONES = [
    "AT", "BE", "BG", "CH", "CZ", "DE", "DK1", "DK2", "EE", "ES", "FI", "FR", "GB", "GR",
    "HR", "HU", "IE", "IT_NORD", "IT_CNOR", "IT_CSUD", "IT_SUD", "IT_SICI", "IT_SARD",
    "IT_CALA", "LT", "LV", "NL", "NO1", "NO2", "NO3", "NO4", "NO5", "PL", "PT", "RO",
    "SE1", "SE2", "SE3", "SE4", "SI", "SK",
]


def _day_bounds_utc(date: dt.date) -> tuple[dt.datetime, dt.datetime]:
    start = DELIVERY_DAY_TZ.localize(dt.datetime.combine(date, dt.time.min)).astimezone(dt.timezone.utc)
    end = DELIVERY_DAY_TZ.localize(dt.datetime.combine(date + dt.timedelta(days=1), dt.time.min)).astimezone(dt.timezone.utc)
    return start, end


def check_completeness(
    bidding_zones: list[str], market_type: str, target_date: dt.date, markets: Optional[list[str]] = None
) -> list[str]:
    """return the sorted list of zone (or "zone/market" when markets is given) combos with zero
    rows for target_date. markets=None checks zone-level presence only (day-ahead: one market
    per zone in practice); markets=[...] checks each zone/market combo separately, since e.g.
    VWAP's ID1/ID3/IDFULL come from the same file fetch but aren't guaranteed to all be present."""
    start, end = _day_bounds_utc(target_date)
    df = price_store.get(market_type=market_type, from_valuetime=pd.Timestamp(start), to_valuetime=pd.Timestamp(end))

    if not markets:
        present_zones = set(df["bidding_zone"].unique())
        return sorted(set(bidding_zones) - present_zones)

    present = set(zip(df["bidding_zone"], df["market"]))
    expected = {(zone, market) for zone in bidding_zones for market in markets}
    return sorted(f"{zone}/{market}" for zone, market in (expected - present))


def send_alert(sections: list[tuple[str, dt.date, list[str]]]) -> None:
    """notify that one or more activated zone/market combos have zero rows for their target
    delivery day. each section carries its own target_date - day-ahead/IDA2/VWAP publish on
    different schedules (see project-overview.md > Scheduling), so they aren't the same day."""
    lines = []
    for label, target_date, missing in sections:
        if not missing:
            continue
        logger.warning(
            "%s completeness check: %d missing for %s: %s", label, len(missing), target_date, ", ".join(missing)
        )
        lines.append(f"{label} missing for {target_date}:\n" + "\n".join(missing))

    if not lines:
        return

    total_missing = sum(len(missing) for _, _, missing in sections)
    subject = f"Price completeness: {total_missing} item(s) missing"
    content = "\n\n".join(lines)
    try:
        send_email(subject, content, recipient="sebastian@quent.dk")
    except Exception:
        logger.exception("price completeness alert: failed to send email")


# cron: 0 17 * * *  (CET/CEST; runs after every live source's catch-up window for tomorrow's
# delivery day has closed - GB HalfHourly is the latest at ~15:30 CET. IDA2/VWAP check earlier
# delivery days in the same run, see below - their own publish windows have already closed too)
@flow
def run(target_date: Optional[dt.date] = None) -> dict[str, list[str]]:
    """check that every activated zone/market combo has landed data for its own target delivery day.

    never raises/fails the Prefect run on missing data - zero rows for a combo is a monitorable
    outcome (logged + alerted), not a code error. target_date defaults to tomorrow's delivery
    day, anchoring the DAY_AHEAD check (SDAC clears same-day ~12:55 CET for tomorrow's delivery).
    IDA2 (gate closure 22:00 CET the evening before delivery) and VWAP (published the morning
    after delivery) are on different schedules, so they check target_date - 1 and - 2
    respectively - by this flow's 17:00 CET run, those are the most recent delivery days each
    source's catch-up window has actually had time to publish.
    """
    setup_logging()
    target_date = target_date or dt.date.today() + dt.timedelta(days=1)
    ida2_date = target_date - dt.timedelta(days=1)
    vwap_date = target_date - dt.timedelta(days=2)

    sections = [
        ("DAY_AHEAD", target_date, check_completeness(IN_SCOPE_ZONES, MARKET_TYPE, target_date)),
        (
            "EPEX IDA2",
            ida2_date,
            check_completeness(
                list(epex_ida2.ZONE_FILE_CONFIG), INTRADAY_MARKET_TYPE, ida2_date, markets=[epex_ida2.MARKET]
            ),
        ),
        (
            "EPEX VWAP",
            vwap_date,
            check_completeness(
                list(epex_vwap.ZONE_FILE_CONFIG),
                INTRADAY_MARKET_TYPE,
                vwap_date,
                markets=sorted(epex_vwap.INDEX_NAMES),
            ),
        ),
    ]

    if any(missing for _, _, missing in sections):
        send_alert(sections)
    else:
        logger.info("price completeness check: all activated zone/market combos have data")

    return {label: missing for label, _, missing in sections}


if __name__ == "__main__":
    run()
