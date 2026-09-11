"""map dashboard: European bidding zones, colored once an auction's price has landed - covers
day-ahead (SDAC + CH plus GB's/Ireland's own non-SDAC auctions), EPEX's IDA1/IDA2/IDA3 intraday
auctions, and EPEX's ID1/ID3/IDFULL intraday continuous VWAP indices, see MARKET_OPTIONS.

run with: poetry run uvicorn dashboard.app:app --reload --port 8000
"""

import datetime as dt
import mimetypes
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import FileResponse
from starlette.staticfiles import NotModifiedResponse

from dashboard.zones import (
    DELIVERY_DAY_TZ,
    build_auctions_summary,
    build_price_rows,
    build_zone_summary,
    get_market_zones,
)

STATIC_DIR = Path(__file__).resolve().parent / "static"

# one entry per auction the UI can show, grouped into three panel sections - Day-ahead, IDA,
# VWAP (see static/app.js AUCTION_GROUPS, which mirrors this ordering). GB has no single day-ahead
# auction: Nord Pool (N2EX/GbHalfHour) and EPEX each run their own separate hourly/half-hourly GB
# auctions with different gate closures/publish times, confirmed by direct research (not this
# repo's own docs) - so each gets its own row rather than merging two differently-timed real
# auctions under one label.
#
# no "zones" key here anymore - each auction's own covered zones (the completeness denominator
# for the /api/auctions traffic light, and the map's "not applicable" cutoff) come from
# get_market_zones() instead, which queries distinct (market_type, market, bidding_zone) straight
# from prod.prices - not a hardcoded per-auction list (SDAC used to be "all 41 minus GB/IE" by
# exclusion, N2EX/SEM-DA a bare ["GB"]/["IE"], and IDA1/IDA2/IDA3/VWAP borrowed a scraper's own
# ZONE_FILE_CONFIG dict, see git history) - so an auction's actual coverage changing shows up
# without a code change, same reasoning as the imbalance repo's get_scraped_zones().
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
        "label": "SDAC + CH", "clears": "12:55 CET/CEST",
        "clear_at": (-1, dt.time(12, 55)),
    },
    "n2ex": {
        "market_type": "DAY_AHEAD", "market": "N2EX_DayAhead", "default_offset_days": 1,
        "label": "N2EX", "clears": "11:00 CET/CEST",
        "clear_at": (-1, dt.time(11, 0)),
    },
    "epex_gb_hourly": {
        "market_type": "DAY_AHEAD", "market": "Hourly", "default_offset_days": 1,
        "label": "EPEX GB Hourly", "clears": "10:30 CET/CEST",
        "clear_at": (-1, dt.time(10, 30)),
    },
    "gb_hh": {
        "market_type": "DAY_AHEAD", "market": "GbHalfHour_DayAhead", "default_offset_days": 1,
        "label": "GB HalfHourly", "clears": "15:35 CET/CEST",
        "clear_at": (-1, dt.time(15, 35)),
    },
    "epex_gb_hh": {
        "market_type": "DAY_AHEAD", "market": "HalfHourly", "default_offset_days": 1,
        "label": "EPEX GB HalfHourly", "clears": "16:45 CET/CEST",
        "clear_at": (-1, dt.time(16, 45)),
    },
    "sem_da": {
        "market_type": "DAY_AHEAD", "market": "SEM_DA", "default_offset_days": 1,
        "label": "SEM-DA", "clears": "12:55 CET/CEST",
        "clear_at": (-1, dt.time(12, 55)),
    },
    "ida1": {
        "market_type": "INTRADAY", "market": "IDA1", "default_offset_days": 1,
        "label": "IDA1", "clears": "~15:20 CET/CEST (D-1)",
        "clear_at": (-1, dt.time(15, 20)),
    },
    "ida2": {
        "market_type": "INTRADAY", "market": "IDA2", "default_offset_days": 1,
        "label": "IDA2", "clears": "~22:20 CET/CEST (D-1)",
        "clear_at": (-1, dt.time(22, 20)),
    },
    "ida3": {
        "market_type": "INTRADAY", "market": "IDA3", "default_offset_days": 0,
        "label": "IDA3", "clears": "~10:20 CET/CEST (D)",
        "clear_at": (0, dt.time(10, 20)),
    },
    # ID1/ID3/IDFULL are continuous-trading VWAP indices, not auctions - not published until the
    # delivery day's continuous trading has fully closed, so (unlike day-ahead/IDA2) they default
    # to yesterday's delivery day rather than today/tomorrow.
    "id1": {
        "market_type": "INTRADAY", "market": "ID1", "default_offset_days": -1,
        "label": "ID1", "clears": "~01:15 CET/CEST (D+1)",
        "clear_at": (1, dt.time(1, 15)),
    },
    "id3": {
        "market_type": "INTRADAY", "market": "ID3", "default_offset_days": -1,
        "label": "ID3", "clears": "~01:15 CET/CEST (D+1)",
        "clear_at": (1, dt.time(1, 15)),
    },
    "idfull": {
        "market_type": "INTRADAY", "market": "IDFULL", "default_offset_days": -1,
        "label": "IDFULL", "clears": "~01:15 CET/CEST (D+1)",
        "clear_at": (1, dt.time(1, 15)),
    },
    # GB-only continuous VWAP indices (EPEX GB continuous intraday market, per half-hour
    # settlement period) - RPD covers trades up to 4h in duration, RPD HH only half-hour-product
    # trades (confirmed via EPEX's own index definitions, mirrored by Modo Energy's API docs:
    # https://developers.modoenergy.com/reference/epex-intraday-reference-price-eod). EPEX states
    # both are "released on their FTP at the end of the day" with no exact time/timezone
    # published - reusing ID1/ID3/IDFULL's ~01:15 CET/CEST (D+1) estimate, since UK midnight (end
    # of the GB delivery day) converts to ~01:00 CET/CEST, same EPEX-FTP-EOD pattern.
    "rpd": {
        "market_type": "INTRADAY", "market": "RPD", "default_offset_days": -1,
        "label": "GB RPD", "clears": "~01:15 CET/CEST (D+1)",
        "clear_at": (1, dt.time(1, 15)),
    },
    "rpd_hh": {
        "market_type": "INTRADAY", "market": "RPD HH", "default_offset_days": -1,
        "label": "GB RPD HH", "clears": "~01:15 CET/CEST (D+1)",
        "clear_at": (1, dt.time(1, 15)),
    },
}


# markets whose data comes in both 15min and 60min resolution under the same (source, market)
# key - see zones.py's build_zone_summary docstring on why that needs a resolution filter, and
# static/app.js's resolution toggle, only shown for these three.
VWAP_MARKETS = {"id1", "id3", "idfull"}


def _zones_for(opts: dict) -> list[str]:
    """this auction's own covered zones, sorted for a deterministic order - see get_market_zones()
    for why this replaced a hardcoded per-auction zone list."""
    return sorted(get_market_zones().get((opts["market_type"], opts["market"]), set()))


# SDAC clears ~12:55 CET/CEST (see MARKET_OPTIONS) - before this switch time tomorrow's auction
# hasn't cleared yet, so today is the more useful default; only matters for the page's initial
# load (main() in app.js fetches /api/prices with no date at all) since every later load passes
# an explicit date through instead of relying on this default (see app.js's comment above its
# selectView call).
SDAC_DEFAULT_SWITCH_TIME = dt.time(12, 50)


class CachedStaticFiles(StaticFiles):
    """StaticFiles with a fixed Cache-Control header - how aggressively a given mount can be
    cached depends entirely on how often its files actually change (see mounts below).

    Also serves a precomputed `.gz` sibling directly when the client accepts gzip and one exists
    (see build_geo.py's `_write_geojson`) - the geo files are large enough (multi-MB) that
    GZipMiddleware recompressing them from scratch on every single request is real, avoidable
    CPU cost when the content only changes on an occasional manual rebuild."""

    def __init__(self, *args, cache_control: str, **kwargs):
        super().__init__(*args, **kwargs)
        self._cache_control = cache_control

    def file_response(self, full_path, stat_result, scope, status_code: int = 200):
        request_headers = Headers(scope=scope)
        gz_path = Path(f"{full_path}.gz")
        if "gzip" in request_headers.get("accept-encoding", "") and gz_path.is_file():
            media_type = mimetypes.guess_type(str(full_path))[0] or "application/octet-stream"
            response = FileResponse(gz_path, status_code=status_code, stat_result=gz_path.stat(), media_type=media_type)
            response.headers["Content-Encoding"] = "gzip"
            if self.is_not_modified(response.headers, request_headers):
                response = NotModifiedResponse(response.headers)
        else:
            response = super().file_response(full_path, stat_result, scope, status_code=status_code)
        response.headers["Cache-Control"] = self._cache_control
        response.headers.setdefault("Vary", "Accept-Encoding")
        return response


app = FastAPI(title="PRICES")
app.add_middleware(GZipMiddleware, minimum_size=500)

# most specific mounts first - Starlette matches in registration order, so /static/geo and
# /static/vendor need to be checked before the catch-all /static mount below.
# max-age=1 week (was 1 hour) - these are hand-committed build artifacts (see build_geo.py's
# module docstring: "run manually... whenever upstream shapes are updated"), not something that
# changes on a normal deploy, so an hour of freshness was needlessly forcing a multi-MB re-fetch
# on every dashboard session past that window. Deliberately not `immutable` - the file can still
# change in place on a rebuild without a URL/version bump, and this project has already been
# burned once by a too-aggressive stale-cache assumption (see the /static mount's own comment).
app.mount(
    "/static/geo",
    CachedStaticFiles(directory=STATIC_DIR / "geo", cache_control="public, max-age=604800"),
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
def index() -> HTMLResponse:
    """serves index.html with a `?v=<mtime>` cache-busting query param on app.js/style.css -
    those files are already served no-cache (see the /static mount above), but relying on
    revalidation alone has already gone stale on a live browser tab once (see that mount's own
    comment) - a changed file now gets a new URL too, which no caching layer can serve stale."""
    html = (STATIC_DIR / "index.html").read_text()
    for asset in ("app.js", "style.css"):
        version = int((STATIC_DIR / asset).stat().st_mtime)
        html = html.replace(f'/static/{asset}"', f'/static/{asset}?v={version}"')
    response = HTMLResponse(html)
    response.headers["Cache-Control"] = "no-cache"
    return response


def _is_cleared(target_date: dt.date, opts: dict) -> bool:
    """whether this market's own clearing time (see MARKET_OPTIONS' clear_at) has already
    passed for target_date - i.e. whether a missing zone here is a real gap worth flagging
    rather than just not-published-yet."""
    now = dt.datetime.now(DELIVERY_DAY_TZ)
    day_offset, clear_time = opts["clear_at"]
    return now >= DELIVERY_DAY_TZ.localize(dt.datetime.combine(target_date + dt.timedelta(days=day_offset), clear_time))


@app.get("/api/prices")
def get_prices(date: str | None = None, market: str = "sdac", resolution: int | None = None) -> dict:
    """price summary per in-scope bidding zone for one market view (see MARKET_OPTIONS).
    `date` is the delivery day (YYYY-MM-DD); defaults to that market's own natural default -
    IDA2 always tomorrow (D-1 clearing pattern, see MARKET_OPTIONS), SDAC time-aware instead
    (today before SDAC_DEFAULT_SWITCH_TIME CET/CEST, tomorrow after - see that constant).

    `resolution` (15 or 60) only applies to VWAP_MARKETS, which scrape both resolutions under the
    same market label (see zones.py's build_zone_summary) - defaults to 15min there, ignored
    entirely for every other market so a stray value can't accidentally filter out data that was
    never resolution-ambiguous in the first place.

    `cleared` tells the map's coverage view whether this market's clearing time has already
    passed for `date` - a missing zone only reads as a real gap (red) once true; before that
    it's just not published yet (neutral), see static/app.js's coverageZoneStyle.

    `market_zones` is this market's own covered-zones list from get_market_zones() (e.g. just GB
    for N2EX, ~39 zones for SDAC) - `zones` itself still covers all 41 IN_SCOPE_ZONES so the map
    doesn't need a second fetch when switching views, but the frontend needs to know which of
    those 41 this market could ever cover, so a zone outside that list (e.g. GB/IE under SDAC)
    reads as "not applicable" rather than "no data yet"/a real gap, see static/app.js's
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
    resolution_minutes = (resolution or 15) if market in VWAP_MARKETS else None
    zones = build_zone_summary(
        target_date, market_type=opts["market_type"], market=opts["market"], resolution_minutes=resolution_minutes
    )
    return {
        "date": target_date.isoformat(), "market": market, "cleared": _is_cleared(target_date, opts),
        "zones": zones, "market_zones": _zones_for(opts), "resolution": resolution_minutes,
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
    zones_with_data = build_auctions_summary(target_date)
    auctions = []
    for key, opts in MARKET_OPTIONS.items():
        zones = _zones_for(opts)
        have_zones = zones_with_data.get((opts["market_type"], opts["market"]), set())
        have = sum(1 for zone in zones if zone in have_zones)
        total = len(zones)
        cleared = _is_cleared(target_date, opts)
        if total and have == total:
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


@app.get("/api/download")
def download_prices(date: str, markets: str) -> Response:
    """CSV export of raw per-period price rows for one delivery day across one or more selected
    auctions (see MARKET_OPTIONS) - triggered by the header's download button (static/app.js
    downloadSelectedPrices). Deliberately auction-only, no bidding-zone filter - selecting zones
    too was considered and dropped as too fiddly for the gain.

    `markets` is a comma-separated list of MARKET_OPTIONS keys. Rows are exactly what landed
    (bidding_zone, source, valuetime), not the map's own per-zone baseload average/curve.
    """
    target_date = dt.date.fromisoformat(date)
    keys = [key for key in markets.split(",") if key in MARKET_OPTIONS]
    if not keys:
        raise HTTPException(400, "no valid markets selected")

    frames = []
    for key in keys:
        opts = MARKET_OPTIONS[key]
        df = build_price_rows(target_date, opts["market_type"], opts["market"])
        if df.empty:
            continue
        df["auction"] = opts["label"]
        frames.append(df)
    if not frames:
        raise HTTPException(404, "no data for the selected auctions/date")

    combined = pd.concat(frames, ignore_index=True)
    combined["local_time"] = combined["valuetime"].dt.tz_convert(DELIVERY_DAY_TZ).dt.strftime("%H:%M")
    combined["valuetime_utc"] = combined["valuetime"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    combined = combined.sort_values(["auction", "bidding_zone", "valuetime"])
    out = combined[["auction", "bidding_zone", "source", "local_time", "valuetime_utc", "price", "currency", "resolution"]]

    csv_bytes = out.to_csv(index=False).encode("utf-8")
    filename = f"prices_{target_date.isoformat()}.csv"
    return Response(
        content=csv_bytes, media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
