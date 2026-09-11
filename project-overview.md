# Power Prices — Dashboard

Dashboard for European day-ahead (and intraday) electricity prices. Prices land in a single
Postgres table (`prod.prices`) via the sibling `scrapers` repo — scraping, backfilling, and
data-completeness monitoring all live there; this repo only reads and visualizes. `clients`
(per-source scraper code) is installed here as a Poetry path dependency, not local code.

## Goal

Land day-ahead (and later intraday) electricity prices for most European bidding zones into a
single Postgres table (`prod.prices`, see Data model), replacing ad-hoc queries from dashboards
and algorithms - then visualize it, which is this repo's own job.

Redundancy requirement: at least **two independent sources per bidding zone**, so a single
source outage doesn't create a data gap - see `scrapers`' `project-overview.md` for the full
rationale, per-zone status, and its `clients/_monitoring/completeness.py` (what actually surfaces
a broken zone).

## Scope

- In scope (this repo): the `dashboard` visualizing coverage/price level. Nothing else.
- Out of scope (lives in `scrapers`): fetching, parsing, dumping, backfilling,
  data-completeness monitoring, and Prefect-scheduling for any price source.
- Out of scope (either repo): anything not price-related (volumes, nominations, flows,
  imbalance prices) — stays in existing scraper setups.

## Architecture

- `core/` — shared library local to this repo: `PriceStore` (`.get()` only from here) re-exported
  from `quent_core.database.price_store`, plus `setup_logging()` and `get_engine()` (`core/db.py`).
  `dashboard/zones.py` gets its DB `engine` from `core.get_engine()` — no sibling-repo dependency
  (`Production`'s own `Database.db_connect` was the same one-line call, just via a `sys.path` shim
  this repo no longer needs). `get_engine()` itself is two paths: `quent_core.database.db_connect
  .get_engine_quent()` (live AWS Secrets Manager lookup) when there's real AWS access, or a plain
  `create_engine()` built from `DB_HOST`/`DB_USER`/`DB_PASSWORD_FILE` when there isn't — see Docker
  deployment below for why the second path exists.
- `dashboard/` — FastAPI + plain-JS map dashboard showing per-zone coverage and price level (see
  Dashboard below). Run command pins `--port 8000` explicitly rather than relying on uvicorn's
  unstated default.
- **No Prefect**: this repo has no flows, deployments, or work pool - data-completeness
  monitoring lives in `scrapers`' `clients/_monitoring/completeness.py` instead.
- **Dependencies**: Poetry-managed (`pyproject.toml`/`poetry.lock`), own independent `.venv` —
  not merged into Production's or `scrapers`'. Shared deps pinned to match Production's exactly;
  `quent_core` is the one deliberate deviation, pinned to `v1.0.165` (kept in sync with
  `scrapers`' own pin).

## Streaming (quent-data-stream)

Publishing to `quent-data-stream` is **not currently active**. `PriceStore` is dump/retrieve
only, no publish, since `quent_core`'s own streaming module is mid-rework and too unstable to
build against right now. See `scrapers`' `project-overview.md` for the write-path detail (that's
the repo that calls `.dump()`); this repo only ever calls `.get()`, unaffected either way.

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

`bidding_zone`/`market_type`/`market`/`source` capped at 20 chars, `currency` at 10 — may need extending eventually.

**`market_type` vs `market`**: `market_type` is a coarse filter, `market` is what actually disambiguates. `DAY_AHEAD` doesn't always mean SDAC — GB isn't part of SDAC at all, and AT has both SDAC and EXAA's early auction for the same delivery day. `market` covers auction codes (`SDAC`, `EXAA_EARLY`, `IDA1-3`) and intraday VWAP series (`ID1`, `ID3`, `FULL`) as open text, no enum. A fuller normalized design (`dim_bidding_zone`/`dim_market_type`/`dim_market`/`dim_source` tables with FKs) is sketched in `id-tables-design.drawio`, archived as a future option, not a pending plan — revisit only if bad `market` values actually become a problem.

**Resolution**: most zones have moved to 15-minute settlement, some are still 30 or 60. Stored as plain integer minutes, read per response — never hardcoded per zone, since a zone can change resolution over time.

`PriceStore.get()` collapses to the latest `forecasttime` per `valuetime`/zone/market_type/market/source/resolution, so consumers get the current price curve, not every scrape snapshot. `resolution` is part of this key (not just a value column) since `quent_core` v1.0.164 — a 60-min row's `valuetime` (top of the hour) always equals the `valuetime` of that hour's first 15-min row for the same zone/market/source, so mixed-resolution rows used to collide on the same key with different prices (e.g. Belgium's 15min vs 60min EPEX VWAP) before this fix.

**Dedup / rescrape strategy**: `PriceStore.dump()` is append-only, not upsert — it looks up the latest known price per key (`valuetime`/`bidding_zone`/`market_type`/`market`/`source`/`resolution`, one query per batch, not per row) and inserts a new row (new `forecasttime`) only when the price actually changed for that key; unchanged rescrapes are skipped. `forecasttime` therefore means "when this price last changed", not "when we last checked". Comparison is price-only — currency changes alone don't trigger a new row, but a different `resolution` is a different key entirely (always a new row, not a "change" to detect). `ON CONFLICT DO NOTHING` on the full PK is kept only as a safety net against exact re-inserts, not as the change-detection mechanism.

## Dashboard

`dashboard/` - standalone FastAPI + plain-JS map dashboard (run with
`poetry run uvicorn dashboard.app:app --reload --port 8000`), not Streamlit — built to show
coverage and price level geographically rather than as a chip/text list. Has its own day picker
(prev/next arrows + a native date input). Each of the 41 `IN_SCOPE_ZONES` is drawn as its real
bidding-zone shape, not just a country outline (NO1-5, SE1-4, DK1/DK2, and Italy's 7 sub-zones
each get their own polygon). Default view is just the zone code + price; hover for a card with
the per-source completeness breakdown and a price curve chart, to stay minimal.

- **Camera follows the selected auction's own zone list**: switching auctions (`static/app.js`
  `selectMarket`) flies the map to fit just that market's `zones` (the same list that drives
  `app.py`'s "not applicable" styling) via `focusMarketZones()`, rather than leaving the camera
  wherever the previous auction left it. `zones` (server-side: `/api/prices`' `market_zones`) is
  computed by `dashboard/zones.py`'s `get_market_zones()` — `SELECT DISTINCT market_type, market,
  bidding_zone FROM prod.prices`, cached 24h — rather than a hardcoded per-auction list (SDAC used
  to be "all 41 minus GB/IE" by exclusion, N2EX/SEM-DA a bare single-zone list, and IDA1-3/VWAP
  borrowed a scraper's own `ZONE_FILE_CONFIG`, see git history), so it tracks an auction's actual
  coverage automatically, without a code change - same mechanism as the sibling `imbalance`
  repo's `get_scraped_zones()`. Uses
  asymmetric `fitBounds` padding (`paddingTopLeft: [300, 40]`) since the auctions panel is docked
  top-left and would otherwise cover a tight zoom. Doesn't touch `minZoom`/`maxZoom`/`maxBounds`
  or the "reset view" button (still resets to the full-Europe default) — only the live camera
  position on an auction switch.
- **Fill color is price-intensity, not just "has data"**: zones are colored on a per-day muted
  green (cheap) → amber → red (expensive) scale, normalized against that day's own min/max across
  zones (day-ahead levels swing too much day-to-day for a fixed scale to stay informative). Zones
  with no data yet are off-white/dashed, clearly distinct from "cheap". The "no data"/"out of
  scope" greys are kept a few steps darker (light mode) or lighter (dark mode) than the water
  background — unclamped they measure as low as ~1.05 WCAG contrast against it (functionally
  invisible); keep them at least ~1.3-2.2 if this palette changes.
- **Two visually distinct "no data" categories, not three**: "pending" (in scope, this auction,
  just not landed yet - `noDataStyle()`, lightest/most "alive") vs. everything else that isn't
  going to get data under the current auction, whether never in scope at all (Russia, ...) or
  just out of scope for this particular auction (GB under SDAC, or every zone but 4 under IDA1) -
  both rendered identically via `notApplicableStyle()` reusing the context layer's own opaque
  `--context-fill`/`--context-stroke`. Used to be three distinct grey tiers (context/not-
  applicable/pending each their own shade), but a dedicated middle tier composited translucently
  over the context layer (which sits directly under every zone shape, not the map's own
  background gradient the original tokens were validated against) can't clear the dataviz skill's
  OKLab normal-vision floor of 15 against the pending grey - measured ΔE 4.8, i.e. one grey, not
  three. Most visible on narrow auctions (IDA1-3, N2EX, the VWAP indices) where nearly the whole
  map falls into the not-applicable tier, reading as "every zone still pending" instead of "only
  these zones matter" - same fix as the imbalance dashboard's `notScrapedStyle()`, same reasoning
  and same shared token values (`--nodata-fill`/`--context-fill` are identical hex across both
  repos), so the two dashboards' map legend reads the same way.
- **Not-applicable zones get no code label either, not just the recessive fill**: `zoneLabelHtml()`
  returns an empty string for any zone outside `currentMarketZones`, and `updateZoneLabel()`
  unbinds the permanent tooltip entirely rather than setting empty content on it - Leaflet's
  tooltip update silently no-ops on a falsy content string, so a plain `setTooltipContent("")`
  left the previous auction's code/price frozen on screen instead of actually clearing it.
  `updateZoneLabel()` rebinds the tooltip if the zone later becomes applicable again (switching
  back to an auction that covers it). `currentMarketZones` itself was already sourced live from
  `prod.prices` (`get_market_zones()`, see Dashboard/architecture above) before this fix, not a
  hardcoded list - only the label's visibility needed wiring to it, same fix pattern as the
  imbalance dashboard's `updateZone()`.
- **Data colors are kept separate from the company brand color** (`--brand: #77bd46`) even though
  both land in the green family: `--data-good`/`--data-warn`/`--data-bad` are muted rather than
  bright, and `--data-good` is a distinct blue-leaning teal-green rather than brand's yellow-green
  hue, so a data fill can't be mistaken for "the brand color." Brand green is reserved for
  decorative accents only: the header's app-icon/favicon, and thin selection edges/rings (view
  toggle, selected auction row, today's date, loader spinner).
- **Translucent glass panels** (`backdrop-filter`) on the elements that float over the map —
  auctions panel, hover card, zone chips, zoom control — with `prefers-reduced-motion`/
  `prefers-reduced-transparency` fallbacks. Styled using the `apple-design` skill (installed
  globally, not part of this repo).
- **Light/dark mode has a manual header toggle** (`#theme-toggle`, a sun/moon icon pair styled
  as a `.view-toggle` segmented pill - same chrome as Prices/Coverage and CET/UTC, see the header
  layout bullet below), defaulting to the OS `prefers-color-scheme` setting - an explicit choice
  stamps `data-theme="light"|"dark"` on `<html>` (an inline head script in `index.html` applies
  any stored choice before first paint, to avoid a flash of the wrong theme) and persists to
  `localStorage`, read back on the next load. Unlike the old single-icon-button version (flips
  the current effective theme on click), each icon is its own explicit choice
  (`setTheme("light"|"dark")`) with the current effective theme's icon shown active - clicking
  the already-active icon is a no-op rather than writing a redundant override.
  `document.documentElement`'s `data-theme` attribute is what both the CSS cascade and
  `effectiveTheme()`/`syncThemeToggleUI()` read, so the pill never drifts out of sync with what's
  actually on screen (including on an OS-level scheme change with no explicit override, handled
  by a `prefers-color-scheme` change listener). `style.css`'s dark tokens are declared twice in
  lockstep: once under `@media (prefers-color-scheme: dark)` guarded by
  `:not([data-theme="light"])` (OS-dark, no override, or an explicit dark override), once under
  `:root[data-theme="dark"]` (explicit dark override on an OS-light device). `app.js`'s map-fill
  colors are read live off computed CSS per zone already; the one exception is the cached price
  ramp RGB triple read once at load (`PRICE_LOW/MID/HIGH`) - the toggle explicitly re-reads and
  repaints (`refreshPriceRampColors`/`repaintZones`) rather than relying on a page reload.
- **Header holds only the four selector/action pills** (Prices/Coverage, CET/UTC, Light/Dark,
  download) - the price/coverage scale legend that used to sit in the header's `.legend` row now
  floats bottom-right over the map instead (`.map-scale-panel`, same glass-panel treatment as the
  top-left auctions panel), so the header reads as pure controls. All three two-option toggles
  share the same `.view-toggle`/`.view-btn` pill chrome; the download button is wrapped in a
  `.view-toggle` of its own (a single `.icon-btn` instead of a button pair) purely so its chrome
  matches, not because it's a two-state toggle. `.view-toggle`'s pill-track background is its own
  dedicated `--control-track` token, not the map's `--nodata-fill` - reusing the map token here
  once made an inactive pill's `--text-muted` icon/label measure ~1.3:1 contrast against the
  track in dark mode (`--nodata-fill` composites translucently over the map background elsewhere,
  so its solid dark-mode value is much lighter than intended for opaque header chrome) -
  `--control-track` is tuned to clear ~4.5:1 against `--text-muted` in both themes instead, with
  the wrapper's `--card-border` outline carrying the "this is a control" boundary where the
  fill-vs-page-background separation is deliberately subtle.
- **Which timezone the price-curve hover card's times are shown in was ambiguous** (always
  `Europe/Copenhagen`, with no on-screen indication) - `#tz-toggle` (CET/UTC, same pill chrome)
  fixes the label only, not the underlying data: `dashboard/zones.py`'s curve points carry both
  `time` (Copenhagen, unchanged) and `time_utc`, and `app.js`'s `curveLabel()` picks whichever the
  toggle currently selects for the chart's x-axis and hover-crosshair labels. The "now" marker's
  own position (`nowLineX`/`currentMinutesInDeliveryTz`) always uses the Copenhagen field
  regardless of the toggle - it's about time-of-day-within-the-delivery-day, and UTC labels for a
  Copenhagen calendar day wrap around UTC midnight (non-monotonic minutes-of-day), which would
  break that interpolation. Defaults to CET/CEST and persists to `localStorage`, same pattern as
  the theme toggle; toggling closes an open hover card rather than re-rendering it in place (its
  `expanded`/`info` state lives in the mouseover handler's own closure), same tradeoff the theme
  toggle already makes for its curve-chart stroke color.
- **Full palette re-validated with the `dataviz` skill's `validate_palette.js`** while adding the
  toggle, on the colors as actually RENDERED (each translucent fill composited over
  `--map-bg-outer` at its real `fillOpacity`, not the raw CSS anchor) rather than the documented
  anchors - an anchor that never renders at full opacity proves nothing. Found and fixed two real
  defects this way: (1) `--noneur-fill` (non-EUR currency zones) was a pale blue-grey that
  composited to within OKLab ΔE 2.5 of `--nodata-fill`'s own composite - indistinguishable from
  "no data yet" under normal vision (skill's floor is 15) - re-stepped to a deep, clearly
  saturated blue, validated against every price-ramp anchor, not just the pending grey; (2) dark
  mode's three-tier no-data grey (`--nodata-fill`/`--notapplicable-fill`/`--context-fill`)
  collapsed to OKLab ΔE ~1.1 once composited at real opacity over the dark map background -
  lightened the two translucent tiers to restore real separation. `--nodead-stroke` was
  deliberately left alone despite the same collapse, since it doubles as the auctions panel's
  solid "pending" status dot and lightening it there would have pushed it within ΔE 13.8 of
  `--auction-bad` - a worse regression than the one being fixed. Also fixed two light-mode text
  colors (`--data-good-text`/`--data-warn-text`) that measured below the 4.5:1 WCAG text-contrast
  floor against `--bg`. A sequential/diverging ramp's own internal anchors (e.g.
  `--data-good`/`--data-warn`/`--data-bad` against each other) are exempt from the categorical
  CVD/normal-vision checks by the skill's own scope note (governed by lightness monotonicity
  instead) - only cross-family pairs (a ramp's anchors vs. `--noneur-fill`) are held to that
  floor.
- **Design consistency with the sibling `imbalance` repo's dashboard**: audited class-by-class
  (every shared CSS selector's actual property values, not just a visual skim) - the two matched
  everywhere content allowed as of that audit (header icon order view toggle, scale, download,
  theme toggle - always rightmost). Genuinely different content was left alone rather than forced
  to match: this map's single price headline gets more hover-card width and a larger expanded
  font than `imbalance`'s two side-by-side headlines (price + volume) need, and the sequential
  price scale needs a plain 2-stop gradient where the diverging one needs a 3-stop modifier class.
  **Since diverged**: this repo's header was reworked to hold only the four selector/action pills
  (scale moved to a floating `.map-scale-panel`, theme toggle became an icon pill instead of a
  single sun/moon-swap button, download is now the rightmost element instead of theme - see the
  header-layout bullet above) - `imbalance`'s header still reflects the older shared layout as of
  this writing, revisit if that repo's header is ever reworked to match again.
- **Currency correctness matters here**: only zones actually priced in EUR feed the
  price-intensity scale (checked against real landed data, not assumed from `currency`'s stated
  possible values) — every SDAC/SEM-DA zone lands in EUR, *including* CH and the Nordics (their
  day-ahead auction clears in EUR even though NOK/CHF is the local retail currency); only GB
  (N2EX/GbHalfHour, not SDAC) lands in GBP. Non-EUR zones get a distinct muted fill instead of
  being silently mixed into the EUR scale, since there's no FX conversion anywhere in this
  project.
- **Day-ahead auction labeled "SDAC + CH", not just "SDAC"**: `SDAC_ZONES` (`app.py`) includes
  CH, but Switzerland isn't actually an SDAC member (its auction is coupled to SDAC at the
  border, not run through SDAC's own algorithm) — unlike Norway's NO1-5, genuine SDAC
  participants via the EEA. Display-only distinction (`MARKET_OPTIONS`/`static/app.js`
  `MARKET_LABELS`); doesn't touch the underlying `market="SDAC"` DB value, since CH's landed
  price is genuinely the SDAC-coupled result.
- The hover card's curve is a hand-rolled inline SVG sparkline (no charting library — no bundler
  in this repo, Leaflet itself is vendored not CDN'd for the same offline-friendly reason) rather
  than a list of every settlement period — a shape reads faster than 96 numbers. Built from
  whichever `(source, market)` landed the most periods that zone/day.
- `zones.py` groups by `(source, bidding_zone, market)` before averaging into one headline
  "baseload" price per zone — avoids a naive row-mean letting GB's half-hourly market (2x the row
  count of its hourly market) skew the number shown on the map.
- Zone/context polygons are pre-built static files (`static/geo/zones.geojson`,
  `static/geo/context.geojson`), not fetched live — `build_geo.py` (run manually, not by the app)
  combines `EnergieID/entsoe-py`'s per-bidding-zone shapes (no GB/IE) with Natural Earth's
  admin-0 country outlines for GB/IE and the grey context layer. `context.geojson` covers the
  whole world; the map's own `maxBounds`/`minZoom` (`static/app.js`) are what keep the camera to
  Europe — clipping the geo data itself to a Europe bbox looked cut off at the edges instead.
  Re-run the build script only if upstream shapes change.
- **Zone shapes are clipped to the real coastline**: entsoe-py's multi-zone-country shapes
  (Norway, Sweden, Italy) smooth across every fjord/island rather than tracing the coast —
  unclipped, Norway's NO1-5 union measured 34% larger than its real landmass. `build_geo.py`'s
  `_clip_to_land()` intersects every entsoe-py zone against the Natural Earth land outline via
  `BIDDING_ZONE_TO_CLIP_ISO_A2` — applied uniformly (a no-op for zones already sourced from
  Natural Earth). Adds `shapely` as a dev-only dependency.
- **Natural Earth's `ISO_A2` field is `-99` for France and Norway** (its sentinel for
  disputed-sovereignty countries) — `build_context_geojson()`'s in-scope exclusion check
  originally matched on `ISO_A2`, so both countries' full outlines leaked into the grey context
  layer underneath the zones layer's own FR/NO1-5 shapes, visibly mismatched along the coastline.
  Fixed by preferring `ISO_A2_EH` (the "extended"/de-facto field, which carries the real code for
  this case) and falling back to `ISO_A2` otherwise — worth remembering if another country ever
  reads as double-layered.
- Leaflet vendored locally under `static/vendor/leaflet/` (BSD-2-Clause) rather than a CDN, so
  the page has no runtime internet dependency.
- **`static/geo/grid.geojson`** — Europe's high-voltage transmission lines, an intentionally
  faint background layer (not meant to be noticed at a glance). Source: GridKit (OpenStreetMap
  `power=line` extraction, ODbL 1.0) — extracted 2016, stale for analysis but fine for
  decoration. ODbL technically requires attribution for the produced map even for internal-only
  use, but this dashboard is internal-only and the map's Leaflet attribution control has been
  dropped (`attributionControl: false`, each layer's own `attribution:` option removed
  alongside it) on that basis - revisit if this dashboard is ever exposed outside the team.
- **CSV download**: a header button opens a popover listing every auction (`MARKET_OPTIONS`)
  with checkboxes, auction-only (no bidding-zone filter — considered and dropped as too fiddly
  for the gain). Hits `/api/download` (`date` + comma-separated `markets`), pulling raw
  per-period rows via `zones.py`'s `build_price_rows()` — every landed `(bidding_zone, source,
  valuetime)` row, not the map's own per-zone average/curve — as `prices_<date>.csv`. Each row
  carries both `local_time` (HH:MM, `DELIVERY_DAY_TZ`) and an authoritative `valuetime_utc`
  ISO8601 column, so non-EUR zones like GB stay readable without implying a shared price scale.
- **Geo file load performance**: `build_geo.py` runs `shapely.simplify(preserve_topology=True)`
  on zones/context (zones stays more detailed, it's the interactive/hovered layer) and rounds
  coordinates to 5 decimals (~1m precision) on all three geo files — cut combined gzip payload
  from ~2.66MB to ~1.04MB with no visible difference at this map's zoom range. `build_geo.py`
  also writes a precomputed `.gz` sibling per file, served directly by `app.py`'s
  `CachedStaticFiles` when the client accepts gzip, avoiding re-gzipping multi-MB files on every
  request — the `/static/geo` mount's `Cache-Control` is `max-age=604800` but deliberately not
  `immutable`, since a manual rebuild changes the file in place with no URL/version bump.
  `static/app.js` fetches `grid.geojson` only after the interactive map is already up (own
  Leaflet pane, z-index between context and zones), since it's decorative and shouldn't gate
  first paint. Context and grid use `L.canvas()` rather than SVG (grid alone is ~18,800 line
  features); zones stays on SVG since it needs per-feature hover/tooltip interactivity.
- **`keepTooltipInView()` calling `tooltip.update()` after rebinding the expand button/chart-hover
  listeners silently killed both** - Leaflet's `DivOverlay.update()` unconditionally re-runs
  `_updateContent()` (`innerHTML = content`) even when the content string is unchanged, which
  destroys and recreates the button/`.chart-wrap` nodes. Calling it *after* `bindExpandButton()`/
  `bindChartHover()` orphaned whatever listener was just attached - the initial hover-card setup
  happened to call it before the first bind (so expanding a compact card always worked), but the
  toggle's own click handler called it after, so the button left behind by any click had no
  listener at all (collapse never worked) and the chart-hover crosshair never got a live listener
  either (never worked, not even once expanded). Fixed by moving `keepTooltipInView()` before the
  rebind at every call site, in both this dashboard and the sibling `imbalance` dashboard (same
  copy-pasted pattern, same bug).
- **"expected" row counts for IDA3 (all zones) and GB/CH's own IDA2 auctions assumed a full
  delivery day, so those coverage bars/map tiles could never reach 100%** - `zones.py`'s
  `build_zone_summary()` computed `expected` as `span_minutes / resolution` over the whole
  00:00-24:00 delivery day unconditionally. Confirmed empirically against `prod.prices` (max
  observed row count per zone/day, never varying): IDA3's own gate closure is ~10:00 CET/CEST
  on delivery day D itself (`scrapers`' `clients/epex/endpoints/ida3.py`), so it only ever
  covers periods from local 12:00 onward for every zone (12h, not 24h) - unlike IDA1/IDA2, which
  gate-close the evening of D-1 and do cover the full day. GB and CH each also run their own
  local (non-pan-European) IDA2 product (`clients/epex/endpoints/ida.py`'s module docstring)
  that likewise gate-closes mid-morning on D rather than D-1 - the "IDA2" label is shared with
  the pan-European auction but the product isn't, so GB topped out at 24/48 half-hourly periods
  and CH at 12/24 hourly periods, both permanently "partial" (yellow) on the map. Fixed via
  `_expected_periods()`/`_HALF_DAY_MARKETS`/`_HALF_DAY_MARKET_ZONES` - these three (market,
  zone) cases compute `expected` off a local-noon start instead of local midnight; every other
  market/zone is unaffected. The 12:00-24:00 half never straddles a DST transition (always
  before noon), so it's a flat 12h/resolution with no 23/25-hour-day special-casing needed,
  unlike the full-day markets. VWAPs (ID1/ID3/IDFULL) were re-checked the same way and are
  correct as-is - continuous trading runs the full day, confirmed by `prod.prices`'s own max row
  counts matching a full day at native resolution.
- **`/api/auctions` was doing 14 sequential DB round-trips per date switch, one `build_zone_summary()`
  call per `MARKET_OPTIONS` entry** (`app.py`'s `get_auctions()`) - each call re-queried and
  recomputed avg_price/curve that endpoint never uses, since it only needs a has-data boolean per
  zone. This was the main cause of "switching between days feels slow": `/api/prices` itself was
  already fast (PK-indexed, see the `get_market_zones()` item above), but every date change also
  fires a `loadAuctions()` call (`static/app.js`) that fanned out into 14 round-trips against the
  remote RDS instance. Fixed via `zones.py`'s `build_auctions_summary()` - one query for the whole
  day across every market_type/market (no `market`/`market_type` filter, `valuetime` is still the
  leading PK column so the range scan stays index-backed), grouped in pandas into
  `{(market_type, market): zones_with_data}` - `get_auctions()` now looks up each auction's zones
  in that dict instead of re-querying per auction.
- **`zones.py`'s `_get_day_rows()` is the one shared fetch behind `build_zone_summary()` (one
  market's view), `build_auctions_summary()` (all markets' status) and `build_price_rows()` (CSV
  export)** - `/api/prices` and `/api/auctions` are always fetched together for the same date
  (`static/app.js`'s `loadPrices()` always follows up with `loadAuctions()` for the date it just
  resolved) and both need the same whole-day shape, so sharing the query function avoids
  duplicating that logic even though each endpoint still does its own live DB round-trip.
  **Deliberately no caching on this function** - a time-based cache here was tried (in-process,
  10s TTL) and reverted: this repo's dedup/rescrape strategy allows a rescrape to insert a new row
  for an already-published day at any time (see Dedup/rescrape strategy above), and for a trading
  tool a changed price silently not showing up because of a cache window is a worse outcome than
  the small, already-fixed cost of a live per-request query (no longer the 14-query fan-out from
  the item above).
- **Rapid-fire date/market switching had no defense against out-of-order responses** - clicking
  next/prev (or switching markets) faster than a request round-trip fires overlapping fetches
  with no guarantee they resolve in request order, so a slower, superseded response could land
  after and overwrite a newer one, leaving the map showing an intermediate day/market instead of
  the last one actually selected. `static/app.js`'s `loadPrices()`/`loadAuctions()` each now stamp
  a monotonically increasing request id at call time and discard their own response if a newer
  call has since started - same guard in both functions since either can independently race.
- **No visual feedback while a date/market switch was in flight** - added a brief opacity dim on
  the day-picker (`.day-picker.is-loading`, `static/app.js`'s `loadPrices()`) for the duration of
  the request, cleared in a `finally` (guarded by the same request-id check above) so a failed or
  superseded fetch can't leave it stuck dimmed. Deliberately not a spinner - fetches land fast
  enough post-fix that anything busier would just flicker.
- **No response caching or prefetching in the frontend either, same reasoning as `_get_day_rows()`
  above** - a 5-minute in-browser cache keyed per date(+market/resolution), plus prefetching the
  day either side of whatever just loaded, were both tried (`static/app.js`) and reverted: for a
  trading tool, a changed/corrected price not showing up for up to 5 minutes (or on a prefetched-
  but-now-stale neighbor) because of a client-side cache is a worse failure mode than the
  round-trip it was saving, especially once the real cause of the slowness (the 14-query fan-out
  above) was already fixed. `fetchPrices()`/`fetchAuctions()` are still the shared fetch
  functions (used by `main()`, `loadPrices()`, `loadAuctions()`), just with no cache layer -
  every load/switch always hits the backend live.
- **Wheel/trackpad zoom felt jumpy even with `zoomSnap: 0.25`/`wheelPxPerZoomLevel: 100` tuned
  down from Leaflet's defaults** - the built-in scroll handler is inherently a batch-then-jump
  design (accumulate wheel deltas for ~40ms, then animate to a new snapped level with a CSS
  transition), and a continuous scroll/trackpad gesture restarts that animation on every debounce
  window, which reads as stepped no matter how fine the snap increment is. Replaced with
  `static/app.js`'s `L.Map.SmoothWheelZoom` - same technique as the community
  Leaflet.SmoothWheelZoom plugin (reimplemented locally rather than pulled in, consistent with
  Leaflet itself being vendored not CDN'd): each wheel event nudges a running "goal zoom" clamped
  to min/max only (deliberately not `zoomSnap`-rounded, to stay continuous mid-gesture), and a
  `requestAnimationFrame` loop eases the live view toward it every frame via Leaflet's internal
  `_move`. Registered via `scrollWheelZoom: false` + `map.addHandler("smoothWheelZoom", ...)`
  instead of alongside the built-in handler. `zoomSnap`/`zoomDelta` (still 0.25/0.5) now only
  govern button/double-click/keyboard zoom, unaffected by this change.
- **Date-picker's native calendar popup was always white/light, regardless of the dashboard's own
  theme** - `#date-input`'s own comment already noted "no cross-browser CSS hook to style" the
  popup, missing the `color-scheme` CSS property, which Chromium does use to theme the native
  calendar grid and picker-indicator icon. Added `color-scheme: light`/`dark` to the same
  three-state lockstep already used for every other theme token in `style.css` (`:root`, the
  `prefers-color-scheme: dark` block guarded by `:not([data-theme="light"])`, and the explicit
  `:root[data-theme="dark"]` override). This made the old manual
  `#date-input::-webkit-calendar-picker-indicator { filter: invert(1); }` (which only fired under
  OS-dark, never the explicit override) redundant and, once the icon is already correctly
  recolored via `color-scheme`, a source of double-inversion - removed rather than extended.

## Docker deployment

Runs on the same server as `quent-data-stream`'s containers, one instance only (no dev/prod
split, unlike that repo). Confirmed via `netsh interface ipv4 show excludedportrange` and
`Get-NetTCPConnection`/`netstat` on the server that port **8080** is free (not claimed by any
running container or Windows' Hyper-V/WSL port-exclusion ranges) - published as
`${DASHBOARD_PORT:-8080}:8000` in `docker-compose.yml`.

- `Dockerfile` - `python:3.12-slim`, `poetry install --only main`, copies `core/` + `dashboard/`
  (which includes `static/`, geo files and all), runs `uvicorn dashboard.app:app --port 8000`
  internally. Installs `gcc`/`libpq-dev` at build time - `psycopg2` (not `-binary`) compiles from
  source, unlike `quent-data-stream`'s `asyncpg` which doesn't need this.
- **No live AWS access on the docker host** - confirmed by querying the EC2 instance metadata
  service (`http://169.254.169.254/latest/meta-data/iam/security-credentials/`, times out - not
  an EC2 instance, or IMDS is unreachable) and `aws sts get-caller-identity` (no credentials
  configured) directly on the server. So `dashboard/zones.py`'s engine can't resolve `prod/db/quent`
  via `quent_core`'s live `SecretsManagerClient` the way local dev does - same constraint
  `quent-data-stream`'s own container design already works around (its compose file: "the API
  container does not need AWS access in normal Docker startup").
- **Same fix as `quent-data-stream`**: `scripts/materialize_runtime_secrets.py` resolves the
  READ_ONLY_USER secret (`ai/db/quent`, keys `username`/`password`/`host`) *once*, wherever real
  AWS access exists (a dev machine with `AWS_PROFILE` set, not the docker host), and writes only
  the password to `.runtime/db/password` - mounted into the container as a Docker secret
  (`docker-compose.yml`'s `power_prices_db_password`). Deliberately the scoped read-only role, not
  the shared `prod/db/quent` credential local dev's `get_engine_quent()` uses - this dashboard only
  ever calls `PriceStore.get()`/`SELECT`, so a container holding a password is holding the narrower
  one. Confirmed working end-to-end (queried `prod.prices` successfully) before relying on it.
  `host`/`user` aren't secret (same reasoning as that repo's own script) - the script prints them
  once so they can be set as plain `DB_HOST`/`DB_USER` in the server's `.env`, never written to disk.
  This is the one narrow exception to CLAUDE.md's "don't build a new DSN loader": `core/db.py`'s
  `get_engine()` still calls `get_engine_quent()` unchanged for local dev, and only falls back to a
  plain `create_engine()` from `DB_HOST`/`DB_USER`/`DB_PASSWORD_FILE` when `DB_PASSWORD_FILE` is
  set (i.e. only inside the container) - not a general-purpose alternative to the shared engine.
- Healthcheck hits `/` (no dedicated `/health` endpoint - `/` needs no DB call either, so it's an
  equally cheap and already-existing target).
- Deploy: run the materialize script locally, copy `.runtime/db/password` to the server (or re-run
  the script there if AWS access is ever added to the host), set `DB_HOST`/`DB_USER`/
  `DASHBOARD_PORT` in the server's `.env` (see `.env.example`), then `docker compose up --build -d`.

## Testing

No tests currently live in this repo — the OPCOM pytest pilot (`tests/clients/opcom/`) moved to
`scrapers` along with `clients/opcom/` itself. See that repo's `project-overview.md` > Testing
for status and the decision not to extend it further for now.

## Open items

- Market code reference/lookup table — only if free-text `market` values start causing problems; `id-tables-design.drawio` sketches an FK-based alternative (see Data model).
- Day-ahead volumes alongside prices — needs a schema decision (extend `prod.prices` vs. separate table); currently out of scope.
- Re-enable publishing to `quent-data-stream` once `quent_core`'s streaming rework lands (see Streaming) — expected as a small add-on to `quent_core.database.price_store.PriceStore`, not a rebuild.
- **`get_market_zones()`'s unfiltered `SELECT DISTINCT market_type, market, bidding_zone FROM prod.prices` is a full seq scan** — measured ~5.1-5.3s against the live table (10.07M rows, 2026-08-21), consistently, not just cold-cache. Currently harmless since it's already behind that function's own 24h in-process cache (one hit/day per running dashboard process), but revisit if that stops being enough (more frequent restarts, another consumer needing the same lookup without the cache). A plain SQL view would **not** help — Postgres inlines a view's SQL at plan time, so it produces the identical execution plan as querying the base table directly. The actual fix would be a narrow covering index on `(market_type, market, bidding_zone)` or a materialized view refreshed on the same 24h cadence as the existing cache. The main per-day dashboard query (`PriceStore.get()` filtered by `market_type`+`market`+one day's `valuetime`) is unaffected — it already uses `prod.prices`' PK index efficiently (110ms cold / 16ms warm) and won't degrade as history grows, since a single day's row count doesn't scale with total table size.
- **Code that could eventually move to `quent_core`** (none started, just flagged):
  - `core/logging.py`'s `setup_logging()` — generic idempotent root-logger setup, no repo-specific dependency, duplicated in `scrapers`' `clients/_logging.py`.
  - `_day_bounds_utc()`/`IN_SCOPE_ZONES` — duplicated across `dashboard/zones.py`/`dashboard/build_geo.py` here and several files in `scrapers`. Duplicated on purpose per-file rather than shared — revisit only if that actually causes a problem.
