# power-prices

Dashboard for European day-ahead (and intraday) electricity prices landed by the sibling
[`scrapers`](../scrapers) repo into a single Postgres table, so trading tooling has one place to
query instead of per-source formats. This repo is dashboard-only - it visualizes coverage/price
level; the actual fetch/parse/dump/backfill/completeness-monitoring all live in `scrapers`.

Each bidding zone is covered by at least two independent sources for redundancy, day-ahead is
fully backfilled across all in-scope zones, and four BE-only EPEX intraday endpoints are live as
a test case — see `scrapers`' own README/`project-overview.md` for source-by-source detail.

## Layout

- `core/` - logging, utils; `PriceStore` (`.get()` only from here - dump/retrieve lives in
  `quent_core`)
- `dashboard/` - FastAPI + plain-JS map dashboard showing per-zone coverage and price level
  (see Dashboard below)

This repo has no dependency on `scrapers`' code - per-auction zone lists come from a live
`prod.prices` query (`dashboard/zones.py` `get_market_zones()`, see project-overview.md >
Dashboard) rather than importing `clients`. See the `scrapers` repo itself for `client.py`/
`endpoints/<name>.py` layout, per-source behavior, scraper scheduling, backfill scripts,
data-completeness monitoring, and the DDL for `prod.prices`.

`PriceStore` (from `quent_core.database.price_store`) writes to `prod.prices` only for
now - publishing to `quent-data-stream` (NATS JetStream, stream `PRICES`) moved to
`quent_core` along with the class and is temporarily disabled while that module is
reworked upstream; see `project-overview.md` > Streaming for details. This repo only ever
calls `.get()`, unaffected either way.

## Data

Read-only from here. Target table: `prod.prices`, keyed on
`valuetime, forecasttime, bidding_zone, market_type, market, source, resolution`. See
`project-overview.md` for the full schema and column descriptions (DDL itself now lives in
`scrapers`).

## Dependencies

Poetry-managed (`pyproject.toml`/`poetry.lock`), own independent venv - not
merged into Production's or `scrapers`', and no path dependency on either repo,
see `project-overview.md` > Architecture.

## Dashboard

`dashboard/` is a standalone map dashboard (coverage + price level per
bidding zone), run locally with:

```
poetry run uvicorn dashboard.app:app --reload --port 8000
```

Pinned to port 8000 explicitly rather than left to uvicorn's unstated default.

In production, it runs in Docker on the same internal server as `quent-data-stream`
(`docker-compose.yml`, `Dockerfile`), published on port **8080**. The container has no live AWS
access, so its DB credential (the READ_ONLY_USER role, `ai/db/quent`) is resolved once elsewhere
and mounted in as a Docker secret rather than fetched live like local dev does - see
`project-overview.md` > Docker deployment for the full setup (`scripts/
materialize_runtime_secrets.py`) and redeploy steps.

## Status

Historical backfill to 2024-01-01 is done and verified (day-by-day gap scan,
not just MIN/MAX per zone) for every zone that can reach that far back - see
`scrapers`' `project-overview.md` for per-source floors, current scraper
implementation status, and its own data-completeness monitoring flow. Dashboard
is live in Docker on port 8080 alongside `quent-data-stream`. See
`project-overview.md` for this repo's full scope, architecture, and
iteration/to-do list.
