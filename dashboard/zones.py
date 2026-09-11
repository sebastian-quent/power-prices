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
import time

import pandas as pd
import pytz
from sqlalchemy import text

from core import PriceStore, get_engine

engine = get_engine()

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

_MARKET_ZONES_CACHE: dict = {"zones": None, "fetched_at": 0.0}
_MARKET_ZONES_TTL_SECONDS = 86400  # 24h - a new zone/auction is rare/deliberate, not worth polling for


def get_market_zones() -> dict[tuple[str, str], set[str]]:
    """bidding zones that have ever landed a row for each (market_type, market) pair in
    prod.prices, across all history - not a hardcoded per-auction zone list (dashboard/app.py's
    MARKET_OPTIONS used to hardcode e.g. "zones": ["GB"] for N2EX, or borrow a scraper's own
    ZONE_FILE_CONFIG for the IDA/VWAP auctions) - so an auction's actual coverage changing (a new
    zone added, or one dropped) shows up here without a code change. Mirrors imbalance's
    get_scraped_zones() (dashboard/zones.py in the sibling imbalance repo) - same 24h cache, same
    reasoning: this only changes on a deliberate scraper change, not routine day-to-day scraping -
    a dashboard process left running for a while shouldn't re-query this on every date/market
    switch just to get the same answer back.
    """
    now = time.monotonic()
    if _MARKET_ZONES_CACHE["zones"] is None or now - _MARKET_ZONES_CACHE["fetched_at"] > _MARKET_ZONES_TTL_SECONDS:
        with price_store.engine.connect() as conn:
            rows = conn.execute(text("SELECT DISTINCT market_type, market, bidding_zone FROM prod.prices"))
            grouped: dict[tuple[str, str], set[str]] = {}
            for market_type, market, bidding_zone in rows:
                grouped.setdefault((market_type, market), set()).add(bidding_zone)
        _MARKET_ZONES_CACHE["zones"] = grouped
        _MARKET_ZONES_CACHE["fetched_at"] = now
    return _MARKET_ZONES_CACHE["zones"]


def _day_bounds_utc(date: dt.date) -> tuple[dt.datetime, dt.datetime]:
    start = DELIVERY_DAY_TZ.localize(dt.datetime.combine(date, dt.time.min)).astimezone(dt.timezone.utc)
    end = DELIVERY_DAY_TZ.localize(dt.datetime.combine(date + dt.timedelta(days=1), dt.time.min)).astimezone(dt.timezone.utc)
    return start, end


# (market, bidding_zone) pairs whose auction only covers the second half of the local delivery
# day (12:00-24:00), not the full day - so "expected" for these can't be span_minutes/resolution
# over the whole day. Confirmed empirically against prod.prices (every zone's actual max row
# count topped out at exactly half the full-day count, always starting at local 12:00, never
# more): IDA3's own gate closure is ~10:00 CET/CEST on delivery day D itself, covering only
# periods from Hour 13 onward - unlike IDA1/IDA2, which gate-close the evening of D-1 and cover
# the whole day (scrapers' clients/epex/endpoints/ida3.py). GB and CH each also run their own
# local (non-pan-European) IDA2 auction that likewise gate-closes mid-morning on D rather than
# the evening of D-1 - the pan-European IDA2 label is shared but the product isn't (scrapers'
# clients/epex/endpoints/ida.py module docstring). A day's DST transition always falls before
# noon, so this half never absorbs the 23/25-hour anomaly - it's a flat 12h/resolution every day.
_HALF_DAY_MARKETS = {"IDA3"}
_HALF_DAY_MARKET_ZONES = {("IDA2", "GB"), ("IDA2", "CH")}


def _expected_periods(
    market: str, bidding_zone: str, resolution: int, start: dt.datetime, end: dt.datetime, target_date: dt.date
) -> int:
    if market in _HALF_DAY_MARKETS or (market, bidding_zone) in _HALF_DAY_MARKET_ZONES:
        start = DELIVERY_DAY_TZ.localize(dt.datetime.combine(target_date, dt.time(12, 0))).astimezone(dt.timezone.utc)
    span_minutes = (end - start).total_seconds() / 60
    return round(span_minutes / resolution)


def _get_day_rows(target_date: dt.date) -> pd.DataFrame:
    """raw prod.prices rows for one delivery day, across every market_type/market - the shared
    fetch behind build_zone_summary() (one market's view), build_auctions_summary() (all markets'
    status) and build_price_rows() (CSV export). Deliberately always a live query, no caching -
    this repo's dedup/rescrape strategy allows a rescrape to insert a new row at any time for an
    already-published day (see Dedup/rescrape strategy in project-overview.md), and for a trading
    tool a changed price silently not showing up because of a cache window is worse than the
    (now small, since this replaced a 14-query fan-out) cost of a live query per request."""
    start, end = _day_bounds_utc(target_date)
    return price_store.get(from_valuetime=pd.Timestamp(start), to_valuetime=pd.Timestamp(end))


def build_auctions_summary(target_date: dt.date) -> dict[tuple[str, str], set[str]]:
    """bidding zones with at least one landed row per (market_type, market), for one delivery
    day - powers app.py's /api/auctions status panel, which only needs has-data booleans, not
    build_zone_summary's full avg_price/curve rollup."""
    df = _get_day_rows(target_date)
    grouped: dict[tuple[str, str], set[str]] = {}
    if df.empty:
        return grouped
    for (market_type, market), rows in df.groupby(["market_type", "market"]):
        grouped[(market_type, market)] = set(rows["bidding_zone"].unique())
    return grouped


def build_price_rows(target_date: dt.date, market_type: str, market: str) -> pd.DataFrame:
    """raw per-period price rows for one market/day, for CSV export (see app.py's /api/download)
    - every (bidding_zone, source) row as landed, not build_zone_summary's per-zone baseload/
    curve rollup."""
    df = _get_day_rows(target_date)
    return df[(df["market_type"] == market_type) & (df["market"] == market)].reset_index(drop=True)


def build_zone_summary(
    target_date: dt.date, market_type: str = MARKET_TYPE, market: str | None = None,
    resolution_minutes: int | None = None,
) -> dict[str, dict]:
    """one entry per IN_SCOPE_ZONES, keyed by bidding_zone.

    `market_type`/`market` select the view (e.g. DAY_AHEAD/None for the day-ahead baseload
    across all its auctions, or INTRADAY/"IDA2" for just that auction), filtered in pandas out of
    _get_day_rows()'s already-fetched whole day rather than a query of their own.

    `resolution_minutes`, if given, filters to just that settlement resolution before grouping -
    needed for EPEX's VWAP indices (ID1/ID3/IDFULL), which scrape both 15min and 60min rows under
    the *same* (source, market) - resolution isn't part of the groupby key below, so without this
    filter the two would silently blend into one averaged price/curve instead of staying distinct
    (see app.py's VWAP_MARKETS/resolution toggle).

    headline `avg_price` ("baseload") is the mean of each (source, market)'s own average price,
    not a straight row-mean - GB lands two markets at different resolutions (N2EX hourly,
    GbHalfHour half-hourly, see project-overview.md), and a plain row-mean would let the
    half-hourly market's 2x row count silently outweigh the hourly one. `curve` is the raw
    per-period prices from the single (source, market) that landed the most periods that day.
    """
    start, end = _day_bounds_utc(target_date)
    df = _get_day_rows(target_date)
    if market_type is not None:
        df = df[df["market_type"] == market_type]
    if market is not None:
        df = df[df["market"] == market]
    if resolution_minutes is not None and not df.empty:
        df = df[df["resolution"] == resolution_minutes]

    summary = {
        zone: {"has_data": False, "avg_price": None, "currency": None, "sources": [], "curve_source": None, "curve": []}
        for zone in IN_SCOPE_ZONES
    }
    if df.empty:
        return summary

    by_market = (
        df.groupby(["bidding_zone", "source", "market"])
        .agg(actual=("valuetime", "size"), resolution=("resolution", "first"),
             avg_price=("price", "mean"), currency=("currency", "first"))
        .reset_index()
    )
    by_market["expected"] = by_market.apply(
        lambda row: _expected_periods(row.market, row.bidding_zone, row.resolution, start, end, target_date), axis=1
    )

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
            {
                "time": row.valuetime.astimezone(DELIVERY_DAY_TZ).strftime("%H:%M"),
                "time_utc": row.valuetime.astimezone(dt.timezone.utc).strftime("%H:%M"),
                "price": round(float(row.price), 2),
            }
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
