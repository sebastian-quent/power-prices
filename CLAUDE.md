# day-ahead-prices

See @project-overview.md for scope, architecture, and iteration plan.

## Layout
- core/ - logging, utils; PriceStore (dump/retrieve) re-exported from quent_core.database.price_store (no publish/streaming yet, see project-overview.md > Streaming)
- clients/<source>/client.py - auth + one generic request function reused by every endpoint of that source, no parsing
- clients/<source>/endpoints/<name>.py - fetch, parse, dump, @flow-decorated run()

## Environment
- Poetry-managed, own `.venv` - always `poetry run ...` (or activate `.venv`), never a bare/global `python` (root cause of a past incident: global interpreter had a stale, unpinned `quent_core` shadowing the pinned git rev).

## Data
- table: prod.prices
- PK: valuetime, forecasttime, bidding_zone, market_type, market, source
- engine: `from Database.db_connect import engine` - same shared engine as ImbalancePriceHandler, do not build a new DSN loader
- market_type: coarse bucket only (DAY_AHEAD / INTRADAY)
- market: actual price series identity (SDAC, EXAA_EARLY, IDA1, ID1, ID3, FULL, ...) - free text, no enum validation
- resolution: read per API response, never hardcode per zone
- timestamps: UTC only, tz-aware; reject/log naive timestamps before dump

<!-- add source-specific quirks (auth, rate limits, response shapes) to clients/<source>/CLAUDE.md as each client gets built, not here -->
<!-- add a rule here only after Claude gets something wrong twice, not speculatively -->
