"""map dashboard: European bidding zones, colored once an auction's price has landed - covers
day-ahead (SDAC plus GB's/Ireland's own non-SDAC auctions), EPEX's IDA1/IDA2/IDA3 intraday
auctions, and EPEX's ID1/ID3/IDFULL intraday continuous VWAP indices, see MARKET_OPTIONS.

run with: poetry run uvicorn monitoring.zone_map.app:app --reload
"""

import datetime as dt
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from clients.epex.endpoints.ida1 import ZONE_FILE_CONFIG as IDA1_ZONES
from clients.epex.endpoints.ida2 import ZONE_FILE_CONFIG as IDA2_ZONES
from clients.epex.endpoints.ida3 import ZONE_FILE_CONFIG as IDA3_ZONES
from clients.epex.endpoints.vwap import ZONE_FILE_CONFIG as VWAP_ZONES
from monitoring.zone_map.zones import DELIVERY_DAY_TZ, IN_SCOPE_ZONES, build_zone_summary

STATIC_DIR = Path(__file__).resolve().parent / "static"

# SDAC excludes GB (own N2EX/EPEX auctions, not part of SDAC) and IE (own SEM-DA auction, run
# locally post-2020 even though it shares SDAC's coupling clock, see MARKET_OPTIONS below) - both
# get their own dedicated rows instead.
SDAC_ZONES = [zone for zone in IN_SCOPE_ZONES if zone not in ("GB", "IE")]

# one entry per auction the UI can show, grouped into three panel sections - Day-ahead, IDA,
# VWAP (see static/app.js AUCTION_GROUPS, which mirrors this ordering). GB has no single day-ahead
# auction: Nord Pool (N2EX/GbHalfHour) and EPEX each run their own separate hourly/half-hourly GB
# auctions with different gate closures/publish times, confirmed by direct research (not this
# repo's own docs) - so each gets its own row rather than merging two differently-timed real
# auctions under one label.
#
# `zones` is the completeness denominator for the /api/auctions traffic light - each auction's
# own actually-scraped zone list, not the full 41-zone IN_SCOPE_ZONES, so e.g. IDA2 (currently
# BE-only, see project-overview.md > Scope) reads "complete" once BE lands rather than staying
# amber/red forever for zones it was never going to cover.
#
# `clears` is the auction's results-publication time (CET/CEST wall-clock), researched per auction
# directly from each operator's own published timings rather than this repo's own docs - exact
# where an operator states a firm publish deadline (e.g. N2EX's "at latest 10:00 GMT/11:00 CET"),
# `~`-prefixed where only an estimate exists (IDA1-3's publish moment isn't stated beyond gate
# closure, so it's gate closure + the ~20min auction-processing window quoted for SIDC generally;
# ID1/ID3/IDFULL use EPEX's own indices doc estimate of ~01:15 CET, which doesn't quite match this
# repo's own measured ~00:45-00:55 landing times - the externally-sourced figure is shown here per
# instruction not to rely on this repo's docs for this field). `clear_at` is the same time made
# machine-checkable: (day_offset relative to target_date, wall-clock time in DELIVERY_DAY_TZ) at
# which the auction has definitely cleared, used by get_auctions() to tell "hasn't cleared yet"
# (no light) apart from "cleared and we still have nothing" (red) - see the "late" status below.
# Kept in sync with `clears` (updated together, not left to drift as in the earlier gate-closure
# version of this dict).
MARKET_OPTIONS = {
    "sdac": {
        "market_type": "DAY_AHEAD", "market": "SDAC", "default_offset_days": 1,
        "label": "SDAC", "clears": "12:55 CET/CEST", "zones": SDAC_ZONES,
        "clear_at": (-1, dt.time(12, 55)),
    },
    "n2ex": {
        "market_type": "DAY_AHEAD", "market": "N2EX_DayAhead", "default_offset_days": 1,
        "label": "N2EX", "clears": "11:00 CET/CEST", "zones": ["GB"],
        "clear_at": (-1, dt.time(11, 0)),
    },
    "epex_gb_hourly": {
        "market_type": "DAY_AHEAD", "market": "Hourly", "default_offset_days": 1,
        "label": "EPEX GB Hourly", "clears": "10:30 CET/CEST", "zones": ["GB"],
        "clear_at": (-1, dt.time(10, 30)),
    },
    "gb_hh": {
        "market_type": "DAY_AHEAD", "market": "GbHalfHour_DayAhead", "default_offset_days": 1,
        "label": "GB HalfHourly", "clears": "15:35 CET/CEST", "zones": ["GB"],
        "clear_at": (-1, dt.time(15, 35)),
    },
    "epex_gb_hh": {
        "market_type": "DAY_AHEAD", "market": "HalfHourly", "default_offset_days": 1,
        "label": "EPEX GB HalfHourly", "clears": "16:45 CET/CEST", "zones": ["GB"],
        "clear_at": (-1, dt.time(16, 45)),
    },
    "sem_da": {
        "market_type": "DAY_AHEAD", "market": "SEM_DA", "default_offset_days": 1,
        "label": "SEM-DA", "clears": "12:55 CET/CEST", "zones": ["IE"],
        "clear_at": (-1, dt.time(12, 55)),
    },
    "ida1": {
        "market_type": "INTRADAY", "market": "IDA1", "default_offset_days": 1,
        "label": "IDA1", "clears": "~15:20 CET/CEST (D-1)", "zones": list(IDA1_ZONES),
        "clear_at": (-1, dt.time(15, 20)),
    },
    "ida2": {
        "market_type": "INTRADAY", "market": "IDA2", "default_offset_days": 1,
        "label": "IDA2", "clears": "~22:20 CET/CEST (D-1)", "zones": list(IDA2_ZONES),
        "clear_at": (-1, dt.time(22, 20)),
    },
    "ida3": {
        "market_type": "INTRADAY", "market": "IDA3", "default_offset_days": 0,
        "label": "IDA3", "clears": "~10:20 CET/CEST (D)", "zones": list(IDA3_ZONES),
        "clear_at": (0, dt.time(10, 20)),
    },
    # ID1/ID3/IDFULL are continuous-trading VWAP indices (see clients/epex/endpoints/vwap.py), not
    # auctions - not published until the delivery day's continuous trading has fully closed, so
    # (unlike day-ahead/IDA2) they default to yesterday's delivery day rather than today/tomorrow.
    "id1": {
        "market_type": "INTRADAY", "market": "ID1", "default_offset_days": -1,
        "label": "ID1", "clears": "~01:15 CET/CEST (D+1)", "zones": list(VWAP_ZONES),
        "clear_at": (1, dt.time(1, 15)),
    },
    "id3": {
        "market_type": "INTRADAY", "market": "ID3", "default_offset_days": -1,
        "label": "ID3", "clears": "~01:15 CET/CEST (D+1)", "zones": list(VWAP_ZONES),
        "clear_at": (1, dt.time(1, 15)),
    },
    "idfull": {
        "market_type": "INTRADAY", "market": "IDFULL", "default_offset_days": -1,
        "label": "IDFULL", "clears": "~01:15 CET/CEST (D+1)", "zones": list(VWAP_ZONES),
        "clear_at": (1, dt.time(1, 15)),
    },
}


# SDAC clears ~12:55 CET/CEST (see MARKET_OPTIONS) - before this switch time tomorrow's auction
# hasn't cleared yet, so today is the more useful default; only matters for the page's initial
# load (main() in app.js fetches /api/prices with no date at all) since every later load passes
# an explicit date through instead of relying on this default (see app.js's comment above its
# selectView call).
SDAC_DEFAULT_SWITCH_TIME = dt.time(12, 50)


class CachedStaticFiles(StaticFiles):
    """StaticFiles with a fixed Cache-Control header - how aggressively a given mount can be
    cached depends entirely on how often its files actually change (see mounts below)."""

    def __init__(self, *args, cache_control: str, **kwargs):
        super().__init__(*args, **kwargs)
        self._cache_control = cache_control

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = self._cache_control
        return response


app = FastAPI(title="EUROPEAN PRICE MAP")
app.add_middleware(GZipMiddleware, minimum_size=500)

# most specific mounts first - Starlette matches in registration order, so /static/geo and
# /static/vendor need to be checked before the catch-all /static mount below.
app.mount(
    "/static/geo",
    CachedStaticFiles(directory=STATIC_DIR / "geo", cache_control="public, max-age=3600"),
    name="geo",
)
app.mount(
    "/static/vendor",
    CachedStaticFiles(directory=STATIC_DIR / "vendor", cache_control="public, max-age=604800, immutable"),
    name="vendor",
)
# index.html/app.js/style.css change during active development - no-cache (not "no caching",
# but "always revalidate") so a refresh reliably picks up the latest version instead of the
# stale-until-hard-refresh behavior seen earlier in this project.
app.mount("/static", CachedStaticFiles(directory=STATIC_DIR, cache_control="no-cache"), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


def _is_cleared(target_date: dt.date, opts: dict) -> bool:
    """whether this market's own clearing time (see MARKET_OPTIONS' clear_at) has already
    passed for target_date - i.e. whether a missing zone here is a real gap worth flagging
    rather than just not-published-yet."""
    now = dt.datetime.now(DELIVERY_DAY_TZ)
    day_offset, clear_time = opts["clear_at"]
    return now >= DELIVERY_DAY_TZ.localize(dt.datetime.combine(target_date + dt.timedelta(days=day_offset), clear_time))


@app.get("/api/prices")
def get_prices(date: str | None = None, market: str = "sdac") -> dict:
    """price summary per in-scope bidding zone for one market view (see MARKET_OPTIONS).
    `date` is the delivery day (YYYY-MM-DD); defaults to that market's own natural default -
    IDA2 always tomorrow (D-1 clearing pattern, see MARKET_OPTIONS), SDAC time-aware instead
    (today before SDAC_DEFAULT_SWITCH_TIME CET/CEST, tomorrow after - see that constant).

    `cleared` tells the map's coverage view whether this market's clearing time has already
    passed for `date` - a missing zone only reads as a real gap (red) once true; before that
    it's just not published yet (neutral), see static/app.js's coverageZoneStyle.

    `market_zones` is this market's own `zones` list from MARKET_OPTIONS (e.g. just GB for N2EX,
    39 zones for SDAC) - `zones` itself still covers all 41 IN_SCOPE_ZONES so the map doesn't
    need a second fetch when switching views, but the frontend needs to know which of those 41
    this market could ever cover, so a zone outside that list (e.g. GB/IE under SDAC) reads as
    "not applicable" rather than "no data yet"/a real gap, see static/app.js's
    currentMarketZones."""
    if market not in MARKET_OPTIONS:
        market = "sdac"
    opts = MARKET_OPTIONS[market]
    if date:
        target_date = dt.date.fromisoformat(date)
    elif market == "sdac":
        now = dt.datetime.now(DELIVERY_DAY_TZ)
        offset = 1 if now.time() >= SDAC_DEFAULT_SWITCH_TIME else 0
        target_date = now.date() + dt.timedelta(days=offset)
    else:
        target_date = dt.date.today() + dt.timedelta(days=opts["default_offset_days"])
    zones = build_zone_summary(target_date, market_type=opts["market_type"], market=opts["market"])
    return {
        "date": target_date.isoformat(), "market": market, "cleared": _is_cleared(target_date, opts),
        "zones": zones, "market_zones": opts["zones"],
    }


@app.get("/api/auctions")
def get_auctions(date: str | None = None) -> dict:
    """status per auction (see MARKET_OPTIONS) for one shared delivery day - driven by whatever
    date the main map is currently showing (see static/app.js's loadAuctions calls), not each
    auction's own "today/tomorrow" default, so browsing back to an already-backfilled day reads
    e.g. 39/39 there instead of always reporting on the live day. Defaults to today if no date
    is given (e.g. a bare API call with no query param).

    status is "complete" once every zone that auction actually covers has data, "partial" once
    some (but not all) of them do. With none yet, it's "late" if the auction's own clearing time
    (see MARKET_OPTIONS' clear_at) has already passed for this target_date - a real gap worth
    flagging red - or "pending" if it simply hasn't cleared yet, which is expected and shown
    neutral rather than as a problem. Never raised as an error even when late, same "log, don't
    fail" spirit as monitoring/completeness.py.
    """
    target_date = dt.date.fromisoformat(date) if date else dt.date.today()
    auctions = []
    for key, opts in MARKET_OPTIONS.items():
        summary = build_zone_summary(target_date, market_type=opts["market_type"], market=opts["market"])
        zones = opts["zones"]
        have = sum(1 for zone in zones if summary[zone]["has_data"])
        total = len(zones)
        cleared = _is_cleared(target_date, opts)
        if have == total:
            status = "complete"
        elif have:
            status = "partial"
        else:
            status = "late" if cleared else "pending"
        auctions.append({
            "key": key, "label": opts["label"], "clears": opts["clears"],
            "have": have, "total": total, "status": status,
        })
    return {"date": target_date.isoformat(), "auctions": auctions}
