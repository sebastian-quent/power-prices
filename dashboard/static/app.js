const FILL_OPACITY = 0.62;

function hexToRgb(hex) {
  const m = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

// price -> color, green (cheap) through amber to red (expensive) - normalized per-day against
// the *current* day's own min/max, not a fixed absolute scale, since day-ahead price levels
// swing a lot day to day and a fixed scale would go flat/uninformative on calm days.
// read from CSS (style.css --data-good/-warn/-bad) rather than duplicated as hardcoded RGB -
// those tones and the header's .scale-bar gradient drifted apart once already from being kept
// as separate copies, so this is the one place they're defined, both other spots read from here.
// `let`, not `const` - the light/dark values differ (see style.css), so the theme toggle has to
// re-read these after flipping data-theme, or the map would keep painting the old mode's colors.
let PRICE_LOW = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-good"));
let PRICE_MID = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-warn"));
let PRICE_HIGH = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-bad"));

function refreshPriceRampColors() {
  PRICE_LOW = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-good"));
  PRICE_MID = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-warn"));
  PRICE_HIGH = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-bad"));
}

// current effective theme: an explicit data-theme override wins if present, otherwise whatever
// the OS reports right now - mirrors the CSS cascade in style.css exactly, so this never drifts
// out of sync with what's actually on screen.
function effectiveTheme() {
  const override = document.documentElement.getAttribute("data-theme");
  if (override === "light" || override === "dark") return override;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// reflects the current effective theme onto #theme-toggle's Light/Dark pill - called on load and
// whenever the OS setting changes with no explicit override in place, so the pill never drifts
// out of sync with what's actually on screen (mirrors effectiveTheme()'s own cascade).
function syncThemeToggleUI() {
  const current = effectiveTheme();
  document.querySelectorAll(".theme-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.themeChoice === current));
}

// click handler for #theme-toggle's Light/Dark buttons - sets an explicit override (unlike the
// old single-button flip, this always writes one, even if it happens to match the OS setting)
// and persists it for applyStoredTheme (index.html's inline head script) to pick up on the next
// load.
function setTheme(choice) {
  if (choice === effectiveTheme()) return;
  document.documentElement.setAttribute("data-theme", choice);
  localStorage.setItem("theme", choice);
  refreshPriceRampColors();
  repaintZones();
  syncThemeToggleUI();
  // an open hover card's curve chart draws its stroke color once, at open time (see
  // curveChartHtml) - closing it here is simpler than re-drawing it in place, and it reopens
  // instantly with the new theme's colors on the next hover.
  if (hoverTooltip) {
    map.removeLayer(hoverTooltip);
    hoverTooltip = null;
  }
}

// only zones actually priced in EUR feed the price-intensity scale. in practice that's every
// SDAC/SEM_DA zone (including CH and the Nordics, whose day-ahead auction clears in EUR even
// though their retail currency isn't) - only GB (its own N2EX/GbHalfHour auctions, not SDAC)
// lands in GBP. there's no FX conversion anywhere in this repo (see project-overview.md), so
// mixing a non-EUR price into the same 0-1 scale as EUR zones would silently compare unrelated
// units instead of just excluding the rare zone that isn't on this scale.
const SCALE_CURRENCY = "EUR";

// display names for the hover card only - map/API both key everything by the plain
// bidding_zone code (see dashboard/zones.py IN_SCOPE_ZONES).
const ZONE_NAMES = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", CH: "Switzerland", CZ: "Czech Republic",
  DE: "Germany", DK1: "Denmark (West)", DK2: "Denmark (East)", EE: "Estonia", ES: "Spain",
  FI: "Finland", FR: "France", GB: "Great Britain", GR: "Greece", HR: "Croatia",
  HU: "Hungary", IE: "Ireland",
  IT_NORD: "Italy (North)", IT_CNOR: "Italy (Center-North)", IT_CSUD: "Italy (Center-South)",
  IT_SUD: "Italy (South)", IT_SICI: "Italy (Sicily)", IT_SARD: "Italy (Sardinia)", IT_CALA: "Italy (Calabria)",
  LT: "Lithuania", LV: "Latvia", NL: "Netherlands",
  NO1: "Norway 1", NO2: "Norway 2", NO3: "Norway 3", NO4: "Norway 4", NO5: "Norway 5",
  PL: "Poland", PT: "Portugal", RO: "Romania",
  SE1: "Sweden 1", SE2: "Sweden 2", SE3: "Sweden 3", SE4: "Sweden 4",
  SI: "Slovenia", SK: "Slovakia",
};

let map;
const zoneLayers = new Map(); // bidding_zone -> Leaflet layer, built once
let hoverTooltip = null;
let closeTimer = null;

// display label for the empty-note in the hover card only - mirrors app.py's MARKET_OPTIONS keys
const MARKET_LABELS = {
  sdac: "SDAC + CH", n2ex: "N2EX", epex_gb_hourly: "EPEX GB Hourly", gb_hh: "GB HalfHourly",
  epex_gb_hh: "EPEX GB HalfHourly", sem_da: "SEM-DA",
  ida1: "IDA1", ida2: "IDA2", ida3: "IDA3", id1: "ID1", id3: "ID3", idfull: "IDFULL",
  rpd: "GB RPD", rpd_hh: "GB RPD HH",
};

// groups the auctions panel into Day-ahead / IDA / VWAP sections - purely a rendering grouping
// (see loadAuctions), mirrors app.py's MARKET_OPTIONS ordering rather than driving it.
const AUCTION_GROUPS = {
  sdac: "Day-ahead", n2ex: "Day-ahead", epex_gb_hourly: "Day-ahead", gb_hh: "Day-ahead",
  epex_gb_hh: "Day-ahead", sem_da: "Day-ahead",
  ida1: "IDA", ida2: "IDA", ida3: "IDA", id1: "VWAP", id3: "VWAP", idfull: "VWAP",
  rpd: "VWAP", rpd_hh: "VWAP",
};

// mirrors app.py's MARKET_OPTIONS keys - only used as the startup default (tomorrow for SDAC
// and IDA2 alike, yesterday for the VWAP indices, see MARKET_OPTIONS); once loaded,
// selectMarket() carries the currently selected date through instead of resetting to it.
let currentMarket = "sdac";

// "prices" (default) is the existing green->red price-intensity map; "coverage" is a quick
// have-we-got-it-at-all overview - same map/zones/data, no extra API call, just a different
// zoneStyle()/label reading of whatever /api/prices already returned (see selectView below).
let currentView = "prices";

// whether the currently-selected market has cleared for the currently-selected date (see
// app.py's get_prices `cleared` field) - a coverage-view zone with no data reads "missing"
// (red) once true, or just "not published yet" (neutral) while still false. Updated alongside
// priceByZone on every load/date/market change; not itself part of the per-zone info object.
let marketCleared = true;

// zones the *currently selected market* can ever cover (app.py's get_prices `market_zones`,
// e.g. just GB for N2EX, 39 zones for SDAC) - distinct from the full 41-zone IN_SCOPE_ZONES that
// `priceByZone` always covers. A zone outside this set (e.g. GB/IE under SDAC) will never have
// data for this market, so it's styled/labelled as "not applicable" rather than "no data yet"
// (which would wrongly imply it's merely pending, or read as a real gap once cleared).
let currentMarketZones = new Set();

// which timezone the price-curve hover card's time labels are shown in ("cet" = Europe/Copenhagen,
// matching dashboard/zones.py DELIVERY_DAY_TZ; "utc" reads the curve's own `time_utc` field
// instead) - persisted like the theme toggle, defaults to CET/CEST (unchanged prior behavior).
// Purely a label-formatting choice: nowLineX/timeToMinutes below always position the "now" line
// using the Copenhagen `time` field regardless of this setting, since that positioning is about
// time-of-day-within-the-delivery-day, not the display timezone, and UTC labels for a Copenhagen
// calendar day wrap around UTC midnight (non-monotonic minutes-of-day), which would break that
// interpolation.
let displayTz = localStorage.getItem("displayTz") === "utc" ? "utc" : "cet";

function curveLabel(point) {
  return displayTz === "utc" ? point.time_utc : point.time;
}

// markets that scrape both 15min and 60min VWAP rows (mirrors app.py's VWAP_MARKETS) - the
// resolution toggle only ever applies to these, hidden the rest of the time (see selectMarket).
const RESOLUTION_TOGGLE_MARKETS = new Set(["id1", "id3", "idfull"]);

// which settlement resolution the VWAP markets' price/curve data is fetched at - persisted like
// the tz/theme toggles, defaults to 15min (unchanged prior behavior, back when 60min wasn't
// scraped yet). Unlike setDisplayTz, this changes which data is fetched, not just how it's
// labelled, so it triggers a reload rather than just a repaint.
let displayResolution = localStorage.getItem("vwapResolution") === "60" ? 60 : 15;

function setResolution(res) {
  if (res === displayResolution) return;
  displayResolution = res;
  localStorage.setItem("vwapResolution", String(res));
  document.querySelectorAll(".res-btn").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.resolution) === res));
  loadPrices(document.getElementById("date-input").value);
}

function setDisplayTz(tz) {
  if (tz === displayTz) return;
  displayTz = tz;
  localStorage.setItem("displayTz", tz);
  document.querySelectorAll(".tz-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tz === tz));
  // simplest correct fix, same as setTheme's own approach: close rather than re-render in
  // place, since expanded/info are held in the mouseover handler's closure, not accessible here.
  if (hoverTooltip) {
    map.removeLayer(hoverTooltip);
    hoverTooltip = null;
  }
}

// whether the auctions panel is collapsed to just the currently selected auction - default is
// expanded (every auction shown, grouped), same as before this toggle existed. Cached alongside
// the last /api/auctions response so toggling re-renders instantly without a re-fetch.
let auctionsCollapsed = false;
let lastAuctionsData = null;

function setActiveAuctionRow() {
  document.querySelectorAll(".auction-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.market === currentMarket);
  });
}

async function selectMarket(market) {
  if (market === currentMarket) return;
  currentMarket = market;
  setActiveAuctionRow();
  // only visible for the VWAP markets (see RESOLUTION_TOGGLE_MARKETS) - anything else has no
  // resolution ambiguity to toggle.
  document.getElementById("resolution-toggle").hidden = !RESOLUTION_TOGGLE_MARKETS.has(market);
  // the date picker is the source of truth once the page has loaded (day-ahead/tomorrow is
  // only the startup default) - switching auctions must not jump the date back to that
  // auction's own default, so the currently selected date is passed through explicitly.
  await loadPrices(document.getElementById("date-input").value);
  // currentMarketZones is only known once loadPrices' /api/prices response lands (see
  // applyPrices), so the camera fit has to wait for that - a market covering just a
  // handful of zones (e.g. IDA1, BE-only today) zooms in on them instead of staying at
  // whatever zoom level the previous market left the map at. Dynamic by construction: it
  // reads the market's live `zones` list (see app.py MARKET_OPTIONS), so it keeps tracking
  // correctly as more zones get activated for a given market.
  focusMarketZones();
}

// fits the camera to just the zones the current market actually covers - a no-op-ish framing
// for wide markets like SDAC (close to the full map already), a real zoom-in for narrow ones.
// Does not touch minZoom/maxZoom/maxBounds (still the full-Europe extent set up in main()), so
// panning back out to see the rest of the map still works regardless of the selected market.
function focusMarketZones() {
  if (!map) return;
  let bounds = null;
  for (const zoneCode of currentMarketZones) {
    const layer = zoneLayers.get(zoneCode);
    if (!layer) continue;
    bounds = bounds ? bounds.extend(layer.getBounds()) : layer.getBounds();
  }
  if (!bounds) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // asymmetric padding, not a flat value - the auctions panel is docked top-left over the
  // map itself (see index.html), so a tight zoom (e.g. IDA1's single BE polygon today) would
  // otherwise land straight underneath it. Left gets extra room for the panel; the other
  // three edges keep an ordinary margin (140, doubled again from 70 so a single-zone zoom
  // like BE stays well clear of the coastline instead of cropping in tight).
  // duration halved from Leaflet's default auto-computed flight time (~1.2s for this app's
  // zoom range) to make the zoom-in/out feel twice as quick.
  map.flyToBounds(bounds, {
    paddingTopLeft: [300, 140],
    paddingBottomRight: [140, 140],
    animate: !reduceMotion,
    duration: 0.6,
  });
}

// re-applies zoneStyle()/zoneLabelHtml() to every already-rendered zone layer from whatever
// data it last got, without a new fetch - shared by selectView (view changed) and the theme
// toggle (colors changed) below, since both need the exact same "repaint, don't refetch" step.
function repaintZones() {
  for (const [zoneCode, layer] of zoneLayers) {
    layer.setStyle(zoneStyle(layer._priceInfo, zoneCode));
    updateZoneLabel(layer, zoneCode, layer._priceInfo);
  }
}

// switching view is purely a re-render of whatever /api/prices already returned - no new fetch,
// since coverage just reads the same has_data/sources fields the price view already has.
function selectView(view) {
  if (view === currentView) return;
  currentView = view;
  document.querySelectorAll("#view-toggle .view-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  document.getElementById("page-title").textContent = view === "coverage" ? "COVERAGE" : "PRICES";
  document.getElementById("price-scale").hidden = view !== "prices";
  document.getElementById("coverage-scale").hidden = view !== "coverage";
  repaintZones();
}

function auctionRowHtml(a) {
  return `
    <div class="auction-row" data-market="${a.key}">
      <span class="auction-light ${a.status}"></span>
      <div class="auction-main">
        <span class="auction-name">${a.label}</span>
        <span class="auction-meta">${a.have}/${a.total} zones &middot; clears ${a.clears}</span>
      </div>
    </div>
  `;
}

// renders whatever /api/auctions last returned, from lastAuctionsData - split out from
// loadAuctions so toggling auctionsCollapsed re-renders instantly without a re-fetch.
function renderAuctions() {
  if (!lastAuctionsData) return;
  const rows = auctionsCollapsed
    ? lastAuctionsData.auctions.filter((a) => a.key === currentMarket)
    : lastAuctionsData.auctions;
  // group headers (Day-ahead / IDA / VWAP) - a thin divider + small title whenever the group
  // changes, skipping the divider on the very first group so the panel title isn't doubled up.
  // Collapsed view is just the one selected row, so group headers would be redundant noise.
  let html = "";
  let lastGroup = null;
  for (const a of rows) {
    if (!auctionsCollapsed) {
      const group = AUCTION_GROUPS[a.key] || "";
      if (group !== lastGroup) {
        html += `<div class="auction-group-title${lastGroup ? " with-divider" : ""}">${group}</div>`;
        lastGroup = group;
      }
    }
    html += auctionRowHtml(a);
  }
  const list = document.getElementById("auctions-list");
  list.innerHTML = html;
  list.querySelectorAll(".auction-row").forEach((row) => {
    row.addEventListener("click", () => selectMarket(row.dataset.market));
  });
  setActiveAuctionRow();
}

// deliberately no response caching or prefetching here (tried and reverted - see git history) -
// this repo's dedup/rescrape strategy allows a rescrape to insert a new row at any time for an
// already-published day (see Dedup/rescrape strategy in project-overview.md), and for a trading
// tool a changed price silently not showing up because of a cache window matters more than
// shaving the round-trip on a revisit. Every load/switch always hits the backend live.
async function fetchPrices(dateStr, market, resolution) {
  const params = new URLSearchParams({ market });
  if (dateStr) params.set("date", dateStr);
  if (RESOLUTION_TOGGLE_MARKETS.has(market)) params.set("resolution", resolution);
  return fetch(`/api/prices?${params}`).then((r) => r.json());
}

async function fetchAuctions(dateStr) {
  const params = dateStr ? `?date=${dateStr}` : "";
  return fetch(`/api/auctions${params}`).then((r) => r.json());
}

// auctions panel: status per auction for whatever date is currently on the map (dateStr comes
// straight from the resolved /api/prices date, see loadPrices/main below) - so paging back to
// an already-backfilled day shows e.g. 41/41 there, not always the live day's own status.
// requestId guards against a slower request finishing after a newer one - fast rapid-fire day
// switches used to risk the map settling on a superseded response instead of the last one
// actually requested, since responses aren't guaranteed to land in request order.
let auctionsRequestId = 0;

async function loadAuctions(dateStr) {
  const requestId = ++auctionsRequestId;
  const data = await fetchAuctions(dateStr);
  if (requestId !== auctionsRequestId) return;
  lastAuctionsData = data;
  renderAuctions();
}

function toggleAuctionsCollapsed() {
  auctionsCollapsed = !auctionsCollapsed;
  const btn = document.getElementById("auctions-toggle");
  btn.classList.toggle("collapsed", auctionsCollapsed);
  btn.setAttribute("aria-pressed", String(auctionsCollapsed));
  btn.title = auctionsCollapsed ? "Show all auctions" : "Show only selected auction";
  renderAuctions();
}

// auctions checked in the download panel - persisted across opens/closes within the session
// (not reset to just currentMarket every time), seeded with currentMarket only the first time
// the panel opens with nothing selected yet.
const selectedDownloadMarkets = new Set();

// renders the download panel's auction checkboxes, grouped the same way as the auctions panel
// (see AUCTION_GROUPS) - deliberately auction-only, no bidding-zone filter (considered and
// dropped as too fiddly for the gain, see project-overview.md).
function renderDownloadPanel() {
  let html = "";
  let lastGroup = null;
  for (const key of Object.keys(MARKET_LABELS)) {
    const group = AUCTION_GROUPS[key] || "";
    if (group !== lastGroup) {
      html += `<div class="auction-group-title${lastGroup ? " with-divider" : ""}">${group}</div>`;
      lastGroup = group;
    }
    html += `
      <label class="download-row">
        <input type="checkbox" value="${key}" ${selectedDownloadMarkets.has(key) ? "checked" : ""} />
        <span>${MARKET_LABELS[key]}</span>
      </label>
    `;
  }
  const list = document.getElementById("download-list");
  list.innerHTML = html;
  const confirmBtn = document.getElementById("download-confirm");
  list.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedDownloadMarkets.add(cb.value);
      else selectedDownloadMarkets.delete(cb.value);
      confirmBtn.disabled = selectedDownloadMarkets.size === 0;
    });
  });
  confirmBtn.disabled = selectedDownloadMarkets.size === 0;
}

// forceClose lets outside-click/Escape/after-download close the panel unconditionally,
// instead of toggling it back open when it's already closed.
function toggleDownloadPanel(forceClose = false) {
  const panel = document.getElementById("download-panel");
  const btn = document.getElementById("download-btn");
  const opening = panel.hidden && !forceClose;
  if (opening && selectedDownloadMarkets.size === 0) selectedDownloadMarkets.add(currentMarket);
  panel.hidden = !opening;
  btn.setAttribute("aria-expanded", String(opening));
  if (opening) renderDownloadPanel();
}

// plain navigation (not fetch+blob) - the response's Content-Disposition header (see app.py's
// /api/download) makes the browser download it directly instead of navigating away.
function downloadSelectedPrices() {
  const dateStr = document.getElementById("date-input").value;
  if (!selectedDownloadMarkets.size) return;
  const params = new URLSearchParams({ date: dateStr, markets: [...selectedDownloadMarkets].join(",") });
  window.location.href = `/api/download?${params}`;
  toggleDownloadPanel(true);
}

// hovering the tooltip itself counts as "still hovering the zone" - without this, moving the
// mouse from the shape onto the card fires the layer's mouseout and the card vanishes before
// you can actually reach it.
function cancelClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function scheduleClose() {
  cancelClose();
  closeTimer = setTimeout(() => {
    if (hoverTooltip) {
      map.removeLayer(hoverTooltip);
      hoverTooltip = null;
    }
  }, 150);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// EUR-only min/max for the day currently on screen, recomputed on every load/date change.
let priceRange = { min: 0, max: 0 };

function computePriceRange(priceByZone) {
  const prices = Object.values(priceByZone)
    .filter((z) => z.has_data && z.currency === SCALE_CURRENCY)
    .map((z) => z.avg_price);
  priceRange = prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: 0, max: 0 };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function priceToColor(price) {
  const span = priceRange.max - priceRange.min;
  const t = span > 0 ? Math.min(1, Math.max(0, (price - priceRange.min) / span)) : 0.5;
  const [c1, c2, localT] = t <= 0.5 ? [PRICE_LOW, PRICE_MID, t / 0.5] : [PRICE_MID, PRICE_HIGH, (t - 0.5) / 0.5];
  const rgb = c1.map((v, i) => Math.round(lerp(v, c2[i], localT)));
  return `rgb(${rgb.join(",")})`;
}

// in-scope zone, just no rows landed yet for this day ("pending") - low fillOpacity keeps it
// close to the map's own background so it doesn't compete for attention with priced zones,
// while still reading as the lighter/more "alive" of the two no-data greys (see
// notApplicableStyle below) - the closer a zone is to actually getting data, the more visually
// prominent its grey. shared by both views.
function noDataStyle() {
  return {
    fillColor: cssVar("--nodata-fill"), fillOpacity: 0.4,
    color: cssVar("--nodead-stroke"), weight: 1,
  };
}

// zone this market will never cover (e.g. GB/IE under SDAC, or every zone but 4 under IDA1) -
// reuses the context layer's own opaque grey rather than a dedicated third tier: a middle grey
// squeezed between noDataStyle and the context layer can't clear the dataviz skill's OKLab
// separation floor once actually composited over the context layer (which is what's really
// underneath every zone shape here, not the map's own background gradient) - for a narrow
// auction like IDA1 almost the whole map fell into this middle tier, so the collapse read as
// "every zone still pending" instead of "only these 4 zones matter". Reusing context-fill at its
// own established opacity passes cleanly and reads as "recedes into the map background", which
// fits - same fix as the imbalance dashboard's notScrapedStyle. Full opacity does blot out the
// grid lines under these zones rather than just tinting them, an accepted tradeoff there too.
function notApplicableStyle() {
  return {
    fillColor: cssVar("--context-fill"), fillOpacity: 1,
    color: cssVar("--context-stroke"), weight: 1,
  };
}

function priceZoneStyle(info, zoneCode) {
  if (!currentMarketZones.has(zoneCode)) return notApplicableStyle();
  if (info && info.has_data && info.currency === SCALE_CURRENCY) {
    const fill = priceToColor(info.avg_price);
    return { fillColor: fill, fillOpacity: FILL_OPACITY, color: fill, weight: 1 };
  }
  if (info && info.has_data) {
    // priced, but in a currency not on the EUR scale above - a deliberately distinct (not
    // green/amber/red, not the pending grey) treatment so it doesn't get misread as
    // either "cheap" or "no data".
    return { fillColor: cssVar("--noneur-fill"), fillOpacity: 0.85, color: cssVar("--noneur-stroke"), weight: 1 };
  }
  return noDataStyle();
}

// zone counts as fully "in" once at least one of its sources landed every settlement period
// expected for the day - a second, incomplete source doesn't drag a zone with one complete
// source back down to partial, consistent with the ≥1-live-source redundancy framing used
// everywhere else in this project (see project-overview.md Goal/Monitoring).
function zoneCoverage(info) {
  if (!info || !info.has_data) return "missing";
  return info.sources.some((s) => s.actual >= s.expected) ? "complete" : "partial";
}

function coverageZoneStyle(info, zoneCode) {
  if (!currentMarketZones.has(zoneCode)) return notApplicableStyle();
  const coverage = zoneCoverage(info);
  if (coverage === "missing") {
    // not yet expected (market hasn't cleared for this date) - stays neutral, same as prices
    // view's "pending" treatment, not a real gap.
    if (!marketCleared) return noDataStyle();
    const fill = cssVar("--data-bad"); // same as the auctions panel's "late" light
    return { fillColor: fill, fillOpacity: 0.55, color: fill, weight: 1 };
  }
  if (coverage === "complete") {
    const fill = cssVar("--data-good");
    return { fillColor: fill, fillOpacity: 0.4, color: fill, weight: 1 };
  }
  const fill = cssVar("--data-warn"); // same used for "partial" elsewhere (auction light, source dot)
  return { fillColor: fill, fillOpacity: 0.55, color: fill, weight: 1 };
}

function zoneStyle(info, zoneCode) {
  return currentView === "coverage" ? coverageZoneStyle(info, zoneCode) : priceZoneStyle(info, zoneCode);
}

function formatPrice(info) {
  if (!info || !info.has_data) return null;
  return `${info.avg_price.toFixed(1)} ${info.currency}/MWh`;
}

function zoneLabelHtml(zoneCode, info) {
  // a zone this market will never cover (see notApplicableStyle) gets no code label either -
  // the fill already reads as "ignore me" via --context-fill, and a code chip on top of that
  // undoes it by drawing the eye right back to the zone. currentMarketZones itself is dynamic
  // (get_market_zones() querying prod.prices, see app.py), not a hardcoded per-auction list, so
  // this follows whatever zones actually land data for the selected auction without a code change.
  if (!currentMarketZones.has(zoneCode)) return "";
  // coverage view is a quick have-we-got-it check, not a price readout - price stays hidden
  // there even when available, so the chip doesn't compete with the green/orange/grey fill.
  const price = currentView === "prices" ? formatPrice(info) : null;
  return `<div class="zone-chip"><span class="zone-code">${zoneCode}</span>${price ? `<span class="price">${price}</span>` : ""}</div>`;
}

// binds/unbinds the permanent zone-code label as needed, rather than a bare setTooltipContent -
// Leaflet's tooltip update skips a falsy content string (leaving whatever was last rendered on
// screen), so a not-applicable zone's empty zoneLabelHtml() would otherwise just freeze on
// whatever code/price it last showed instead of actually disappearing. Also handles a zone
// flipping the other way (not-applicable -> applicable, e.g. switching back to an auction that
// covers it), which needs a real bindTooltip, not a content update on a tooltip that no longer
// exists.
function updateZoneLabel(layer, zoneCode, info) {
  const html = zoneLabelHtml(zoneCode, info);
  if (!html) {
    if (layer.getTooltip()) layer.unbindTooltip();
    return;
  }
  if (layer.getTooltip()) {
    layer.setTooltipContent(html);
  } else {
    layer.bindTooltip(html, { permanent: true, direction: "center", className: "zone-label", interactive: false });
  }
}

function sourceBreakdownHtml(info) {
  return info.sources
    .map((s) => {
      const complete = s.actual >= s.expected;
      const dotColor = complete ? cssVar("--data-good-text") : cssVar("--data-warn-text");
      return `<tr>
        <td><span class="status-dot" style="background:${dotColor}"></span>${s.source} (${s.market})</td>
        <td>${s.actual}/${s.expected}</td>
        <td>${s.avg_price.toFixed(2)} ${info.currency}</td>
      </tr>`;
    })
    .join("");
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// "now" in the same timezone the backend's curve `time` labels use (Europe/Copenhagen, see
// dashboard/zones.py DELIVERY_DAY_TZ), not the viewer's own browser timezone.
function currentMinutesInDeliveryTz() {
  const hhmm = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit" });
  return timeToMinutes(hhmm);
}

// x-coordinate of "now" (current time-of-day) mapped onto this curve's own timeline - lines up
// with "this point in the day" regardless of which date is being viewed, so today's progress so
// far can be compared at a glance against the same point on a past day. Interpolates between the
// two periods either side of now (treating each period's value as sitting at its own midpoint,
// matching how the old dots were positioned); clamps to the near edge if now falls outside the
// curve's own range (e.g. a live day where the latest period lags a few minutes behind).
function nowLineX(points, xAt, stepX) {
  const nowMin = currentMinutesInDeliveryTz();
  const n = points.length;
  const mid = (i) => xAt(i) + stepX / 2;
  const minutesAt = (i) => timeToMinutes(points[i].time);
  if (n === 1 || nowMin <= minutesAt(0)) return mid(0);
  if (nowMin >= minutesAt(n - 1)) return mid(n - 1);
  for (let i = 0; i < n - 1; i++) {
    if (nowMin >= minutesAt(i) && nowMin < minutesAt(i + 1)) {
      const frac = (nowMin - minutesAt(i)) / (minutesAt(i + 1) - minutesAt(i));
      return mid(i) + frac * (mid(i + 1) - mid(i));
    }
  }
  return mid(n - 1);
}

// three evenly-spaced horizontal reference lines - hidden by default (see style.css), shown only
// in the expanded card where there's enough room for them to help read value/height without
// cluttering the small one.
function gridLinesSvg(W, H, PAD) {
  return [0.25, 0.5, 0.75]
    .map((f) => PAD + (H - PAD * 2) * f)
    .map((y) => `<line x1="${PAD}" y1="${y.toFixed(1)}" x2="${W - PAD}" y2="${y.toFixed(1)}" class="chart-grid-line" />`)
    .join("");
}

// value label for each gridline above (same fractions, same PAD/H math) - a gridline on its own
// only tells you "here's some reference height", not what it actually means. Overlaid with a
// small background chip rather than reserving an axis gutter - same technique as
// .chart-hover-label - so it stays legible over the line either way. Expanded-only, same as the
// gridlines it labels.
function gridLabelsHtml(H, PAD, lo, hi, formatFn) {
  const span = hi - lo || 1;
  return [0.25, 0.5, 0.75]
    .map((f) => {
      const value = hi - f * span;
      const topPct = ((PAD + (H - PAD * 2) * f) / H) * 100;
      return `<span class="chart-grid-label" style="top:${topPct.toFixed(1)}%">${formatFn(value)}</span>`;
    })
    .join("");
}

// a handful of evenly-spaced time labels along the bottom - orients the timeline the same way
// gridLabelsHtml orients the value axis. Own reserved-height row below the chart (not overlaid),
// so it doesn't compete with the line and doesn't require clipping. Expanded-only.
function xAxisLabelsHtml(points, xAt, stepX, W) {
  const n = points.length;
  return [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const idx = Math.min(n - 1, Math.round(f * (n - 1)));
      const leftPct = ((xAt(idx) + stepX / 2) / W) * 100;
      const align = f === 0 ? "translateX(0)" : f === 1 ? "translateX(-100%)" : "translateX(-50%)";
      return `<span class="chart-x-label" style="left:${leftPct.toFixed(1)}%;transform:${align}">${curveLabel(points[idx])}</span>`;
    })
    .join("");
}

// small tag naming the vertical "now" marker (see nowLineX) - the bare line is enough at a
// glance in the small card (shown there too), but a first-time viewer of the bigger expanded
// card benefits from the line actually saying what it is.
function nowLabelHtml(nowX, W) {
  const leftPct = (nowX / W) * 100;
  const align = leftPct < 15 ? "translateX(0)" : leftPct > 85 ? "translateX(-100%)" : "translateX(-50%)";
  return `<span class="chart-now-label" style="left:${leftPct.toFixed(1)}%;transform:${align}">now</span>`;
}

// step-after LINE chart (no area fill) - a fill would shade down to the chart's bottom edge,
// not to a meaningful zero baseline (the y-axis is scaled to the day's own min/max, like a stock
// chart, not forced to include zero), so it wouldn't measure a real quantity, just however high
// a price happens to sit in that day's own range. The line's single color already carries the
// value (see headlineColor at the call site).
function curveChartHtml(info, color) {
  if (!info.curve.length) return "";
  const W = 216, H = 56, PAD = 3;
  const prices = info.curve.map((p) => p.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const span = hi - lo || 1;
  // step-after line: each settlement period is a flat segment spanning its own width (like
  // Nordpool's day-ahead chart), not a diagonal between period-start points - a straight line
  // implies the price glides continuously within a period, which isn't the case.
  const n = info.curve.length;
  const stepX = (W - PAD * 2) / n;
  const xAt = (i) => PAD + i * stepX; // left edge of period i
  const yAt = (price) => PAD + (H - PAD * 2) * (1 - (price - lo) / span);

  let line = `M${xAt(0).toFixed(1)},${yAt(prices[0]).toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const xEnd = xAt(i + 1);
    line += ` L${xEnd.toFixed(1)},${yAt(prices[i]).toFixed(1)}`;
    if (i < n - 1) line += ` L${xEnd.toFixed(1)},${yAt(prices[i + 1]).toFixed(1)}`;
  }

  let zeroLine = "";
  if (lo < 0 && hi > 0) {
    const zy = PAD + (H - PAD * 2) * (1 - (0 - lo) / span);
    zeroLine = `<line x1="${PAD}" y1="${zy.toFixed(1)}" x2="${W - PAD}" y2="${zy.toFixed(1)}" class="chart-zero" />`;
  }

  const nowX = nowLineX(info.curve, xAt, stepX);

  return `
    <div class="curve-heading">Baseload curve &mdash; ${info.curve_source} &middot; ${displayTz.toUpperCase()}</div>
    <div class="chart-wrap">
      <svg class="curve-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${gridLinesSvg(W, H, PAD)}
        ${zeroLine}
        <path d="${line}" class="chart-line" style="stroke:${color}" />
        <line x1="${nowX.toFixed(1)}" y1="${PAD}" x2="${nowX.toFixed(1)}" y2="${H - PAD}" class="chart-now" />
      </svg>
      <div class="chart-hover-line"></div>
      <div class="chart-hover-label"></div>
      ${gridLabelsHtml(H, PAD, lo, hi, (v) => `${v.toFixed(1)} ${info.currency}`)}
      ${nowLabelHtml(nowX, W)}
    </div>
    <div class="chart-x-labels">${xAxisLabelsHtml(info.curve, xAt, stepX, W)}</div>
  `;
}

// crosshair + value label on hover - expanded view only. the compact card stays a plain,
// non-interactive glance; anyone wanting the per-period detail is expected to expand first.
// re-bound after every setContent() (the toggle button's expand/collapse replaces the DOM, old
// listeners go with it). period index comes from cursor x-position alone (no need to mirror
// curveChartHtml's y-axis price mapping) since the label only ever needs that period's own value.
function bindChartHover(root, info, expanded) {
  if (!expanded) return;
  const wrap = root.querySelector(".chart-wrap");
  if (!wrap || !info || !info.curve.length) return;
  const line = wrap.querySelector(".chart-hover-line");
  const label = wrap.querySelector(".chart-hover-label");
  const n = info.curve.length;

  wrap.addEventListener("mousemove", (e) => {
    const rect = wrap.getBoundingClientRect();
    const relX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const idx = Math.min(n - 1, Math.floor(relX * n));
    const point = info.curve[idx];
    const pct = ((idx + 0.5) / n) * 100;

    line.style.left = `${pct}%`;
    line.style.display = "block";

    label.textContent = `${curveLabel(point)} · ${point.price.toFixed(2)} ${info.currency}`;
    label.style.left = `${pct}%`;
    // clamp near the edges so the label doesn't spill outside the card.
    label.style.transform = pct < 8 ? "translateX(0)" : pct > 92 ? "translateX(-100%)" : "translateX(-50%)";
    label.style.display = "block";
  });

  wrap.addEventListener("mouseleave", () => {
    line.style.display = "none";
    label.style.display = "none";
  });
}

// corner-bracket "enter/exit fullscreen" glyphs (same visual language as Apple's own SF Symbols
// arrow.up.left.and.arrow.down.right / arrow.down.right.and.arrow.up.left) rather than the
// Unicode ⤡/⤢ glyphs previously used here, which render inconsistently across fonts/platforms.
const EXPAND_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10V4h6"/><path d="M20 14v6h-6"/></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4"/><path d="M15 20v-5h5"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

// keeps the hover card fully on-screen when the zone shape sits near the top of the map
// (most visible with the expanded panel, which is much taller) - tries the default above-anchor
// placement first, then flips below the anchor only if that placement would clip off the top of
// the map container. Always re-tries "top" first rather than remembering the last direction, so
// the card flips back once there's room again (e.g. after collapsing or panning).
function keepTooltipInView(map, tooltip) {
  const el = tooltip.getElement();
  if (!el) return;
  tooltip.options.direction = "top";
  tooltip.options.offset = L.point(0, -10);
  tooltip.update();
  const mapTop = map.getContainer().getBoundingClientRect().top;
  if (el.getBoundingClientRect().top < mapTop) {
    tooltip.options.direction = "bottom";
    tooltip.options.offset = L.point(0, 10);
    tooltip.update();
  }
}

function tooltipHtml(zoneCode, info, expanded) {
  const name = ZONE_NAMES[zoneCode] || "";
  const expandBtn = `<button class="expand-btn" aria-label="${expanded ? "Collapse" : "Expand"}" title="${expanded ? "Collapse" : "Expand"}">${expanded ? COLLAPSE_ICON : EXPAND_ICON}</button>`;
  // expanded only - the small card still closes on hover-out as before, so it doesn't need a
  // dedicated close button; this is the one-click way out of the expanded state specifically,
  // which no longer auto-closes on hover-out at all (see onEachFeature's mouseover handler).
  const closeBtn = expanded ? `<button class="close-btn" aria-label="Close" title="Close">${CLOSE_ICON}</button>` : "";
  const title = `<div class="zone-title">${zoneCode}<span class="zone-name">${name}</span>${expandBtn}${closeBtn}</div>`;
  if (!info || !info.has_data) {
    return `<div class="tooltip-inner">${title}<div class="empty-note">no ${MARKET_LABELS[currentMarket]} data yet</div></div>`;
  }
  const headlineColor = info.currency === SCALE_CURRENCY ? priceToColor(info.avg_price) : cssVar("--noneur-stroke");
  return `
    <div class="tooltip-inner">
      ${title}
      <div class="headline" style="color:${headlineColor}">${formatPrice(info)}<span class="headline-label">baseload</span></div>
      <table>${sourceBreakdownHtml(info)}</table>
      ${curveChartHtml(info, headlineColor)}
    </div>
  `;
}

function updateZone(zoneCode, layer, info) {
  layer._priceInfo = info; // read by the mouseover handler below, always the latest fetch
  layer.setStyle(zoneStyle(info, zoneCode));
  updateZoneLabel(layer, zoneCode, info);
}

function applyPrices(priceByZone, cleared, marketZones) {
  marketCleared = cleared;
  currentMarketZones = new Set(marketZones);
  computePriceRange(priceByZone);
  updateScaleLegend();
  updateCoverageScale(priceByZone);
  for (const [zoneCode, layer] of zoneLayers) {
    updateZone(zoneCode, layer, priceByZone[zoneCode]);
  }
}

// coverage view's header bar (replaces the price scale there, see index.html's #coverage-scale)
// - left-to-right fill is the share of in-scope zones that have any data at all for this
// market/date, green over a red track, purely illustrative (no counts) per request. Denominator
// is currentMarketZones, not every key in priceByZone - a market that only ever covers a handful
// of zones (e.g. N2EX, just GB) should be able to read 100%, not stall at a fraction because the
// other 40 zones it was never going to cover count against it.
function updateCoverageScale(priceByZone) {
  const fill = document.getElementById("coverage-bar-fill");
  if (!fill) return;
  const zones = [...currentMarketZones].map((zoneCode) => priceByZone[zoneCode]).filter(Boolean);
  const have = zones.filter((z) => z.has_data).length;
  fill.style.width = zones.length ? `${(have / zones.length) * 100}%` : "0%";
}

function updateScaleLegend() {
  const min = document.getElementById("scale-min");
  const max = document.getElementById("scale-max");
  if (!min || !max) return;
  const hasRange = priceRange.max > priceRange.min || (priceRange.min !== 0 && priceRange.max !== 0);
  min.textContent = hasRange ? `${priceRange.min.toFixed(0)}` : "–";
  max.textContent = hasRange ? `${priceRange.max.toFixed(0)} ${SCALE_CURRENCY}/MWh` : "–";
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "today" per the same Europe/Copenhagen anchor the backend's delivery-day math uses (see
// dashboard/zones.py DELIVERY_DAY_TZ), not the viewer's own browser timezone.
function todayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Copenhagen" });
}

function setDateInput(dateStr) {
  const dateInput = document.getElementById("date-input");
  dateInput.value = dateStr;
  dateInput.classList.toggle("is-today", dateStr === todayStr());
}

// requestId guards against a slower request finishing after a newer one - same race as
// loadAuctions' own guard, see its comment.
let pricesRequestId = 0;

async function loadPrices(dateStr) {
  const requestId = ++pricesRequestId;
  const market = currentMarket;
  const resolution = displayResolution;
  const dayPicker = document.querySelector(".day-picker");
  if (dayPicker) dayPicker.classList.add("is-loading");
  try {
    const prices = await fetchPrices(dateStr, market, resolution);
    if (requestId !== pricesRequestId) return;
    setDateInput(prices.date);
    applyPrices(prices.zones, prices.cleared, prices.market_zones);
    loadAuctions(prices.date);
  } finally {
    // only the still-current request clears it - an old, superseded request finishing (or
    // failing) after a newer one started must not wipe out the newer one's own loading state.
    if (requestId === pricesRequestId && dayPicker) dayPicker.classList.remove("is-loading");
  }
}

// grid.geojson is purely decorative (see project-overview.md) - fetched separately, after the
// interactive map is already up, so its ~2.5MB doesn't gate first paint on top of context/zones.
// Runs on its own pane (z-index between context and zones, see main()) so stacking stays correct
// no matter when this resolves relative to the rest of main()'s setup.
function loadGridLayer(map) {
  fetch("/static/geo/grid.geojson")
    .then((r) => r.json())
    .then((gridGeo) => {
      L.geoJSON(gridGeo, {
        interactive: false,
        pane: "grid-pane",
        renderer: L.canvas({ pane: "grid-pane" }),
        style: () => ({ color: cssVar("--grid-line"), weight: 0.6, opacity: 1 }),
      }).addTo(map);
    });
}

// Leaflet's built-in wheel zoom batches wheel deltas for ~40ms then jumps to a new
// (zoomSnap-rounded) level with a CSS-transition animation - each tick of a continuous
// scroll/trackpad gesture restarts that animation, which reads as a stepped, jumpy zoom no
// matter how fine zoomSnap/wheelPxPerZoomLevel are set (already tried: zoomSnap 0.25,
// wheelPxPerZoomLevel 100 - see the map init below, both still in place for double-click/button
// zoom). This replaces it with a continuous handler, same technique as the well-known
// Leaflet.SmoothWheelZoom plugin: each wheel event nudges a running "goal zoom", and a
// requestAnimationFrame loop eases the live view toward it every frame via Leaflet's own
// internal _move, instead of one discrete animated jump per debounce window. Registered instead
// of the built-in scrollWheelZoom handler (see map init: scrollWheelZoom: false), not alongside
// it - both fighting over the same wheel event would be worse than either alone.
L.Map.SmoothWheelZoom = L.Handler.extend({
  addHooks: function () {
    L.DomEvent.on(this._map.getContainer(), "wheel", this._onWheel, this);
  },
  removeHooks: function () {
    L.DomEvent.off(this._map.getContainer(), "wheel", this._onWheel, this);
  },
  _onWheel: function (e) {
    const map = this._map;
    if (!this._active) {
      this._active = true;
      map._stop();
      if (map._panAnim) map._panAnim.stop();
      this._centerPoint = map.getSize()._divideBy(2);
      this._wheelPoint = map.mouseEventToContainerPoint(e);
      this._wheelLatLng = map.containerPointToLatLng(this._wheelPoint);
      this._goalZoom = map.getZoom();
      this._prevCenter = map.getCenter();
      this._prevZoom = map.getZoom();
      this._moved = false;
      this._raf = requestAnimationFrame(() => this._step());
    }
    // clamp to min/max only, deliberately not map._limitZoom() - that also rounds to
    // options.zoomSnap (0.25, kept for button/double-click/keyboard zoom), which would re-quantize
    // this goal back to quarter-steps every tick and defeat the point of a continuous zoom.
    this._goalZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), this._goalZoom - e.deltaY * 0.003));
    this._wheelPoint = map.mouseEventToContainerPoint(e);
    clearTimeout(this._endTimer);
    this._endTimer = setTimeout(() => this._end(), 200);
    L.DomEvent.stop(e);
  },
  _step: function () {
    const map = this._map;
    // something else moved the map mid-gesture (e.g. the reset-view button) - bail rather than
    // fight it.
    if (!map.getCenter().equals(this._prevCenter) || map.getZoom() !== this._prevZoom) {
      this._active = false;
      return;
    }
    const zoom = Math.round((map.getZoom() + (this._goalZoom - map.getZoom()) * 0.3) * 100) / 100;
    const delta = this._wheelPoint.subtract(this._centerPoint);
    if (delta.x !== 0 || delta.y !== 0) {
      const center = map.unproject(map.project(this._wheelLatLng, zoom).subtract(delta), zoom);
      if (!this._moved) {
        map._moveStart(true, false);
        this._moved = true;
      }
      map._move(center, zoom);
      this._prevCenter = map.getCenter();
      this._prevZoom = map.getZoom();
    }
    this._raf = requestAnimationFrame(() => this._step());
  },
  _end: function () {
    this._active = false;
    cancelAnimationFrame(this._raf);
    if (this._moved) this._map._moveEnd(true);
  },
});

async function main() {
  const [contextGeo, zonesGeo, prices] = await Promise.all([
    fetch("/static/geo/context.geojson").then((r) => r.json()),
    fetch("/static/geo/zones.geojson").then((r) => r.json()),
    fetchPrices(undefined, currentMarket, displayResolution),
  ]);

  const priceByZone = prices.zones;
  marketCleared = prices.cleared;
  currentMarketZones = new Set(prices.market_zones);
  setDateInput(prices.date);
  loadAuctions(prices.date);
  computePriceRange(priceByZone);
  updateScaleLegend();
  updateCoverageScale(priceByZone);

  // zoomSnap/zoomDelta below 1 let button/double-click/keyboard zoom rest at quarter zoom levels
  // instead of only whole integers. Wheel zoom no longer goes through this at all - it's handled
  // separately below (scrollWheelZoom: false + SmoothWheelZoom), since no snap/delta tuning of
  // the built-in handler was enough to stop it feeling jumpy (see SmoothWheelZoom's own comment).
  // zoomControl is added separately, top-right, to leave the top-left corner free for the
  // auctions panel.
  map = L.map("map", {
    attributionControl: false, zoomControl: false, worldCopyJump: false, maxBoundsViscosity: 1.0,
    zoomSnap: 0.25, zoomDelta: 0.5, scrollWheelZoom: false,
  });
  map.addHandler("smoothWheelZoom", L.Map.SmoothWheelZoom);
  map.smoothWheelZoom.enable();
  const zoomControl = L.control.zoom({ position: "topright" }).addTo(map);

  // dedicated panes (below zones' default overlayPane, z-index 400) so the background layers
  // stack correctly (context < grid < zones) regardless of add order - needed because grid loads
  // asynchronously after everything else, see loadGridLayer.
  map.createPane("context-pane").style.zIndex = 200;
  map.createPane("grid-pane").style.zIndex = 300;

  // canvas renderer, not the default SVG - context/grid are non-interactive background layers
  // (215 and ~19k features respectively), and SVG would mean one <path> DOM node per feature.
  // Canvas draws them all onto a single element instead, far cheaper to parse/paint. Zones stays
  // on the default SVG renderer since it needs per-feature hover/tooltip interactivity.
  L.geoJSON(contextGeo, {
    interactive: false,
    pane: "context-pane",
    renderer: L.canvas({ pane: "context-pane" }),
    style: () => ({ fillColor: cssVar("--context-fill"), fillOpacity: 1, color: cssVar("--context-stroke"), weight: 1 }),
  }).addTo(map);

  const zonesLayer = L.geoJSON(zonesGeo, {
    style: (feature) => zoneStyle(priceByZone[feature.properties.bidding_zone], feature.properties.bidding_zone),
    onEachFeature: (feature, layer) => {
      const zoneCode = feature.properties.bidding_zone;
      layer._priceInfo = priceByZone[zoneCode];
      zoneLayers.set(zoneCode, layer);

      // Leaflet's own getCenter() (used to auto-position the permanent zone-code tooltip
      // below, direction: "center") only looks at a MultiPolygon's *first* sub-polygon - wrong
      // for zones split into mainland + island parts (FR/Corsica, FI/Aland), landing the label
      // on whichever part is listed first instead of the zone's main body. label_lat/label_lon
      // (build_geo.py's _label_point, largest-part representative_point) override it here.
      const { label_lat, label_lon } = feature.properties;
      if (label_lat != null && label_lon != null) {
        layer.getCenter = () => L.latLng(label_lat, label_lon);
      }

      updateZoneLabel(layer, zoneCode, layer._priceInfo);

      // a layer can have exactly one *bound* tooltip, so the permanent zone-code label uses
      // bindTooltip while the hover source-breakdown is a separate unbound L.tooltip we
      // add/move/remove by hand - two bindTooltip calls on the same layer would just replace
      // each other instead of coexisting.
      layer.on("mouseover", () => {
        // this market will never cover this zone (e.g. GB/IE under SDAC) - no hover card at
        // all, not even a "no data" one, since there's nothing pending to report.
        if (!currentMarketZones.has(zoneCode)) return;
        cancelClose();
        layer.setStyle({ weight: 2 });
        if (hoverTooltip) map.removeLayer(hoverTooltip);

        let expanded = false;
        // read by the separate mouseout handler below (bound once outside this closure, so it
        // can't see this `expanded` local directly) - expanded cards don't auto-close, so
        // mouseout needs to know the current state to decide whether to schedule one.
        layer._expanded = false;

        // anchored at the shape's center, not the cursor - a tooltip that chases the mouse
        // can never be clicked into (moving toward it just keeps moving it away).
        hoverTooltip = L.tooltip(layer.getBounds().getCenter(), {
          className: "source-tooltip", direction: "top", offset: [0, -10], interactive: true,
        })
          .setContent(tooltipHtml(zoneCode, layer._priceInfo, expanded))
          .addTo(map);
        // stable reference to *this* hover instance - `hoverTooltip` itself gets reassigned the
        // moment a different zone is hovered, so a deferred check below (which can still be
        // pending after that happens) needs a way to tell "am I still the current one?"
        const myTooltip = hoverTooltip;

        const el = hoverTooltip.getElement();
        if (el) {
          // interactive:true stops mouse/wheel events from passing through to the map (so the
          // expand button is actually clickable), which otherwise also lets the map itself
          // absorb the wheel event as a zoom - disableScrollPropagation stops that.
          L.DomEvent.disableScrollPropagation(el);
          L.DomEvent.disableClickPropagation(el);
          el.addEventListener("mouseenter", cancelClose);
          // collapsing (expanded -> small) shrinks the card in place around a fixed anchor,
          // which can leave the cursor outside the new, smaller box - some browsers (observed
          // in Chrome) resolve that layout change into a real `mouseleave` event even though the
          // mouse never actually moved. suppressLeaveClose blocks *this* listener from treating
          // that as a genuine hover-out right after a collapse (see the expand button's click
          // handler below, which re-checks real hover state once the mouse actually moves again
          // instead of trusting that event).
          let suppressLeaveClose = false;
          el.addEventListener("mouseleave", () => {
            // small card only - an expanded card is dismissed via its own button, not by the
            // mouse leaving it (see the expand button's click handler and the mouseout handler
            // below).
            if (!expanded && !suppressLeaveClose) scheduleClose();
          });
          keepTooltipInView(map, hoverTooltip);
          bindChartHover(el, layer._priceInfo, expanded);

          // setContent() replaces the button along with the rest of the markup, so the click
          // listener needs rebinding after every toggle, not just once. keepTooltipInView() has
          // to run before that rebinding, not after: it calls tooltip.update(), and Leaflet's
          // DivOverlay.update() unconditionally re-runs _updateContent() (innerHTML = content)
          // even though the content string hasn't changed - that silently recreates the button/
          // chart-wrap nodes and orphans whatever listeners were just bound to them.
          const bindExpandButton = () => {
            const btn = el.querySelector(".expand-btn");
            if (!btn) return;
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              expanded = !expanded;
              layer._expanded = expanded;
              el.classList.toggle("expanded", expanded);
              // setContent() triggers Leaflet's own reposition logic based on the new size, so
              // the card grows/shrinks in place instead of drifting off its anchor.
              hoverTooltip.setContent(tooltipHtml(zoneCode, layer._priceInfo, expanded));
              keepTooltipInView(map, hoverTooltip);
              bindExpandButton();
              bindCloseButton();
              bindChartHover(el, layer._priceInfo, expanded);
              if (!expanded) {
                // just collapsed to small - ignore any mouseleave for now (see above; it may
                // just be the resize, not a real hover-out). The mouse hasn't necessarily moved
                // at all yet either, so a fixed delay just closes it a moment later for the same
                // reason - wait for the user's *next actual movement* before deciding anything:
                // if they're still off the (now smaller) card by then, close it for real; if
                // they've settled back over it, hand control back to the normal listener above.
                cancelClose();
                suppressLeaveClose = true;
                document.addEventListener(
                  "mousemove",
                  () => {
                    suppressLeaveClose = false;
                    if (myTooltip === hoverTooltip && el && !el.matches(":hover")) scheduleClose();
                  },
                  { once: true }
                );
              }
            });
          };
          // same rebind-after-setContent need as bindExpandButton - the close button itself is
          // replaced along with the rest of the title row on every toggle.
          const bindCloseButton = () => {
            const btn = el.querySelector(".close-btn");
            if (!btn) return;
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              map.removeLayer(hoverTooltip);
              hoverTooltip = null;
            });
          };
          bindExpandButton();
          bindCloseButton();
        }
      });
      layer.on("mouseout", () => {
        layer.setStyle({ weight: 1 });
        // expanded card stays open regardless of the mouse leaving the zone shape - only its own
        // button (toggle back to small, or close entirely) dismisses it. Small card keeps the
        // existing hover-out-to-close behavior.
        if (!layer._expanded) scheduleClose();
      });
    },
  }).addTo(map);

  const europeBounds = zonesLayer.getBounds();
  // padding 30 (was 16) for a touch of extra default zoom-out, then panBy shifts the settled
  // view right so the now-taller auctions panel (12 auctions across 3 groups, docked top-left)
  // doesn't start out overlapping IE/GB. setMaxBounds below is derived from *this* shifted view
  // (map.getBounds(), not the raw europeBounds) - deriving it from the raw bounds instead would
  // re-clamp the view straight back to center, undoing the panBy the moment it's applied.
  map.fitBounds(europeBounds, { padding: [30, 30] });
  map.panBy([-80, 0], { animate: false });

  // lock the camera to "all of Europe" as the widest view and a generously padded version of
  // the shifted default view as the pan limit. context.geojson itself covers the whole world (so
  // panning shows real grey landmass, not empty background, if these limits are ever loosened) -
  // this restriction is purely about what's useful to look at, not a workaround for missing data.
  map.setMinZoom(map.getZoom());
  map.setMaxZoom(map.getZoom() + 6);
  map.setMaxBounds(map.getBounds().pad(0.25));
  window.addEventListener("resize", () => map.invalidateSize());

  // "reset view" button stacked above zoom in/out, inserted into the same Leaflet control bar
  // (not a separate control) so it picks up leaflet.css's own stacked-button borders/corner
  // rounding for free. Resets to the exact center/zoom the map settled on above (post
  // fitBounds+panBy+clamp), not a re-run of fitBounds - re-running fitBounds here would recompute
  // against zonesLayer's raw bounds and skip the panBy shift, landing on a different view than
  // what the user actually started on.
  const defaultCenter = map.getCenter();
  const defaultZoom = map.getZoom();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const resetLink = L.DomUtil.create("a", "leaflet-control-zoom-reset");
  resetLink.href = "#";
  resetLink.title = "Reset view";
  resetLink.setAttribute("role", "button");
  resetLink.setAttribute("aria-label", "Reset view");
  // four corner brackets ("viewfinder"/fit-to-frame icon) rather than a house - same corner-
  // bracket language as the hover card's own expand/collapse icons above, just closed into a
  // full frame instead of two opposing corners.
  resetLink.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V4h4"/><path d="M20 8V4h-4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/></svg>`;
  L.DomEvent.disableClickPropagation(resetLink);
  L.DomEvent.on(resetLink, "click", L.DomEvent.stop).on(resetLink, "click", () => {
    map.setView(defaultCenter, defaultZoom, { animate: !reduceMotion });
  });
  const zoomContainer = zoomControl.getContainer();
  zoomContainer.insertBefore(resetLink, zoomContainer.firstChild);

  const dateInput = document.getElementById("date-input");
  document.getElementById("prev-day").addEventListener("click", () => loadPrices(shiftDate(dateInput.value, -1)));
  document.getElementById("next-day").addEventListener("click", () => loadPrices(shiftDate(dateInput.value, 1)));
  dateInput.addEventListener("change", () => loadPrices(dateInput.value));

  document.querySelectorAll("#view-toggle .view-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectView(btn.dataset.view));
  });

  document.getElementById("auctions-toggle").addEventListener("click", toggleAuctionsCollapsed);

  document.querySelectorAll(".res-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.resolution) === displayResolution);
    btn.addEventListener("click", () => setResolution(Number(btn.dataset.resolution)));
  });

  document.querySelectorAll(".tz-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tz === displayTz);
    btn.addEventListener("click", () => setDisplayTz(btn.dataset.tz));
  });

  syncThemeToggleUI();
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice));
  });
  // an override made on another tab (or the OS setting itself) changing while this tab is open -
  // only matters when there's no explicit override here, mirroring the CSS media query's own
  // :not([data-theme="light"]) guard.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.getAttribute("data-theme")) {
      refreshPriceRampColors();
      repaintZones();
      syncThemeToggleUI();
    }
  });

  document.getElementById("download-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDownloadPanel();
  });
  document.getElementById("download-confirm").addEventListener("click", downloadSelectedPrices);
  document.addEventListener("click", (e) => {
    if (!document.getElementById("download-menu").contains(e.target)) toggleDownloadPanel(true);
  });

  const loader = document.getElementById("loader");
  if (loader) {
    loader.classList.add("hidden");
    setTimeout(() => loader.remove(), 300);
  }

  loadGridLayer(map);
}

main();
