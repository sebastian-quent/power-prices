# power-prices

Scrapers that collect European day-ahead electricity prices from multiple
sources and land them in a single, consistent Postgres table, so trading
tooling has one place to query instead of per-source formats.

Each bidding zone is covered by at least two independent sources for
redundancy. Day-ahead is the main scope, fully backfilled and covering all
in-scope zones; intraday is early - two BE-only EPEX prototypes exist
(`ida2.py` for the IDA2 auction, `vwap.py` for ID1/ID3/IDFULL VWAPs) ahead of
being extended to other zones/sources or Prefect-deployed.

## Layout

- `core/` - logging, utils; `PriceStore` (dump/retrieve) now lives in `quent_core`
- `clients/<source>/client.py` - auth + generic request function for that source
- `clients/<source>/endpoints/<name>.py` - fetch, parse, dump, `@flow`-decorated `run()`
- `monitoring/` - `day_ahead_completeness.py` (Prefect flow, zone-level data-completeness
  check, separate from flow health); `zone_map/` - FastAPI + plain-JS map dashboard showing
  per-zone coverage and price level (see Dashboard below)
- `db/migrations/` - DDL for `prod.prices`
- `scripts/` - one-off backfill/verification drivers, not scheduled

`PriceStore` (from `quent_core.database.price_store`) writes to `prod.prices` only for
now - publishing to `quent-data-stream` (NATS JetStream, stream `PRICES`) moved to
`quent_core` along with the class and is temporarily disabled while that module is
reworked upstream; see `project-overview.md` > Streaming for details.

## Sources

Live and landing rows in `prod.prices`:

- **Nordpool** - all zones except GB's batch call, plus a separate GB endpoint (`N2EX_DayAhead` + `GbHalfHour_DayAhead`); free API only serves a rolling ~2-month history
- **EPEX** - 20 zones incl. GB and DK2
- **ENTSO-E** - 34 of 35 zones (GB excluded, see `project-overview.md`)
- **OTE** (Czech Republic) - CZ, SOAP/zeep
- **SEMO** (Ireland) - IE
- **OPCOM** (Romania) - RO
- **OMIE** (Spain/Portugal) - ES, PT (joint MIBEL auction)
- **ENEX** (Greece) - GR
- **OKTE** (Slovakia) - SK

Not started: CROPEX (HR), HUPX (HU), GME (IT), BSP Southpool (SI) - all gated
behind paid access, see `project-overview.md`.

31 of 35 in-scope zones have ≥2 live sources. HR, HU and SI are still on a
single source (their local scraper isn't built yet); IT also has just one
(ENTSO-E, split into 7 bidding-zone rows - GME would be its second, not built).

**Intraday** (BE only, prototypes, not yet Prefect-deployed):

- **EPEX IDA2** (`clients/epex/endpoints/ida2.py`) - Pan-European IDA2 auction
- **EPEX VWAP** (`clients/epex/endpoints/vwap.py`) - ID1/ID3/IDFULL continuous
  VWAP indices, backfilled to 2024-01-01

## Data

Target table: `prod.prices`, keyed on
`valuetime, forecasttime, bidding_zone, market_type, market, source`. See
`project-overview.md` for the full schema and column descriptions.

## Dependencies

Poetry-managed (`pyproject.toml`/`poetry.lock`), own independent venv - not
merged into Production's, see `project-overview.md`.

## Dashboard

`monitoring/zone_map/` is a standalone map dashboard (coverage + price level per
bidding zone), run locally with:

```
poetry run uvicorn monitoring.zone_map.app:app --reload
```

## Status

Historical backfill to 2024-01-01 is done and verified (day-by-day gap scan,
not just MIN/MAX per zone) for every zone that can reach that far back;
Nordpool, OTE, SEMO and ENEX are floor-limited by source-side retention
windows instead. No Prefect deployment/schedule is wired up yet - see
`project-overview.md` for full scope, architecture, current implementation
status per zone, and the iteration/to-do list.
