# Power Prices — Dashboard

Dashboard for European day-ahead (and intraday) electricity prices stored in `prod.prices`.
That's the whole job of this repo - visualizing coverage and price level.

## Scope

- In scope (this repo): the `dashboard` visualizing coverage/price level. Nothing else.
- Out of scope (lives in the sibling `scrapers` repo): fetching, parsing, dumping, backfilling,
  data-completeness monitoring, and Prefect-scheduling for any price source. Each bidding zone is
  expected to have at least two independent sources there, so the dashboard's "coverage" view is
  meaningful (one source down shouldn't mean a zone goes dark).

## Architecture

- `core/` — shared library: `PriceStore` (`.get()` only from here) re-exported from
  `quent_core.database.price_store`, `setup_logging()`, and `get_engine()` (`core/db.py`).
  `get_engine()` is two paths: `quent_core.database.db_connect.get_engine_quent()` (live AWS
  Secrets Manager lookup) when there's real AWS access, or a plain `create_engine()` built from
  `DB_HOST`/`DB_USER`/`DB_PASSWORD_FILE` when there isn't (the Docker deployment - see below).
- `dashboard/` — FastAPI + plain-JS map dashboard, port 8000 locally (pinned explicitly, not
  uvicorn's default), 8080 in Docker.
- Poetry-managed (`pyproject.toml`/`poetry.lock`), own independent `.venv`, no path dependency on
  another repo. `quent_core` pinned to `v1.0.165`.

## Streaming (quent-data-stream)

Publishing to `quent-data-stream` is **not currently active** — `quent_core`'s streaming module
is mid-rework. `PriceStore` here is dump/retrieve only; this repo only ever calls `.get()`,
unaffected either way.

## Data model

Table: **`prod.prices`**. DDL lives in `scrapers`' `db/migrations/`; this doc stays the canonical
schema reference since `dashboard/` here is the heavier reader of the semantics below.

| Column       | Type              | PK  | Not Null | Description                                               |
| ------------ | ----------------- | :-: | :------: | ----------------------------------------------------------- |
| valuetime    | `timestamptz`     |  ✓  |    ✓     | Start of delivery period (UTC)                              |
| forecasttime | `timestamptz`     |  ✓  |    ✓     | Timestamp when the data was scraped (UTC)                   |
| bidding_zone | `varchar(20)`     |  ✓  |    ✓     | Delivery area (DE, DK1, NO2, GB, ...)                        |
| market_type  | `varchar(20)`     |  ✓  |    ✓     | Coarse bucket: `DAY_AHEAD` or `INTRADAY`                     |
| market       | `varchar(20)`     |  ✓  |    ✓     | The actual price series identity (see below)                |
| source       | `varchar(20)`     |  ✓  |    ✓     | Data source (`EPEX`, `NORDPOOL`, `ENTSOE`, `EXAA`, ...)     |
| resolution   | `smallint`        |  ✓  |    ✓     | Delivery resolution in minutes (`60`, `30`, `15`)            |
| currency     | `varchar(10)`     |     |    ✓     | Native currency (`EUR`, `GBP`, `CHF`, `NOK`, ...)            |
| price        | `numeric(10,2)`   |     |    ✓     | Market clearing price / VWAP                                |

**`market_type` vs `market`**: `market_type` is a coarse filter, `market` is what actually
disambiguates. `DAY_AHEAD` doesn't always mean SDAC — GB isn't part of SDAC at all, and AT has
both SDAC and EXAA's early auction for the same delivery day. `market` covers auction codes
(`SDAC`, `EXAA_EARLY`, `IDA1-3`) and intraday VWAP series (`ID1`, `ID3`, `FULL`) as open text, no
enum. A normalized FK-based design is sketched in `id-tables-design.drawio` if this ever becomes
a real problem (see Open items).

**Resolution**: most zones have moved to 15-minute settlement, some are still 30 or 60. Read per
API response, never hardcoded per zone, since a zone can change resolution over time. It's part
of the row's key (not just a value column) - a 60-min row's `valuetime` always equals its hour's
first 15-min row for the same zone/market/source, so different resolutions must stay distinct
keys or they'd collide.

`PriceStore.get()` collapses to the latest `forecasttime` per full key, so consumers get the
current price curve, not every scrape snapshot. `PriceStore.dump()` is append-only, not upsert —
it inserts a new row (new `forecasttime`) only when the price actually changed for that key;
unchanged rescrapes are skipped. `forecasttime` therefore means "when this price last changed",
not "when we last checked".

## Dashboard

`dashboard/` — FastAPI + plain-JS map, not Streamlit, showing coverage and price level
geographically. Day picker (prev/next + native date input). Each of the 41 `IN_SCOPE_ZONES` is
drawn as its real bidding-zone shape (NO1-5, SE1-4, DK1/DK2, Italy's 7 sub-zones each their own
polygon). Default view is zone code + price; hover for per-source completeness and a price curve.

Standing design decisions worth knowing before changing this:

- **An auction's covered zones come from a live query, not a hardcoded list**:
  `dashboard/zones.py`'s `get_market_zones()` (`SELECT DISTINCT market_type, market, bidding_zone
  FROM prod.prices`, cached 24h) drives both the map camera (which zones an auction switch flies
  to) and the "not applicable" styling. So a new source/auction landing data shows up without a
  code change.
- **Fill color is price-intensity, not just "has data"**: a per-day muted green→amber→red scale,
  normalized against that day's own min/max (day-ahead levels swing too much day-to-day for a
  fixed scale). Only EUR-priced zones feed this scale — every SDAC/SEM-DA zone lands in EUR
  *including* CH and the Nordics (their auction clears in EUR even though NOK/CHF is the local
  retail currency); only GB (N2EX/GbHalfHour) lands in GBP. Non-EUR zones get a distinct muted
  fill instead of being mixed into the EUR scale, since there's no FX conversion anywhere in this
  project.
- **Two "no data" categories, not three**: "pending" (in scope, this auction, just not landed
  yet) vs. "not applicable" (never in scope, or out of scope for this particular auction) — both
  share one grey (`notApplicableStyle()`/`--context-fill`), since a third distinct tier couldn't
  clear the `dataviz` skill's contrast floor once actually composited over the map background.
  Not-applicable zones also get no code/price label at all, not just a recessive fill.
- **Data colors are kept visually separate from the brand color** (`--brand: #77bd46`) even
  though both are green — brand green is reserved for decorative accents (header icon, selection
  rings), never a data fill, so a data value can't be mistaken for "the brand color."
- Manual light/dark toggle (`#theme-toggle`), defaults to OS `prefers-color-scheme`, explicit
  choice persisted to `localStorage` and stamped as `data-theme` on `<html>`. `style.css`'s dark
  tokens must stay declared in both the media-query block and the explicit-override block —
  update both if this palette changes.
- Header holds exactly four selector/action pills (Prices/Coverage, CET/UTC, Light/Dark,
  download), all sharing the same `.view-toggle` pill chrome. The scale legend lives in a
  floating `.map-scale-panel` over the map instead, not the header.
- **CET/UTC toggle affects labels only, not the underlying data**: `zones.py`'s curve points
  carry both `time` (Copenhagen) and `time_utc`; the "now" marker always uses the Copenhagen
  field regardless of the toggle, since UTC labels for a Copenhagen calendar day wrap around UTC
  midnight (non-monotonic), which would break its position calculation.
- **Day-ahead auction labeled "SDAC + CH"**: Switzerland isn't an actual SDAC member (coupled at
  the border, not run through SDAC's own algorithm) — display-only distinction, doesn't touch the
  underlying `market="SDAC"` DB value.
- `zones.py` groups by `(source, bidding_zone, market)` before averaging into one headline
  "baseload" price per zone — avoids a naive row-mean letting GB's half-hourly market (2x the row
  count of its hourly market) skew the number shown on the map.
- **"Expected" row counts differ for half-day markets**: IDA3 (all zones) and GB/CH's own local
  IDA2 products only ever cover periods from local noon onward (12h, not 24h) — their coverage
  bars/map tiles would otherwise never be able to reach 100%. `zones.py`'s `_expected_periods()`/
  `_HALF_DAY_MARKETS`/`_HALF_DAY_MARKET_ZONES` special-case just these; every other market/zone
  assumes a full delivery day. Worth checking before adding a new intraday product.
- **No caching, client or server side, on the per-day query path** (`zones.py`'s
  `_get_day_rows()`, shared by all three read endpoints): a rescrape can insert a new row for an
  already-published day at any time (see dedup/rescrape strategy above), and for a trading tool a
  changed price silently not showing up because of a cache window is worse than the cost of a
  live per-request query. Don't add one without re-litigating this.
- `static/app.js`'s `loadPrices()`/`loadAuctions()` stamp a monotonically increasing request id
  and discard their own response if a newer call has since started — needed because rapid
  date/market switching fires overlapping requests with no guaranteed resolution order.
- Zone/context polygons are pre-built static files (`static/geo/*.geojson`), not fetched live —
  `build_geo.py` (run manually, not by the app) combines `entsoe-py`'s per-bidding-zone shapes
  with Natural Earth's country outlines for GB/IE and the context layer, clipped to the real
  coastline and simplified/gzipped for payload size. Re-run only if upstream shapes change.
- Leaflet is vendored locally (`static/vendor/leaflet/`), not CDN'd, so the page has no runtime
  internet dependency.
- `static/geo/grid.geojson` (transmission lines, decorative background layer) is sourced from
  GridKit/OpenStreetMap under ODbL 1.0, which technically requires attribution — omitted only on
  the basis that this dashboard is internal-only; revisit if it's ever exposed outside the team.
- CSV download (header button) hits `/api/download`, pulling every raw `(bidding_zone, source,
  valuetime)` row via `zones.py`'s `build_price_rows()` — not the map's own per-zone average —
  auction-only, no bidding-zone filter.

## Docker deployment

Deployed on the same internal server as `quent-data-stream`, one instance (no dev/prod split).
Published on host port **8080** (confirmed free via `netsh`/`netstat` on the server), mapped to
the container's internal port 8000.

- `Dockerfile` — `python:3.12-slim`, `poetry install --only main`, copies `core/` + `dashboard/`.
  Installs `gcc`/`libpq-dev` at build time since `psycopg2` (not `-binary`) compiles from source.
- **The docker host has no live AWS access** (no EC2 instance profile, no configured AWS CLI
  credentials — confirmed directly on the server). So the engine can't resolve a DB secret live
  via `quent_core`'s `SecretsManagerClient` the way local dev does.
- Fix: `scripts/materialize_runtime_secrets.py` resolves the READ_ONLY_USER secret (`ai/db/quent`)
  *once*, wherever real AWS access exists (a dev machine, not the docker host), and writes only
  the password to `.runtime/db/password` — mounted into the container as a Docker secret. Uses
  the scoped read-only role rather than the shared `prod/db/quent` credential local dev's
  `get_engine_quent()` uses, since this dashboard only ever does `SELECT`s — narrower blast radius
  for a credential that sits in a container. `host`/`user` aren't secret; the script prints them
  to set once as plain `DB_HOST`/`DB_USER` in the server's `.env` (see `.env.example`).
- `core/db.py`'s `get_engine()` is the one narrow exception to "don't build a new DSN loader" —
  it still calls `get_engine_quent()` unchanged for local dev, and only falls back to a plain
  `create_engine()` when `DB_PASSWORD_FILE` is set (i.e. only inside the container).
- Healthcheck hits `/` (needs no DB call, so it's a cheap and already-existing target).
- Redeploy: run the materialize script, copy `.runtime/db/password` to the server if the
  credential ever changes, then `docker compose up --build -d`.

## Testing

No tests currently live in this repo.

## Open items

- Market code reference/lookup table — only if free-text `market` values start causing problems;
  `id-tables-design.drawio` sketches an FK-based alternative (see Data model).
- Day-ahead volumes alongside prices — needs a schema decision (extend `prod.prices` vs. separate
  table); currently out of scope.
- Re-enable publishing to `quent-data-stream` once `quent_core`'s streaming rework lands — expected
  as a small add-on to `PriceStore`, not a rebuild.
- `get_market_zones()`'s unfiltered `SELECT DISTINCT` is a full seq scan (~5s against the live
  10M-row table) — harmless today since it sits behind its own 24h cache, but if that stops being
  enough, the fix is a covering index on `(market_type, market, bidding_zone)` or a materialized
  view on the same cadence, not a plain SQL view (Postgres inlines those, so no plan change).
- `core/logging.py`'s `setup_logging()` and `_day_bounds_utc()`/`IN_SCOPE_ZONES` are duplicated
  across a few files in this repo rather than centralized — deliberate for now, revisit only if
  that causes a real problem.
