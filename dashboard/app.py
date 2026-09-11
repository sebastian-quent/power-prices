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

# one entry per auction the UI can show (see static/app.js AUCTION_GROUPS for panel grouping).
# GB has no single day-ahead auction - Nord Pool and EPEX each run their own, so each gets its
# own row. Covered zones come from get_market_zones() (live query), not a key here, so an
# auction's actual coverage can change with no code change. `clears` is the display string
# (`~` = estimate, not a firm published deadline); `clear_at` is the same time as
# (day_offset, wall-clock) for get_auctions()'s "late" vs "pending" check - keep both in sync.
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
    # GB-only continuous VWAP indices - RPD covers trades up to 4h, RPD HH only half-hour-product
    # trades. No exact publish time is stated; reuses the ID1/ID3/IDFULL ~01:15 CET/CEST estimate.
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
    """this auction's own covered zones, sorted for a deterministic order."""
    return sorted(get_market_zones().get((opts["market_type"], opts["market"]), set()))


# before SDAC's ~12:55 clearing time, today is the more useful default than tomorrow.
SDAC_DEFAULT_SWITCH_TIME = dt.time(12, 50)


class CachedStaticFiles(StaticFiles):
    """StaticFiles with a fixed Cache-Control header, and serves a precomputed `.gz` sibling
    directly when the client accepts gzip (see build_geo.py's `_write_geojson`), avoiding
    per-request recompression of these multi-MB files."""

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

# most specific mounts first - Starlette matches in registration order.
# geo files are hand-committed build artifacts (build_geo.py), so a week-long cache is safe;
# not `immutable` since a rebuild can change them in place with no URL bump.
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
# no-cache = always revalidate, not "don't cache" - these files change during development.
app.mount("/static", CachedStaticFiles(directory=STATIC_DIR, cache_control="no-cache"), name="static")


@app.get("/")
def index() -> HTMLResponse:
    """serves index.html with a `?v=<mtime>` cache-busting query param on app.js/style.css, so
    a changed file gets a new URL too rather than relying on revalidation alone."""
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
    `date` defaults to the market's own natural default day if omitted. `resolution` (15/60)
    only applies to VWAP_MARKETS. `cleared` tells the map whether a missing zone is a real gap
    (clearing time passed) vs. just not published yet. `market_zones` is this market's own
    covered zones, distinct from the full 41-zone `zones` list, so the frontend can style a zone
    outside it as "not applicable" rather than "no data yet"."""
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
    """status per auction (see MARKET_OPTIONS) for one shared delivery day - the date the map is
    currently showing, not each auction's own default. Defaults to today if no date is given.

    status is "complete" once every zone the auction covers has data, "partial" if some do,
    "late" if none do and the clearing time has passed, else "pending"."""
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
    auctions. `markets` is a comma-separated list of MARKET_OPTIONS keys, auction-only (no
    bidding-zone filter)."""
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
