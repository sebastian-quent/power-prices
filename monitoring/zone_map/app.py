"""map dashboard: European bidding zones, colored once an auction's price has landed - covers
day-ahead, EPEX's IDA1/IDA2/IDA3 intraday auctions, and EPEX's ID1/ID3/IDFULL intraday continuous
VWAP indices, see MARKET_OPTIONS.

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

# one entry per auction the UI can show. day-ahead defaults to tomorrow's delivery day (auctions
# clear the day before delivery); IDA1/IDA2 clear on the same D-1 timing (see
# clients/epex/endpoints/ida1.py / ida2.py), gate closures 15:00/22:00 CET/CEST the afternoon/
# evening before delivery, so both also default to tomorrow. IDA3 is a same-day auction instead
# (gate closure ~10:00 CET/CEST on delivery day D itself, see clients/epex/endpoints/ida3.py), so
# it defaults to today.
#
# `zones` is the completeness denominator for the /api/auctions traffic light - each auction's
# own actually-scraped zone list, not the full 41-zone IN_SCOPE_ZONES, so e.g. IDA2 (currently
# BE-only, see project-overview.md > Scope) reads "complete" once BE lands rather than staying
# amber/red forever for zones it was never going to cover.
#
# `clears` times are CET/CEST wall-clock, matching project-overview.md > Scheduling. `clear_at`
# is the same clearing time made machine-checkable: (day_offset relative to target_date, wall-clock
# time in DELIVERY_DAY_TZ) at which the auction has definitely cleared, used by get_auctions() to
# tell "hasn't cleared yet" (no light) apart from "cleared and we still have nothing" (red) - see
# the "late" status below. For ID1/ID3/IDFULL's published range, the *end* of the range is used
# (23:20, not 22:40) so the light doesn't turn red while the auction is still within its normal
# publish window.
MARKET_OPTIONS = {
    "day_ahead": {
        "market_type": "DAY_AHEAD", "market": None, "default_offset_days": 1,
        "label": "Day-ahead", "clears": "~12:55 CET/CEST", "zones": IN_SCOPE_ZONES,
        "clear_at": (-1, dt.time(12, 55)),
    },
    "ida1": {
        "market_type": "INTRADAY", "market": "IDA1", "default_offset_days": 1,
        "label": "IDA1", "clears": "15:00 CET/CEST (D-1)", "zones": list(IDA1_ZONES),
        "clear_at": (-1, dt.time(15, 0)),
    },
    "ida2": {
        "market_type": "INTRADAY", "market": "IDA2", "default_offset_days": 1,
        "label": "IDA2", "clears": "22:00 CET/CEST (D-1)", "zones": list(IDA2_ZONES),
        "clear_at": (-1, dt.time(22, 0)),
    },
    "ida3": {
        "market_type": "INTRADAY", "market": "IDA3", "default_offset_days": 0,
        "label": "IDA3", "clears": "~10:00 CET/CEST (D)", "zones": list(IDA3_ZONES),
        "clear_at": (0, dt.time(10, 0)),
    },
    # ID1/ID3/IDFULL are EOD continuous-trading VWAP indices (see clients/epex/endpoints/vwap.py),
    # not auctions - not published until the delivery day's continuous trading has fully closed,
    # so (unlike day-ahead/IDA2) they default to yesterday's delivery day rather than today/tomorrow.
    "id1": {
        "market_type": "INTRADAY", "market": "ID1", "default_offset_days": -1,
        "label": "ID1", "clears": "EOD, ~22:40 CET/CEST", "zones": list(VWAP_ZONES),
        "clear_at": (0, dt.time(23, 20)),
    },
    "id3": {
        "market_type": "INTRADAY", "market": "ID3", "default_offset_days": -1,
        "label": "ID3", "clears": "EOD, ~22:40 CET/CEST", "zones": list(VWAP_ZONES),
        "clear_at": (0, dt.time(23, 20)),
    },
    "idfull": {
        "market_type": "INTRADAY", "market": "IDFULL", "default_offset_days": -1,
        "label": "IDFULL", "clears": "EOD, ~22:40 CET/CEST", "zones": list(VWAP_ZONES),
        "clear_at": (0, dt.time(23, 20)),
    },
}


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


@app.get("/api/prices")
def get_prices(date: str | None = None, market: str = "day_ahead") -> dict:
    """price summary per in-scope bidding zone for one market view (see MARKET_OPTIONS).
    `date` is the delivery day (YYYY-MM-DD); defaults to that market's own natural default -
    tomorrow for day-ahead and IDA2 alike (same D-1 clearing pattern, see MARKET_OPTIONS)."""
    if market not in MARKET_OPTIONS:
        market = "day_ahead"
    opts = MARKET_OPTIONS[market]
    target_date = dt.date.fromisoformat(date) if date else dt.date.today() + dt.timedelta(days=opts["default_offset_days"])
    zones = build_zone_summary(target_date, market_type=opts["market_type"], market=opts["market"])
    return {"date": target_date.isoformat(), "market": market, "zones": zones}


@app.get("/api/auctions")
def get_auctions(date: str | None = None) -> dict:
    """status per auction (see MARKET_OPTIONS) for one shared delivery day - driven by whatever
    date the main map is currently showing (see static/app.js's loadAuctions calls), not each
    auction's own "today/tomorrow" default, so browsing back to an already-backfilled day reads
    e.g. 41/41 there instead of always reporting on the live day. Defaults to today if no date
    is given (e.g. a bare API call with no query param).

    status is "complete" once every zone that auction actually covers has data, "partial" once
    some (but not all) of them do. With none yet, it's "late" if the auction's own clearing time
    (see MARKET_OPTIONS' clear_at) has already passed for this target_date - a real gap worth
    flagging red - or "pending" if it simply hasn't cleared yet, which is expected and shown
    neutral rather than as a problem. Never raised as an error even when late, same "log, don't
    fail" spirit as monitoring/completeness.py.
    """
    target_date = dt.date.fromisoformat(date) if date else dt.date.today()
    now = dt.datetime.now(DELIVERY_DAY_TZ)
    auctions = []
    for key, opts in MARKET_OPTIONS.items():
        summary = build_zone_summary(target_date, market_type=opts["market_type"], market=opts["market"])
        zones = opts["zones"]
        have = sum(1 for zone in zones if summary[zone]["has_data"])
        total = len(zones)
        day_offset, clear_time = opts["clear_at"]
        cleared = now >= DELIVERY_DAY_TZ.localize(dt.datetime.combine(target_date + dt.timedelta(days=day_offset), clear_time))
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
