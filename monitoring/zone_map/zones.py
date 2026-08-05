"""per-zone price summary for a delivery day, for the map dashboard's /api/prices - covers
DAY_AHEAD (default) as well as intraday auctions like IDA2 (pass market_type/market).

groups by (source, bidding_zone, market) before summing to actual/expected per zone, extended with:
- a headline "baseload" price per zone (mean price across the day's settlement periods - same
  thing EPEX's own market-results map calls "Baseload"), averaged across sources rather than a
  straight row-mean, for the GB mixed-resolution reason below.
- a per-period price curve from whichever source landed the most periods that day ("primary"),
  for the hover detail table.
"""

import datetime as dt

import pandas as pd
import pytz

from core import PriceStore
from Database.db_connect import engine

MARKET_TYPE = "DAY_AHEAD"
DELIVERY_DAY_TZ = pytz.timezone("Europe/Copenhagen")

# same 41-zone list as monitoring/completeness.py, duplicated rather than shared via
# core/ - consistent with that module's own note to only promote it once a real need for
# sharing shows up.
IN_SCOPE_ZONES = [
    "AT", "BE", "BG", "CH", "CZ", "DE", "DK1", "DK2", "EE", "ES", "FI", "FR", "GB", "GR",
    "HR", "HU", "IE", "IT_NORD", "IT_CNOR", "IT_CSUD", "IT_SUD", "IT_SICI", "IT_SARD",
    "IT_CALA", "LT", "LV", "NL", "NO1", "NO2", "NO3", "NO4", "NO5", "PL", "PT", "RO",
    "SE1", "SE2", "SE3", "SE4", "SI", "SK",
]

price_store = PriceStore(engine)


def _day_bounds_utc(date: dt.date) -> tuple[dt.datetime, dt.datetime]:
    start = DELIVERY_DAY_TZ.localize(dt.datetime.combine(date, dt.time.min)).astimezone(dt.timezone.utc)
    end = DELIVERY_DAY_TZ.localize(dt.datetime.combine(date + dt.timedelta(days=1), dt.time.min)).astimezone(dt.timezone.utc)
    return start, end


def build_price_rows(target_date: dt.date, market_type: str, market: str) -> pd.DataFrame:
    """raw per-period price rows for one market/day, for CSV export (see app.py's /api/download)
    - every (bidding_zone, source) row as landed, not build_zone_summary's per-zone baseload/
    curve rollup."""
    start, end = _day_bounds_utc(target_date)
    return price_store.get(market_type=market_type, market=market, from_valuetime=pd.Timestamp(start), to_valuetime=pd.Timestamp(end))


def build_zone_summary(target_date: dt.date, market_type: str = MARKET_TYPE, market: str | None = None) -> dict[str, dict]:
    """one entry per IN_SCOPE_ZONES, keyed by bidding_zone.

    `market_type`/`market` select the view (e.g. DAY_AHEAD/None for the day-ahead baseload
    across all its auctions, or INTRADAY/"IDA2" for just that auction) - passed straight through
    to PriceStore.get(), which already supports filtering on both.

    headline `avg_price` ("baseload") is the mean of each (source, market)'s own average price,
    not a straight row-mean - GB lands two markets at different resolutions (N2EX hourly,
    GbHalfHour half-hourly, see project-overview.md), and a plain row-mean would let the
    half-hourly market's 2x row count silently outweigh the hourly one. `curve` is the raw
    per-period prices from the single (source, market) that landed the most periods that day.
    """
    start, end = _day_bounds_utc(target_date)
    df = price_store.get(
        market_type=market_type, market=market, from_valuetime=pd.Timestamp(start), to_valuetime=pd.Timestamp(end)
    )

    summary = {
        zone: {"has_data": False, "avg_price": None, "currency": None, "sources": [], "curve_source": None, "curve": []}
        for zone in IN_SCOPE_ZONES
    }
    if df.empty:
        return summary

    span_minutes = (end - start).total_seconds() / 60
    by_market = (
        df.groupby(["bidding_zone", "source", "market"])
        .agg(actual=("valuetime", "size"), resolution=("resolution", "first"),
             avg_price=("price", "mean"), currency=("currency", "first"))
        .reset_index()
    )
    by_market["expected"] = (span_minutes / by_market["resolution"]).round().astype(int)

    for zone, rows in by_market.groupby("bidding_zone"):
        if zone not in summary:
            continue  # zone not in our in-scope list (shouldn't happen, but don't blow up on it)
        sources = [
            {
                "source": row.source,
                "market": row.market,
                "actual": int(row.actual),
                "expected": int(row.expected),
                "avg_price": round(float(row.avg_price), 2),
            }
            for row in rows.itertuples()
        ]

        # "primary" source for the hover curve: whichever (source, market) landed the most
        # settlement periods for this zone/day - no per-zone primary/backup assignment exists
        # yet (see project-overview.md Scheduling), so this is a per-request, per-day pick
        # rather than a fixed table. ties broken alphabetically for determinism.
        primary = rows.sort_values(["actual", "source", "market"], ascending=[False, True, True]).iloc[0]
        curve_df = df[
            (df["bidding_zone"] == zone) & (df["source"] == primary["source"]) & (df["market"] == primary["market"])
        ].sort_values("valuetime")
        curve = [
            {"time": row.valuetime.astimezone(DELIVERY_DAY_TZ).strftime("%H:%M"), "price": round(float(row.price), 2)}
            for row in curve_df.itertuples()
        ]

        summary[zone] = {
            "has_data": True,
            "avg_price": round(float(rows["avg_price"].mean()), 2),
            "currency": rows["currency"].iloc[0],
            "sources": sources,
            "curve_source": f"{primary['source']} ({primary['market']})",
            "curve": curve,
        }

    return summary
