# European Day-Ahead Price Scrapers

## Goal

Scrape day-ahead (and later intraday) electricity prices for most European bidding zones into a single Postgres table, replacing ad-hoc queries from dashboards and algorithms.

Redundancy requirement: at least **two independent sources per bidding zone**, so a single source outage doesn't create a data gap. This is about having a working fallback available, not running every source on an identical real-time schedule — day-to-day, a single primary source landing data per zone is sufficient; secondary sources are backup for when the primary is down (see Scheduling). This requirement is about live operation, not backfill.

## Scope

- In scope: day-ahead auction prices (`DAY_AHEAD`), all bidding zones listed below, historical backfill (2024-01-01 onward — see Historical backfill), Prefect-scheduled runs with logging.
- Later, not now: intraday (`INTRADAY`) scrapers, extended zone-by-zone rather than all at once. Four BE-only endpoints are live ahead of the rest (test case), all Prefect-deployed: `clients/epex/endpoints/ida1.py`/`ida2.py`/`ida3.py` scrape EPEX's Pan-European IDA1/IDA2/IDA3 auctions; `clients/epex/endpoints/vwap.py` scrapes EPEX's intraday continuous VWAP indices (`ID1`/`ID3`/`IDFULL`) from the SFTP's per-day current-year files or per-year historical zips. None yet extended to other zones.
- Out of scope: anything not price-related (volumes, nominations, flows, imbalance prices) — stays in existing scraper setups.

## Architecture

- **Monorepo** (for now), not one repo per scraper. A client (e.g. EPEX) can split into its own repo later if it grows enough to justify it.
- `core/` — shared library: DB dump/retrieve (`PriceStore`), logging setup, common utils. Used by every client. Moves to QUENT Core once tested and approved.
- `clients/<source>/` — one folder per data source (nordpool, epex, entsoe, cropex, ote, ...):
  - `client.py` — auth + HTTP request handling only, no parsing.
  - `config.py` — source-specific config/secrets.
  - `endpoints/<endpoint>.py` — fetch, parse, dump per endpoint. Also hosts the `@flow`-decorated `run()`, with backfill exposed via optional `bidding_zones`/date-range params (2026-07-23: `bidding_zones` made consistent across every flow, see below). The per-zone CSV dump that used to run alongside the DB write is commented out (not deleted) in every endpoint, kept available to uncomment for manual debugging/cross-checking.
- **Consistent `bidding_zones` param (multi-zone flows only)**: `fetch_and_parse(bidding_zones, from_date, to_date, ...)` and `run(bidding_zones=None, from_date=None, to_date=None)` share the same shape on **Nordpool's main `run()`, EPEX's main `run()`, ENTSO-E's main `run()`, and OMIE** — the four flows that each cover more than one zone. A subset (e.g. `run(bidding_zones=["NO1"])`) re-runs/backfills just that zone without looping over the rest — the pattern `scripts/backfill_no1_no2_gap.py` already used for EPEX/ENTSO-E, now also on Nordpool and OMIE. `run()`'s default (`bidding_zones=None`) reproduces the flow's normal full zone list, so the live scheduled behavior is unchanged. Nordpool's `deliveryArea`/EPEX's per-zone file/ENTSO-E's per-zone request mean a subset genuinely fetches less; OMIE's joint ES+PT file is still fetched in full regardless, so a subset there only narrows what gets parsed/dumped. Every single-zone flow (OTE, SEMO, OPCOM, OKTE, ENEX, plus Nordpool's/EPEX's/ENTSO-E's separate GB/IE flows) deliberately does **not** carry this param — there's nothing to subset when the flow only ever covers its one zone, so `fetch_and_parse(from_date, to_date)`/`run(from_date=None, to_date=None)` stay as they were.
- **Prefect**: `@flow` sits directly on each endpoint's `run()`. Logs go to Prefect so failures are visible without digging through server logs.
- **Storage**: writes directly to Postgres via `PriceStore` (see Dependencies — now sourced from `quent_core`, not this repo).
- **DB engine**: `from Database.db_connect import engine` — same shared engine as for example `ImbalancePriceHandler`. `PriceStore` takes this as a constructor arg rather than building its own connection.
- **Dependencies**: Poetry-managed (`pyproject.toml`/`poetry.lock`), own independent `.venv` — not merged into Production's. Shared deps pinned to match Production's exactly; `quent_core` is the one deliberate deviation, pinned to `v1.0.161` (Production is on `v1.0.158`) — released as an official tag on 2026-07-28, superseding the earlier `v1.0.161-seb-database-functions` dev-branch pin. `PriceStore` moved out of this repo (`core/price_store.py` deleted) and now lives in `quent_core.database.price_store` — `core/__init__.py` re-exports it from there so every client's `from core import PriceStore` import is unchanged.

## Streaming (quent-data-stream)c

Publishing to `quent-data-stream` is **not currently active** in this repo. The old `core/price_store.py` had a working NATS JetStream publish path (stream `PRICES`, subject `prices.<market_type>.updates`), but it was cut when `PriceStore` moved to `quent_core` — the ported `quent_core.database.price_store.PriceStore` is dump/retrieve only, no publish, since `quent_core`'s own streaming module is mid-rework and too unstable to build against right now (2026-07-23 decision). Ties back to `Goal`'s "how anything consumes it is deliberately not decided yet" — still true, now with no producer either.

- Expected to come back as a `quent_core`-side add-on once that rework lands, requiring only a minimal change here (passing a publish flag/config through, not re-implementing the NATS logic).
- Until then: no `PRICES` stream, no NATS cert/config in this repo (`core/certs/` removed), no `publish=` parameter on `PriceStore`.
- The previous dedup-key design (`_build_msg_id()` building the full natural key `subject:valuetime:bidding_zone:market_type:market:source`, not NATS's `subject:valuetime` default) and the gateway gap (`PRICES` not reachable via `/replay`/`/ws`/`/hybrid`) are notes for whenever publishing returns, not current behavior.

## Data model

Table: **`prod.prices`**.

| Column       | Type              | PK  | Not Null | Description                                               |
| ------------ | ----------------- | :-: | :------: | ----------------------------------------------------------- |
| valuetime    | `timestamptz`     |  ✓  |    ✓     | Start of delivery period (UTC)                              |
| forecasttime | `timestamptz`     |  ✓  |    ✓     | Timestamp when the data was scraped (UTC)                   |
| bidding_zone | `varchar(20)`     |  ✓  |    ✓     | Delivery area (DE, DK1, NO2, GB, ...)                        |
| market_type  | `varchar(20)`     |  ✓  |    ✓     | Coarse bucket: `DAY_AHEAD` or `INTRADAY`                     |
| market       | `varchar(20)`     |  ✓  |    ✓     | The actual price series identity (see below)                |
| source       | `varchar(20)`     |  ✓  |    ✓     | Data source (`EPEX`, `NORDPOOL`, `ENTSOE`, `EXAA`, ...)     |
| resolution   | `smallint`        |     |    ✓     | Delivery resolution in minutes (`60`, `30`, `15`)            |
| currency     | `varchar(10)`     |     |    ✓     | Native currency (`EUR`, `GBP`, `CHF`, `NOK`, ...)            |
| price        | `numeric(10,2)`   |     |    ✓     | Market clearing price / VWAP                                |

`bidding_zone`/`market_type`/`market`/`source` capped at 20 chars, `currency` at 10 — may need extending eventually.

**`market_type` vs `market`**: `market_type` is a coarse filter, `market` is what actually disambiguates. `DAY_AHEAD` doesn't always mean SDAC — GB isn't part of SDAC at all, and AT has both SDAC and EXAA's early auction for the same delivery day. `market` covers auction codes (`SDAC`, `EXAA_EARLY`, `IDA1-3`) and intraday VWAP series (`ID1`, `ID3`, `FULL`) as open text, no enum. A fuller normalized design (`dim_bidding_zone`/`dim_market_type`/`dim_market`/`dim_source` tables with FKs) is sketched in `id-tables-design.drawio`, archived as a future option, not a pending plan — revisit only if bad `market` values actually become a problem.

**Resolution**: most zones have moved to 15-minute settlement, some are still 30 or 60. Stored as plain integer minutes, read per response — never hardcoded per zone, since a zone can change resolution over time.

`PriceStore.get()` collapses to the latest `forecasttime` per `valuetime`/zone/market_type/market/source, so consumers get the current price curve, not every scrape snapshot.

**Dedup / rescrape strategy**: `PriceStore.dump()` is append-only, not upsert — it looks up the latest known price per key (one query per batch, not per row) and inserts a new row (new `forecasttime`) only when the price actually changed; unchanged rescrapes are skipped. `forecasttime` therefore means "when this price last changed", not "when we last checked" — true for both source-native forecasttime (e.g. EPEX file mtime) and `utcnow()` fallback sources alike. Comparison is price-only — resolution/currency changes alone don't trigger a new row. `ON CONFLICT DO NOTHING` on the full PK is kept only as a safety net against exact re-inserts (e.g. a retried failed run), not as the change-detection mechanism.

## Countries / sources / bidding zones

Tracks **implementation status**, not just source availability — ✓ means the zone is wired up and landing rows in `prod.prices` today.

Legend: **✓** implemented and landing data · **○** source could cover this zone but isn't built · **–** not applicable

| Country Code | Country Name   | Nordpool | EPEX | ENTSO-E | Local          | Live sources |
| ------------ | -------------- | :------: | :--: | :-----: | -------------- | :----------: |
| AT           | Austria        | ✓        | ✓    | ✓       | –              | 3            |
| BE           | Belgium        | ✓        | ✓    | ✓       | –              | 3            |
| BG           | Bulgaria       | ✓        | –    | ✓       | –              | 2            |
| HR           | Croatia        | –        | –    | ✓       | ○ CROPEX       | 1            |
| CZ           | Czech Republic | –        | –    | ✓       | ✓ OTE          | 2            |
| DE           | Germany        | ✓        | ✓    | ✓       | –              | 3            |
| DK1          | Denmark (West) | ✓        | ✓    | ✓       | –              | 3            |
| DK2          | Denmark (East) | ✓        | ✓    | ✓       | –              | 3            |
| EE           | Estonia        | ✓        | –    | ✓       | –              | 2            |
| ES           | Spain          | –        | –    | ✓       | ✓ OMIE         | 2            |
| FI           | Finland        | ✓        | ✓    | ✓       | –              | 3            |
| FR           | France         | ✓        | ✓    | ✓       | –              | 3            |
| GR           | Greece         | –        | –    | ✓       | ✓ ENEX         | 2            |
| HU           | Hungary        | –        | –    | ✓       | ○ HUPX         | 1            |
| IE           | Ireland        | –        | –    | ✓       | ✓ SEMO         | 2            |
| IT           | Italy          | –        | –    | ✓       | ○ GME          | 1            |
| LT           | Lithuania      | ✓        | –    | ✓       | –              | 2            |
| LV           | Latvia         | ✓        | –    | ✓       | –              | 2            |
| NL           | Netherlands    | ✓        | ✓    | ✓       | –              | 3            |
| NO1          | Norway 1       | ✓        | ✓    | ✓       | –              | 3            |
| NO2          | Norway 2       | ✓        | ✓    | ✓       | –              | 3            |
| NO3          | Norway 3       | ✓        | ✓    | ✓       | –              | 3            |
| NO4          | Norway 4       | ✓        | ✓    | ✓       | –              | 3            |
| NO5          | Norway 5       | ✓        | ✓    | ✓       | –              | 3            |
| PL           | Poland         | ✓        | ✓    | ✓       | –              | 3            |
| PT           | Portugal       | –        | –    | ✓       | ✓ OMIE         | 2            |
| RO           | Romania        | –        | –    | ✓       | ✓ OPCOM        | 2            |
| SE1          | Sweden 1       | ✓        | ✓    | ✓       | –              | 3            |
| SE2          | Sweden 2       | ✓        | ✓    | ✓       | –              | 3            |
| SE3          | Sweden 3       | ✓        | ✓    | ✓       | –              | 3            |
| SE4          | Sweden 4       | ✓        | ✓    | ✓       | –              | 3            |
| SI           | Slovenia       | –        | –    | ✓       | ○ BSP Southpool| 1            |
| SK           | Slovakia       | –        | –    | ✓       | ✓ OKTE         | 2            |
| CH           | Switzerland    | –        | ✓    | ✓       | –              | 2            |
| GB           | Great Britain  | ✓        | ✓    | –       | –              | 2            |

GB has no ENTSO-E source; Nordpool + EPEX give it 2 live sources. GB isn't reachable via Nordpool's normal SDAC batch call — it runs under two separate Nord Pool markets instead, `N2EX_DayAhead` (hourly) and `GbHalfHour_DayAhead` (half-hourly), both on the same free/unauthenticated API host.

IT has no single ENTSO-E area — ENTSO-E splits it into 7 price sub-zones, landed as 7 separate `bidding_zone` rows (`IT_NORD`, `IT_CNOR`, `IT_CSUD`, `IT_SUD`, `IT_SICI`, `IT_SARD`, `IT_CALA`, using ENTSO-E's own area naming) rather than one `IT` row. The `IT` row above rolls all 7 up for the country-level overview.

31 of 35 country-level zones have ≥2 live sources. HR, HU, SI and IT are the remaining single-source zones — HR/HU/SI's local sources (CROPEX, HUPX, BSP Southpool) and IT's second source (GME) are all gated behind paid/unconfirmed access (see per-source notes below), so none are being actively pursued near-term.

## Sources

One entry per source: how it's implemented, and any source-side behavior that shapes scheduling or backfill reach. All are live and landing rows in `prod.prices` unless marked not started.

**Nordpool** — `clients/nordpool/`. Full 22-zone `BIDDING_ZONE_TO_NORDPOOL_AREA` mapping via `day_ahead.py`; GB handled by a separate `day_ahead_gb.py` (own API call shape) hitting `N2EX_DayAhead` (hourly) + `GbHalfHour_DayAhead` (half-hourly), landed as two `market` rows for `bidding_zone=GB`. Currency read per-response, not hardcoded. Free API only serves a rolling ~2-month window (`401` for older dates) — source-side limit, not a bug; the gated v2 data portal would remove it (blocked on v2 access). That same free API also doesn't serve intraday auctions at all — confirmed (2026-07-31, read-only checks, no DB writes) that IDA1/2/3 (see Scope/Open items) aren't reachable there in any form; Nord Pool's own public IDA price pages are built against the gated Market Data API v2 instead (`data-api.nordpoolgroup.com`, REST paths like `/api/v2/Auction/{market}/BidCurves/ByRegion`, market codes `SIDC_IntradayAuction1/2/3`), so a Nord Pool IDA source needs the same v2 access this rolling-window limitation is already blocked on, not a separate unlock. DST handling reviewed statically only, not yet live-verified (the rolling window won't reach a fall-back transition until 2026-10-24).

**EPEX** — `clients/epex/`. `ZONE_FILE_CONFIG` covers 19 zones (18 SDAC zones + CH) via `run()`, plus GB (hourly + half-hourly) via a separate `run_gb()` so GB's own N2EX-timed schedule doesn't ride along on `run()`'s SDAC-anchored one. `fetch_day_ahead_file()` tries the configured resolution first and falls back to 60 min if that file doesn't exist, needed for zones now configured at 15 min that were hourly before Oct 2025. DST transition handling verified (see cross-check below). SFTP client (`client.py`) bounds the connect with a 30s socket timeout before handing off to `paramiko.Transport`, and skips retrying permanent misses (`FileNotFoundError`) instead of wasting a retry backoff on them.

**ENTSO-E** — `clients/entsoe/`. `BIDDING_ZONE_TO_ENTSOE_AREA` covers 34 of 35 country-level zones (all except GB) — IT is split into its own 7 sub-zones rather than one `IT` entry, so the mapping has 40 dict entries total. `run()` fetches 39 of those (excludes IE); IE fetched separately by `run_ie()` (own SEM-DA-timed schedule) passing `market="SEM_DA"` instead of `run()`'s default `"SDAC"`. DST transition handling correct by construction — `_day_bounds_utc()` derives the number of settlement positions from the actual UTC span, not an assumed 24h. The API throttles under sustained concurrent load (seen during the 2024 historical backfill, running requests 5-zones-concurrently) — if backfill concurrency is used again, treat 5 workers as near the safe ceiling and re-verify per-zone coverage afterward rather than trusting a clean exit code.

**Nordpool + EPEX + ENTSO-E cross-check**: `@flow` on all three's `run()`; ≥2 sources per zone confirmed for all 35 country-level zones (GB was the last gap, closed by Nordpool's GB endpoint + EPEX's GB zone). DST: EPEX's static `Hour 3A`/`Hour 3B` columns disambiguate fall-back via `ambiguous=True/False` and spring-forward hours are null and filtered before conversion (its plain `Hour N` columns use `ambiguous="raise"` with no `nonexistent=` handling, harmless since EPEX always pre-splits ambiguous hours).

**OTE (Czech Republic)** — `clients/ote/`. SOAP via `zeep` (`PublicDataService` WSDL, `GetDamPricePeriodE`), single zone (CZ). Matches ENTSO-E's CZ feed to the cent (confirms EUR — endpoint has no currency field). Data only available from **2025-10-01** (CZ 15-min go-live). Legacy hourly endpoint (`GetDamPriceE`) not wired up, would need its own CZK/EUR + hourly handling.

**SEMO (Ireland)** — `clients/semo/`. Lists/downloads SEMOpx static-reports (`DPuG_ID=EA-001`), filtered to `MarketResult_SEM-DA_*`. Single zone (IE) — only `ROI-DA` parsed (`NI-DA` is byte-identical but out of scope). Averages to ENTSO-E's hourly IE prices, confirming parsing + EUR assumption. Timestamps carry explicit UTC `Z`, so no DST handling needed. SEM-DA is a **D+1 auction** with delivery day on CET/CEST boundaries, not Irish time — `fetch_day_ahead_documents()` queries one day earlier to account for this. The catalog batch-publishes every document at Irish midnight the day *after* its delivery day (per the API's `PublishTime` field) — a full day later than ENTSO-E's IE feed — so `run()` defaults to **yesterday's** delivery day, not tomorrow's, with a cron anchored to that Irish-midnight publish (see Scheduling). Listing retains roughly the last 12 months (~327 days measured) of documents — same rolling-window shape as Nordpool.

**OPCOM (Romania)** — `clients/opcom/`. XML export from opcom.ro's report page, no auth wall beyond a User-Agent check (a static `Mozilla/5.0` header avoids the WAF's default-`python-requests` block). Single zone (RO), no per-row timestamp — `valuetime` derived from 1-based `Pos` vs. the true UTC day span (same approach as ENTSO-E/OTE/OMIE). Dates with no report return HTTP 200 with an empty `<resultset/>`. History goes back to at least 2015-01-01. Delivery-day boundary is CET/CEST, not RO's own EET/EEST — cross-checked against ENTSO-E. Currency hardcoded EUR (no field to read).

**OMIE (Spain / Portugal)** — `clients/omie/`. No API — daily flat files on a Drupal file-browser, one file covers both ES and PT (joint MIBEL auction). `list_files()` scrapes the listing to resolve the current-version filename per date (corrected files get incremented suffixes). Forecasttime from file mtime, resolution derived per-file. ES and PT price columns aren't always identical — diverge during interconnector congestion, so both are parsed as distinct rows. Delivery-day boundary uses `Europe/Madrid` for both zones — cross-checked against ENTSO-E. Pre-2023 history exists as yearly zip archives, not wired up.

**OKTE (Slovakia)** — `clients/okte/`. Public unauthenticated REST API (`isot.okte.sk/api/v1/dam/results`). Single zone (SK). Response timestamps are already full UTC ISO-8601, no local-time boundary math needed. Data available back to 2010. One request accepts a full date range, so `fetch_day_ahead_prices()` does a single bulk call per run, unlike OPCOM/OMIE's per-day loop. Currency hardcoded EUR (no field). Cross-checked against ENTSO-E's SK feed; also confirms SK/CZ/HU/RO clear on the same 4M Market Coupling price.

**ENEX (Greece)** — `clients/enex/`. HEnEx's EL-DAM results xlsx on a Liferay page, no auth wall; targets the "Results" portlet (instance `6eBaUXF5VIb7`), paginated via `_cur=1,2,3,...`. The results sheet repeats each period's MCP once per breakdown row (exports, load, generation mix, ...) — `parse_response` dedupes to one row per `SORT` position, with `valuetime` reconstructed from that 1-based position rather than the ambiguous wall-clock column. Delivery-day boundary is CET/CEST, not Greece's own EET/EEST — cross-checked against ENTSO-E. Currency hardcoded EUR; `forecasttime` uses `utcnow()` fallback (no reliably-timezoned native publish timestamp). Listing retention is a rolling window (~6 weeks measured, reaching back to 2026-06-09), not a fixed floor.

**CROPEX (Croatia)**, **HUPX (Hungary)**, **GME (Italy)** — not started, all gated behind paid or unconfirmed API access. HUPX also bundles BSP Southpool (SI) and SEEPEX (RS, out of scope) — a second SI source would come along with it. All three deprioritized, not being actively pursued near-term.

**BSP Southpool (Slovenia)** — no standalone source; only reachable via the HUPX Labs bundle above.

## Historical backfill

Backfilled to **2024-01-01** wherever a source can reach that far back; only **one** source per zone/day is required for backfill (the ≥2-sources rule is live-operation outage insurance, see Goal). Driven by the one-off `scripts/backfill_2024.py` (not scheduled). No `publish=False` needed anymore — `PriceStore.dump()` doesn't publish anywhere right now (see Streaming).

Verified with `scripts/verify_backfill.py` — a day-by-day gap scan across all 41 in-scope `bidding_zone` codes (not just MIN/MAX per zone, which can miss holes in the middle of an otherwise-normal-looking range). Re-run this after any future bulk backfill rather than trusting a clean exit code or MIN/MAX alone.

**Per-source floor** (can't reach 2024-01-01, source-side limit, not a bug): Nordpool (~2-month rolling window), OTE (floor 2025-10-01, CZ 15-min go-live), SEMO (~327-day rolling retention), ENEX (~6-week rolling window). All four zones are still fully covered back to 2024-01-01 overall via their other live source(s). ENTSO-E, EPEX, OPCOM, OMIE, OKTE all confirmed reaching back to 2024-01-01.

**Resolution change (October 2025)**: many zones moved 60-min → 15-min settlement then, so backfilled 2024 rows are labeled `resolution=60` for those zones, not the current value. ENTSO-E/OPCOM/OMIE/OKTE derive `resolution` dynamically per response, safe by construction; EPEX's historical-resolution fallback (see EPEX above) handles it explicitly.

**EPEX VWAP (2026-07-29)**: `clients/epex/endpoints/vwap.py` backfilled BE to **2024-01-01** (real floor — the SFTP's historical zips reach back that far cleanly, unlike the day-ahead per-source floors above), one-off run, not via `scripts/backfill_2024.py`. Verified day-by-day (same approach as `scripts/verify_backfill.py`, adapted for `INTRADAY`/15-min): 940/940 days present, no partial days, for all three markets (`ID1`, `ID3`, `IDFULL`).

**EPEX IDA1/IDA3 (2026-08-03)**: activated for BE and backfilled, one-off runs, not via `scripts/backfill_2024.py` (same precedent as VWAP). Real floor per market, confirmed by reading the historical annual file directly rather than assuming 2024-01-01 — later than IDA2/VWAP, presumably a later go-live for these two auctions: **IDA1 from 2024-06-15**, **IDA3 from 2024-06-14**, both through 2026-08-02. Verified day-by-day: IDA1 766/779 days present (96 slots/day, except the four 2024/2025/2026 DST-transition Sundays - 100 slots on the 25-hour fall-back days, 92 on the 23-hour spring-forward days, both expected); IDA3 769/780 days present (48 slots/day - Hour 13 Q1 through Hour 24 Q4 only - and no DST-day exceptions, since IDA3's covered range starts after the Hour 3 DST-transition slot). The 13 (IDA1) / 11 (IDA3) missing days are source-side - no auction result published for BE that day - same category as other sources' documented no-result days (e.g. OPCOM's empty-resultset days above), not a scraper defect.

## Scheduling

Deployment scripts prepared in-repo, not yet run against the server (see Open items). Captured here because the grouping/catch-up/redundancy decisions are non-obvious and worth settling before wiring up Prefect deployments.

**Infrastructure (2026-07-27 decision)**: the Prefect server itself is shared with Production/Algos — self-hosted, Postgres-backed, run from `Production/Prefect/` in the sibling `Production` repo (not this one), with existing `prod`/`algos` process-type work pools each executing under that repo's/Algos' own poetry venv. Deliberately **not** reusing `prod`/`algos` for this repo's flows: a process-type work pool executes using whatever Python environment launched its polling worker, so a flow deployed onto `prod`/`algos` would run under Production's/Algos' pinned `quent_core` rev instead of this repo's own (`v1.0.161`, see CLAUDE.md) — the same class of bug as the past global-interpreter incident CLAUDE.md already documents. Instead: a separate `power-prices` work pool, with its own worker process running from this repo's own venv, still against the same shared server (`http://127.0.0.1:4200/api`) — no change to the server, its DB, or the reverse-proxied UI.

Prepared in this repo:
- `Prefect/deploy_flows.py` — registers all 12 day-ahead flows plus the monitoring flow onto the `power-prices` work pool, one `deploy_flow()` call per entrypoint using the cron(s) documented below. Deleting/re-registering is scoped to `work_pool_name == "power-prices"` only, so it can never touch Production/Algos' deployments.
- `Prefect/run_prefect_worker.bat` — starts one worker (`--limit 3`) polling only the `power-prices` pool, `cd`'d into this repo so `poetry run` resolves this repo's own venv, no `PYTHONPATH` sharing with Production/Algos.

Still needed, server-side, on the `Administrator` box that already hosts the shared server (none of this touches the Production repo's own files):
1. Clone this repo there (e.g. `C:\Users\Administrator\Documents\GitHub\power-prices`) and `poetry install`.
2. One-time `poetry run prefect work-pool create power-prices --type process` against the shared server.
3. `poetry run python Prefect/deploy_flows.py` to register the deployments.
4. Start `Prefect/run_prefect_worker.bat`, then wire it to its own new Windows Scheduled Task (separate from whatever launches Production's `run_start_prefect.bat`) so it survives reboots.
5. Optional, deliberately deferred: adding this pool's worker to `Production/monitor_prefect.py`'s watchdog coverage — the one step that would touch a Production file, left as a later decision rather than done by default.

**Granularity**: one Prefect deployment per `@flow`-decorated function. Each flow processes only the zones/markets passed to `fetch_and_parse()` — EPEX and ENTSO-E each expose two flows in the same file (`run()` for SDAC zones, `run_gb()`/`run_ie()` for the one non-SDAC zone), so a schedule can target either without wasting a call on the other's not-yet-published zone. That's 12 flows total for day-ahead: `nordpool`, `nordpool_gb`, `epex.run`, `epex.run_gb`, `entsoe.run`, `entsoe.run_ie`, `ote`, `semo`, `opcom`, `omie`, `okte`, `enex`.

**Timing groups** (anchor = the auction/coupling result the schedule is built around). Exact `cron` expressions live as comments directly above each `@flow` decorator — this section stays the narrative summary. Prefect itself runs in CET/CEST, so every cron is written in that single wall-clock timezone rather than per-source local time, converting UK/Irish local auction times to CET/CEST (currently a flat +1h, since the UK/Ireland and EU both change clocks on the same date — noted per-flow as a DST assumption to revisit if that ever stops holding):
- **SDAC** (~12:55 CET/CEST clearing) — `nordpool`, `epex.run`, `entsoe.run`, `ote`, `opcom`, `okte`, `enex`, `omie`. OTE/OPCOM/OKTE/ENEX/OMIE are assumed to publish on their own portals close to the same SDAC/4M MC clearing time; this isn't independently confirmed per operator, and the catch-up window below is partly there to absorb that uncertainty as well as genuine exchange-side delays.
- **N2EX + GB HalfHourly** (GB, two separate auctions, both earlier than SDAC) — `nordpool_gb`, `epex.run_gb`. N2EX gate closure 09:50 UK = 10:50 CET, results by 10:00 UK = 11:00 CET; HalfHourly gate closure 14:30 UK = 15:30 CET, results shortly after. Both flows fetch *both* GB markets in one call — a single ~2h catch-up window can't cover both clearings 4.5h apart, so each of these two flows needs **two** schedules, not one.
- **SEM-DA** (Ireland, separate auction, earlier than SDAC) — `semo`, `entsoe.run_ie`. Gate closure firm at 11:00 Irish time = 12:00 CET. The two live sources are **not on the same publish timeline** (see SEMO above) and are scheduled differently on purpose:
  - `entsoe.run_ie` — no publish lag beyond ordinary SDAC-style same-day availability. Keeps its `*/15 12-13 CET` gate-closure-anchored cron, defaulting to tomorrow's delivery day.
  - `semo` — publishes a full day later (Irish-midnight batch publish). `run()` defaults to yesterday's delivery day, cron moved to an Irish-midnight-anchored `5,20,35,50 1-2 CET/CEST` catch-up window.

**Catch-up pattern**: start ~5 min after the expected publish time, poll every 15 minutes for up to 2 hours, to absorb minor exchange-side delays without per-operator retry tuning.

**Redundancy vs. cadence**: the ≥2-sources-per-zone requirement (see Goal) is outage insurance, not simultaneous real-time redundancy — it doesn't require every source per zone to run the same aggressive catch-up cadence. Per-zone primary/backup assignment not yet decided.

## Monitoring

A Prefect flow only fails on a code exception — correct for genuine errors, but wrong for a source legitimately returning zero rows for a given delivery day (e.g. SEMO's documented same-day 0-row behavior, see SEMO above). That conflation meant a real gap (a source silently breaking, or a zone losing its last live source) produced no signal at all. Data completeness is checked separately from flow health instead.

- **`monitoring/completeness.py`** — top-level module (sibling to `clients/` and `core/`, cross-cutting ops tooling, not a scraper endpoint). `@flow`-decorated `run(target_date=None)`, defaulting to tomorrow's delivery day. Originally day-ahead only (as `day_ahead_completeness.py`); extended and renamed 2026-07-31 once EPEX IDA2/VWAP were added, since "day-ahead completeness" was no longer an accurate name for what it checks; further extended 2026-08-03 for IDA1/IDA3.
- **Check**: every in-scope bidding zone must have **at least one** `prod.prices` row with `market_type="DAY_AHEAD"` for the target delivery day (zone-level, any live source counts, consistent with the ≥1-source-per-zone redundancy framing) — plus the same idea applied per zone/market for EPEX IDA1, IDA2, IDA3, and VWAP (ID1/ID3/IDFULL), since VWAP's three indices come from one file fetch but aren't guaranteed to all land. Each intraday market's zones/markets are read directly off its own endpoint's `ZONE_FILE_CONFIG`/`INDEX_NAMES`, not duplicated, so the check automatically tracks whatever's actually activated to scrape.
- **In-scope zones**: a static list of every zone from the matrix above with ≥1 live source (35 country-level rows, expanded to 41 `bidding_zone` codes since IT counts as 7 ENTSO-E sub-zones). Hardcoded directly in the script rather than shared via `core/`, since scrapers may split into their own repos later — revisit as a `core/` constant only if that need actually arises. (Day-ahead only — each intraday market's zone list comes from its own endpoint instead, see above.)
- **Delivery-day bounds**: reuses the same `_day_bounds_utc()` pattern (pytz `localize()` + `.astimezone(utc)`) already duplicated across `entsoe`/`opcom`/`enex`, anchored to `Europe/Copenhagen` — the same single CET/CEST anchor every existing scraper uses, including for GB/IE (see the flat +1h DST assumption in Scheduling).
- **Timing**: one shared `0 17 * * *` CET/CEST run covers all five checks, each against its own target delivery day — day-ahead checks `target_date` (tomorrow, after every live source's catch-up window has closed, GB HalfHourly the latest at ~15:30 CET); IDA1 checks `target_date` too (its D-1 gate closure at 15:00 CET already cleared earlier the same afternoon, for tomorrow's delivery); IDA2 and IDA3 both check `target_date - 1` (today) — IDA2 because its gate closes 22:00 CET the evening before delivery, IDA3 because its gate closes ~10:00 CET on delivery day itself, different timing landing on the same date; VWAP checks `target_date - 2` (yesterday, published the morning after delivery). By 17:00 CET each source's own catch-up window for its target day has already closed.
- **Never fails the Prefect run** on missing data — a zone/market with zero rows is logged and alerted, not raised as an exception.
- **Alerting**: `send_alert()` takes all five checks' results together, logs one warning per check that has gaps, and emails a single combined message to `sebastian@quent.dk` via `quent_core.utils.email_utils.send_email()` (AWS SES-backed, already used elsewhere for `info@quent.dk` alerts — no new plumbing needed) — each check's gaps labeled with its own target date so day-ahead/IDA1/IDA2/IDA3/VWAP results (different delivery days) aren't conflated. Deliberately a fixed personal recipient, not a team alias, per explicit request — revisit if this needs to reach more than one person. `send_email()` itself falls back to Teams if SES fails; a failure of *that* fallback too is caught here and logged rather than raised, so a broken alert channel can't fail the Prefect run.
- **Not done yet**: no Prefect deployment/schedule created for this flow (same "design only" status as Scheduling).

**`monitoring/zone_map/`** — standalone FastAPI + plain-JS map dashboard (run with
`poetry run uvicorn monitoring.zone_map.app:app --reload`), not Streamlit — built to show
coverage and price level geographically rather than as a chip/text list. Has its own day picker
(prev/next arrows + a native date input; no longer locked to tomorrow-only). Each of the 41
`IN_SCOPE_ZONES` is drawn as its real bidding-zone shape (not just a country outline — NO1-5,
SE1-4, DK1/DK2, and Italy's 7 sub-zones each get their own polygon). Default view is just the
zone code + price; hover for a card with the per-source completeness breakdown and a price
curve chart, to stay minimal.
- **Fill color is price-intensity, not just "has data"**: zones are colored on a per-day
  green (cheap) → amber → red (expensive) scale, normalized against that day's own min/max
  across zones (not a fixed absolute scale — day-ahead levels swing too much day to day for a
  fixed scale to stay informative). Zones with no data yet are off-white/dashed, clearly
  distinct from "cheap".
- **Currency correctness matters here**: only zones actually priced in EUR feed that scale.
  Checked against real landed data (not assumed from the `currency` column's stated possible
  values) - in practice every SDAC/SEM_DA zone lands in EUR, *including* CH and the Nordics
  (their day-ahead auction clears in EUR even though NOK/CHF is the local retail currency);
  only GB (N2EX/GbHalfHour, not SDAC) actually lands in GBP. Non-EUR zones get a distinct
  muted (not green/amber/red, not the pending off-white) fill instead of being silently mixed
  into the EUR scale, since there's no FX conversion anywhere in this repo (see Data model) and
  comparing raw GBP numbers against EUR ones would misrepresent price level.
- The hover card's curve section is a small hand-rolled inline SVG sparkline (no charting
  library — this repo has no bundler, and Leaflet is already vendored rather than CDN'd for the
  same offline-friendly reason), not a scrollable list of every settlement period - a shape
  reads faster than 96 numbers. Built from whichever `(source, market)` landed the most periods
  that zone/day ("primary", picked per-request - no fixed per-zone source priority exists yet,
  see Scheduling's "not yet decided" note).
- `zones.py` groups by `(source, bidding_zone, market)` first, not straight to
  `(source, bidding_zone)`, for the same GB mixed-resolution reason, then averages those
  per-source averages for one headline "baseload" price per zone — avoids a naive row-mean
  letting GB's half-hourly market (2x the row count of its hourly market) skew the number shown
  on the map.
- `IN_SCOPE_ZONES` and `_day_bounds_utc()` duplicated again — same precedent as
  `completeness.py`.
- Zone/context polygons are pre-built, static files (`static/geo/zones.geojson`,
  `static/geo/context.geojson`), not fetched live — `build_geo.py` is a one-off script (not run
  by the app) that combines `EnergieID/entsoe-py`'s per-bidding-zone shapes (MIT license; no
  GB/IE, matches this repo's own note that GB has no ENTSO-E area) with Natural Earth's
  public-domain admin-0 country outlines for GB/IE and the grey context layer. `context.geojson`
  covers the *whole world*, not just Europe — the map's own `maxBounds`/`minZoom` (in
  `static/app.js`, not the geo build) are what actually keep the camera to a European view;
  clipping the data itself to a Europe bbox was tried first but made the initial view's aspect
  ratio look cut off at the edges (flat empty background where the bbox ended) - real grey
  landmass under a restricted camera looks intentional instead. Re-run the build script only if
  upstream shapes change.
- Leaflet vendored locally under `static/vendor/leaflet/` (BSD-2-Clause) rather than a CDN, so
  the page has no runtime internet dependency.
- **`static/geo/grid.geojson`** — Europe's high-voltage transmission lines, rendered as an
  intentionally faint background layer (easter egg, not meant to be noticed at a glance).
  Source: GridKit (github.com/PyPSA/GridKit), an OpenStreetMap `power=line` extraction published
  on Zenodo under **ODbL 1.0**. Extracted 2016 — stale for anything analytical, fine for a
  decoration since transmission backbone topology doesn't move fast. Each `links.csv` row ships
  its own ready-to-use WKT `LINESTRING`, so `build_grid_geojson()` only parses, no vertex-table
  join needed. ODbL requires attribution for the produced map (not full relicensing) — the
  Leaflet attribution control is re-enabled (styled small/muted, not the stock look) and credits
  all three geo sources (entsoe-py, Natural Earth, OpenStreetMap/GridKit) via each layer's own
  `attribution:` option rather than one hand-built string.

## Open items

- Migrate Nordpool to its gated v2 data portal — the free API's ~2-month rolling window is the main blocker to full backfill parity across all three main sources. v2 access would also unlock a Nord Pool IDA1-3 source (see Sources' Nordpool entry and Intraday scrapers below) — the free API doesn't serve intraday auctions at all, only v2 does.
- Intraday scrapers (IDA1-3 auctions, ID1/ID3/FULL VWAPs) — schema already supports this via `market`. All four BE-only endpoints (`ida1.py`, `ida2.py`, `ida3.py`, `vwap.py`) are now activated and registered in `Prefect/deploy_flows.py` (see Scope, Scheduling, Historical backfill) — still not extended to any other zone, that remains the open part of this item. `ida2.py`'s cron (`5,20,35,50 22-23 * * *` CET/CEST, IDA2 gate closure 22:00 CET/CEST on D-1) and `vwap.py`'s cron (`5,20,35,50 0-3 * * *` CET/CEST, ~4h window anchored just after midnight so `run()`'s "yesterday" default resolves correctly against both the summer same-evening publish and the winter shortly-after-midnight publish) were finalized 2026-07-31. `ida1.py`/`ida3.py` activated 2026-08-03 for BE: live SFTP reads (read-only, no DB writes) confirmed IDA1's gate closure is 15:00 CET/CEST on D-1 (same D-1 timing as IDA2, `run()` defaults to tomorrow, cron `5,20,35,50 15-16 * * *`), and IDA3's gate closure is ~10:00 CET/CEST on delivery day D itself (not D-1 like IDA1/IDA2 - `run()`'s date default was a copy-paste bug defaulting to tomorrow, fixed to today; cron `5,20,35,50 10-11 * * *`). **Measured publish latency (2026-08-04, read-only SFTP `stat`, no DB writes)**: the file lands ~24-33 min *after* gate closure, not within 5 min — IDA1 mtime 15:30 (gate 15:00), IDA2 22:33 (gate 22:00), IDA3 10:24 (gate ~10:00), and VWAP's per-day file ~00:45-00:55 CET/CEST the night after delivery (6/6 consecutive samples). The 2h catch-up crons above already absorb this (their gate+5/gate+20 attempts are simply no-ops), but any *single-shot* schedule must be anchored at roughly gate+45, not gate+5 — the mistake `local_scheduler` originally made. Each IDA mtime is a single observation (the rolling annual file only records its latest append), so treat the exact minute as indicative; VWAP's is the well-sampled one. IDA3 is also a genuine partial-day product by design - its file only carries Hour 13 Q1 through Hour 24 Q4 (48 of 96 quarter-hours/day), the remaining periods after its same-day gate closure. A Nord Pool counterpart to EPEX's IDA endpoints was tried (2026-07-31) but reverted — Nord Pool's free `dataportal-api.nordpoolgroup.com` host doesn't serve IDA1/2/3 at all, only its gated Market Data API v2 does (see Sources' Nordpool entry and the note on the "Migrate Nordpool to its gated v2 data portal" item below), so there was nothing to leave in place as a zones-only prototype the way EPEX's is.
- Market code reference/lookup table — only if free-text `market` values start causing problems; `id-tables-design.drawio` sketches an FK-based alternative (see Data model).
- Day-ahead volumes alongside prices — needs a schema decision (extend `prod.prices` vs. separate table); currently out of scope.
- CROPEX (HR), HUPX (HU), GME (IT), BSP Southpool (SI) — not started, blocked on paid/unconfirmed access (see Sources).
- No Prefect deployment/schedule is live yet for any flow — `Prefect/deploy_flows.py` and `Prefect/run_prefect_worker.bat` are prepared in-repo (see Scheduling), but the `power-prices` work pool hasn't been created on the shared server yet, nothing has been cloned/installed on the `Administrator` box, and no worker or Scheduled Task is running there yet — including for the monitoring flow.
- Re-enable publishing to `quent-data-stream` once `quent_core`'s streaming rework lands (see Streaming) — expected as a small add-on to `quent_core.database.price_store.PriceStore`, not a rebuild.

## Not to forget later

The `PREFECT_LOGGING_EXTRA_LOGGERS` setting (and a `PREFECT_HOME` override) live on the local dev machine's Prefect profile only. Once a work pool/deployment actually gets created, the same env vars need to be set wherever that worker runs (work pool job template or `prefect.yaml`'s `env:` block) — otherwise the worker process won't have them and UI logs will silently go back to being incomplete.
