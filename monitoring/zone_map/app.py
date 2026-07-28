"""map dashboard: European bidding zones, colored once an auction's price has landed - covers
day-ahead and (so far) EPEX's IDA2 intraday auction, see MARKET_OPTIONS.

run with: poetry run uvicorn monitoring.zone_map.app:app --reload
"""

import datetime as dt
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from clients.epex.endpoints.ida2 import ZONE_FILE_CONFIG as IDA2_ZONES
from monitoring.zone_map.zones import IN_SCOPE_ZONES, build_zone_summary

STATIC_DIR = Path(__file__).resolve().parent / "static"

# one entry per auction the UI can show. day-ahead defaults to tomorrow's delivery day (auctions
# clear the day before delivery); IDA2 is a same-day SIDC auction (see
# clients/epex/endpoints/ida2.py) so it defaults to today instead. IDA1/IDA3 would slot in here
# the same way once those scrapers exist (see project-overview.md > Open items).
#
# `zones` is the completeness denominator for the /api/auctions traffic light - each auction's
# own actually-scraped zone list, not the full 41-zone IN_SCOPE_ZONES, so e.g. IDA2 (currently
# BE-only, see project-overview.md > Scope) reads "complete" once BE lands rather than staying
# amber/red forever for zones it was never going to cover.
#
# `clears` times are CET/CEST wall-clock, matching project-overview.md > Scheduling.
MARKET_OPTIONS = {
    "day_ahead": {
        "market_type": "DAY_AHEAD", "market": None, "default_offset_days": 1,
        "label": "Day-ahead", "clears": "~12:55 CET/CEST", "zones": IN_SCOPE_ZONES,
    },
    "ida2": {
        "market_type": "INTRADAY", "market": "IDA2", "default_offset_days": 0,
        "label": "IDA2", "clears": "10:00 CET/CEST", "zones": list(IDA2_ZONES),
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
    tomorrow for day-ahead (same default as monitoring/day_ahead_completeness.py's run()),
    today for IDA2."""
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
    some (but not all) of them do, "pending" while none do yet - not raised as an error even if
    an auction is running late, same "log, don't fail" spirit as monitoring/day_ahead_completeness.py.
    """
    target_date = dt.date.fromisoformat(date) if date else dt.date.today()
    auctions = []
    for key, opts in MARKET_OPTIONS.items():
        summary = build_zone_summary(target_date, market_type=opts["market_type"], market=opts["market"])
        zones = opts["zones"]
        have = sum(1 for zone in zones if summary[zone]["has_data"])
        total = len(zones)
        status = "complete" if have == total else ("partial" if have else "pending")
        auctions.append({
            "key": key, "label": opts["label"], "clears": opts["clears"],
            "have": have, "total": total, "status": status,
        })
    return {"date": target_date.isoformat(), "auctions": auctions}
