# power-prices

See @project-overview.md for scope, architecture, and iteration plan.

## Docs
- README.md is scoped to the dashboard app only - what it is, the live URL, how to run it locally, how it's deployed. Not a summary of project-overview.md's data model/pipeline/scope content - that stays in project-overview.md only, linked from README's closing line. Whenever project-overview.md's dashboard-facing content changes (deploy details, run command, live status), update README.md in the same edit if it affects what README covers - don't let those drift.

## Layout
This repo is dashboard-only - fetching, dumping, backfilling, data-completeness monitoring,
and the DDL for the table it reads all live in the sibling `scrapers` repo. Nothing
scraping-related belongs back in this repo.
- core/ - logging, utils; PriceStore (dump/retrieve, `.get()` only from here) re-exported from quent_core.database.price_store (no publish/streaming yet, see project-overview.md > Streaming)
- dashboard/ - FastAPI + plain-JS map dashboard (port 8000, pinned explicitly rather than left to uvicorn's default) - see project-overview.md > Dashboard

## Environment
- Poetry-managed, own `.venv` - always `poetry run ...` (or activate `.venv`), never a bare/global `python` (root cause of a past incident: global interpreter had a stale, unpinned `quent_core` shadowing the pinned git rev).

## Data
Read-only from here - `scrapers` owns writing to this table (dump, backfill, DDL); this repo only ever calls `PriceStore.get()`.
- table: prod.prices
- PK: valuetime, forecasttime, bidding_zone, market_type, market, source, resolution
- engine: `core.get_engine()` (`core/db.py`) - `quent_core.database.db_connect.get_engine_quent()` under the hood (same shared engine as ImbalancePriceHandler, do not build a new DSN loader), with one narrow Docker-only fallback to a plain `create_engine()` from `DB_HOST`/`DB_USER`/`DB_PASSWORD_FILE` when there's no live AWS access - see project-overview.md > Docker deployment
- market_type: coarse bucket only (DAY_AHEAD / INTRADAY)
- market: actual price series identity (SDAC, EXAA_EARLY, IDA1, ID1, ID3, FULL, ...) - free text, no enum validation
- resolution: read per API response, never hardcode per zone
- timestamps: UTC only, tz-aware (stored that way by whatever wrote the row)

<!-- add a rule here only after Claude gets something wrong twice, not speculatively -->
