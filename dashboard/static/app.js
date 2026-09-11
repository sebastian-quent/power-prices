const FILL_OPACITY = 0.62;

function hexToRgb(hex) {
  const m = hex.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

// price -> color, green (cheap) through amber to red (expensive), normalized per-day against
// that day's own min/max. Read from CSS (--data-good/-warn/-bad), not duplicated as hardcoded
// RGB, so the map and the header scale never drift apart. `let` since light/dark values differ
// and the theme toggle re-reads these after flipping data-theme.
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

// reflects the current effective theme onto #theme-toggle's Light/Dark pill.
function syncThemeToggleUI() {
  const current = effectiveTheme();
  document.querySelectorAll(".theme-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.themeChoice === current));
}

// sets an explicit theme override, persisted for index.html's inline head script to pick up
// on the next load.
function setTheme(choice) {
  if (choice === effectiveTheme()) return;
  document.documentElement.setAttribute("data-theme", choice);
  localStorage.setItem("theme", choice);
  refreshPriceRampColors();
  repaintZones();
  syncThemeToggleUI();
  // an open hover card's curve chart draws its stroke color once at open time - simpler to
  // close it than re-draw in place; it reopens with the new theme's colors on next hover.
  if (hoverTooltip) {
    map.removeLayer(hoverTooltip);
    hoverTooltip = null;
  }
}

// only zones actually priced in EUR feed the price-intensity scale - only GB (N2EX/GbHalfHour)
// lands in GBP among in-scope zones. No FX conversion anywhere in this repo, so a non-EUR price
// must be excluded from the scale rather than silently compared against EUR values.
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

// mirrors app.py's MARKET_OPTIONS keys - only the startup default; selectMarket() carries the
// currently selected date through instead of resetting to each market's own default.
let currentMarket = "sdac";

// "prices" (default) is the existing green->red price-intensity map; "coverage" is a quick
// have-we-got-it-at-all overview - same map/zones/data, no extra API call, just a different
// zoneStyle()/label reading of whatever /api/prices already returned (see selectView below).
let currentView = "prices";

// whether the selected market has cleared for the selected date (app.py's `cleared` field) - a
// coverage-view zone with no data reads "missing" (red) once true, "not published yet" before.
let marketCleared = true;

// zones the *currently selected market* can ever cover (app.py's `market_zones`) - distinct
// from the full 41-zone IN_SCOPE_ZONES `priceByZone` always covers. A zone outside this set is
// styled "not applicable" rather than "no data yet".
let currentMarketZones = new Set();

// which timezone the price-curve hover card's labels use ("cet" = Europe/Copenhagen, matching
// zones.py's DELIVERY_DAY_TZ; "utc" reads the curve's own `time_utc`) - label-formatting only:
// nowLineX/timeToMinutes always position the "now" line using the Copenhagen `time` field,
// since UTC labels for a Copenhagen calendar day wrap around UTC midnight (non-monotonic),
// which would break that interpolation.
let displayTz = localStorage.getItem("displayTz") === "utc" ? "utc" : "cet";

function curveLabel(point) {
  return displayTz === "utc" ? point.time_utc : point.time;
}

// markets that scrape both 15min and 60min VWAP rows (mirrors app.py's VWAP_MARKETS) - the
// resolution toggle only ever applies to these, hidden the rest of the time (see selectMarket).
const RESOLUTION_TOGGLE_MARKETS = new Set(["id1", "id3", "idfull"]);

// which settlement resolution VWAP markets fetch at, defaults to 15min. Unlike setDisplayTz,
// this changes which data is fetched, so it triggers a reload rather than just a repaint.
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
  // close rather than re-render in place - expanded/info are held in the mouseover handler's
  // own closure, not accessible here.
  if (hoverTooltip) {
    map.removeLayer(hoverTooltip);
    hoverTooltip = null;
  }
}

// whether the auctions panel is collapsed to just the selected auction. Cached alongside the
// last /api/auctions response so toggling re-renders instantly without a re-fetch.
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
  // only visible for the VWAP markets (see RESOLUTION_TOGGLE_MARKETS).
  document.getElementById("resolution-toggle").hidden = !RESOLUTION_TOGGLE_MARKETS.has(market);
  // the date picker is the source of truth once loaded - switching auctions must not jump the
  // date back to that auction's own default.
  await loadPrices(document.getElementById("date-input").value);
  // currentMarketZones is only known once loadPrices' response lands, so the camera fit waits
  // for that - a narrow market (e.g. IDA1) zooms in on its zones instead of the previous market's
  // zoom level.
  focusMarketZones();
}

// fits the camera to just the zones the current market covers. Does not touch
// minZoom/maxZoom/maxBounds, so panning back out to the full map still works either way.
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
  // extra left padding for the auctions panel, docked top-left over the map - otherwise a
  // tight zoom (e.g. a single-zone auction) would land straight underneath it.
  map.flyToBounds(bounds, {
    paddingTopLeft: [300, 140],
    paddingBottomRight: [140, 140],
    animate: !reduceMotion,
    duration: 0.6,
  });
}

// re-applies zoneStyle()/zoneLabelHtml() to every rendered zone layer without a new fetch -
// shared by selectView and the theme toggle.
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
  // group headers (Day-ahead / IDA / VWAP), skipped in collapsed view (redundant with one row).
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

// deliberately no response caching or prefetching - a rescrape can change an already-published
// day's price at any time, and a stale value not showing up matters more than saving a
// round-trip. Every load/switch always hits the backend live.
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

// auctions panel: status per auction for whatever date is currently on the map, so paging back
// to an already-backfilled day shows its own status, not the live day's. requestId guards
// against a slower request finishing after a newer one, since responses can land out of order.
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

// auctions checked in the download panel - persisted across opens/closes within the session,
// seeded with currentMarket only the first time the panel opens with nothing selected.
const selectedDownloadMarkets = new Set();

// renders the download panel's auction checkboxes - deliberately auction-only, no
// bidding-zone filter.
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

// in-scope zone, just no rows landed yet for this day ("pending") - lighter grey than
// notApplicableStyle, reads as more "alive"/closer to getting data. Shared by both views.
function noDataStyle() {
  return {
    fillColor: cssVar("--nodata-fill"), fillOpacity: 0.4,
    color: cssVar("--nodead-stroke"), weight: 1,
  };
}

// zone this market will never cover (e.g. GB/IE under SDAC) - reuses the context layer's own
// opaque grey rather than a dedicated third tier, which couldn't clear the dataviz skill's
// contrast floor against the pending grey once actually composited. Also blots out the grid
// lines under these zones (accepted tradeoff).
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

// zone counts as fully "in" once at least one of its sources landed every expected period for
// the day - a second, incomplete source doesn't drag a complete zone back down to partial.
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
  // a zone this market will never cover gets no code label either - a chip on top of the
  // recessive fill would draw the eye right back to a zone meant to be ignored.
  if (!currentMarketZones.has(zoneCode)) return "";
  // coverage view is a quick have-we-got-it check, not a price readout - price stays hidden
  // there even when available, so the chip doesn't compete with the green/orange/grey fill.
  const price = currentView === "prices" ? formatPrice(info) : null;
  return `<div class="zone-chip"><span class="zone-code">${zoneCode}</span>${price ? `<span class="price">${price}</span>` : ""}</div>`;
}

// binds/unbinds the permanent zone-code label as needed, rather than a bare setTooltipContent -
// Leaflet's tooltip update skips a falsy content string, so an empty zoneLabelHtml() would
// otherwise freeze on whatever it last showed instead of disappearing.
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

// x-coordinate of "now" mapped onto this curve's own timeline, so today's progress lines up
// with the same point on a past day. Interpolates between the two periods either side of now,
// clamped to the near edge if now falls outside the curve's own range.
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

// three evenly-spaced horizontal reference lines, expanded-card only (no room in the small one).
function gridLinesSvg(W, H, PAD) {
  return [0.25, 0.5, 0.75]
    .map((f) => PAD + (H - PAD * 2) * f)
    .map((y) => `<line x1="${PAD}" y1="${y.toFixed(1)}" x2="${W - PAD}" y2="${y.toFixed(1)}" class="chart-grid-line" />`)
    .join("");
}

// value label for each gridline above, overlaid as a small chip rather than a reserved axis
// gutter. Expanded-only, same as the gridlines it labels.
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

// evenly-spaced time labels along the bottom, own reserved row so they don't overlap the line.
// Expanded-only.
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

// small tag naming the vertical "now" marker (see nowLineX).
function nowLabelHtml(nowX, W) {
  const leftPct = (nowX / W) * 100;
  const align = leftPct < 15 ? "translateX(0)" : leftPct > 85 ? "translateX(-100%)" : "translateX(-50%)";
  return `<span class="chart-now-label" style="left:${leftPct.toFixed(1)}%;transform:${align}">now</span>`;
}

// step-after LINE chart, no area fill - the y-axis is scaled to the day's own min/max (not
// forced to include zero), so a fill down to the chart edge wouldn't measure a real quantity.
function curveChartHtml(info, color) {
  if (!info.curve.length) return "";
  const W = 216, H = 56, PAD = 3;
  const prices = info.curve.map((p) => p.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const span = hi - lo || 1;
  // each settlement period is a flat segment, not a diagonal - price doesn't glide within a period.
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

// crosshair + value label on hover, expanded view only. Re-bound after every setContent() since
// expand/collapse replaces the DOM. Period index comes from cursor x-position alone.
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

// corner-bracket "enter/exit fullscreen" glyphs (SF Symbols style, not Unicode ⤡/⤢ which render
// inconsistently across fonts).
const EXPAND_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10V4h6"/><path d="M20 14v6h-6"/></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4"/><path d="M15 20v-5h5"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

// keeps the hover card on-screen when it would clip the top of the map - tries "top" placement
// first (always, not remembering the last direction), flips to "bottom" only if that clips.
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
  // expanded only - the small card closes on hover-out, but the expanded one no longer does.
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

// coverage view's header bar - share of zones with any data, illustrative only (no counts).
// Denominator is currentMarketZones, not every key in priceByZone, so a narrow market like N2EX
// can read 100% instead of being dragged down by zones it never covers.
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

// grid.geojson is purely decorative - fetched after the map is already up so its ~2.5MB doesn't
// gate first paint. Own pane (z-index between context and zones) keeps stacking correct
// regardless of load order.
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

// Leaflet's built-in wheel zoom batches deltas then jumps to a new zoomSnap-rounded level,
// which reads as stepped/jumpy on a continuous scroll gesture. This replaces it with a
// continuous handler (same technique as Leaflet.SmoothWheelZoom): each wheel event nudges a
// running "goal zoom", eased toward every frame via Leaflet's own internal _move. Registered
// instead of the built-in scrollWheelZoom handler (map init: scrollWheelZoom: false), not
// alongside it.
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
    // clamp to min/max only, not map._limitZoom() - that also rounds to zoomSnap, which would
    // re-quantize this goal every tick and defeat the point of a continuous zoom.
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

  // zoomSnap/zoomDelta below 1 let button/double-click/keyboard zoom rest at quarter levels.
  // Wheel zoom is handled separately (scrollWheelZoom: false + SmoothWheelZoom below).
  // zoomControl is added separately, top-right, to leave top-left free for the auctions panel.
  map = L.map("map", {
    attributionControl: false, zoomControl: false, worldCopyJump: false, maxBoundsViscosity: 1.0,
    zoomSnap: 0.25, zoomDelta: 0.5, scrollWheelZoom: false,
  });
  map.addHandler("smoothWheelZoom", L.Map.SmoothWheelZoom);
  map.smoothWheelZoom.enable();
  const zoomControl = L.control.zoom({ position: "topright" }).addTo(map);

  // dedicated panes (below zones' default overlayPane, z-index 400) so context < grid < zones
  // stacks correctly regardless of add order - grid loads async, after everything else.
  map.createPane("context-pane").style.zIndex = 200;
  map.createPane("grid-pane").style.zIndex = 300;

  // canvas renderer for these non-interactive background layers (SVG would mean one DOM node
  // per feature - grid alone is ~19k). Zones stays on SVG since it needs per-feature hover.
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

      // Leaflet's own getCenter() only looks at a MultiPolygon's first sub-polygon - wrong for
      // zones split into mainland + island parts (FR/Corsica). label_lat/label_lon (build_geo.py's
      // largest-part point) override it here.
      const { label_lat, label_lon } = feature.properties;
      if (label_lat != null && label_lon != null) {
        layer.getCenter = () => L.latLng(label_lat, label_lon);
      }

      updateZoneLabel(layer, zoneCode, layer._priceInfo);

      // a layer can have exactly one *bound* tooltip, so the permanent zone-code label uses
      // bindTooltip while the hover source-breakdown is a separate unbound L.tooltip.
      layer.on("mouseover", () => {
        // this market will never cover this zone - no hover card at all, not even "no data".
        if (!currentMarketZones.has(zoneCode)) return;
        cancelClose();
        layer.setStyle({ weight: 2 });
        if (hoverTooltip) map.removeLayer(hoverTooltip);

        let expanded = false;
        // read by the mouseout handler below, bound outside this closure - expanded cards
        // don't auto-close, so mouseout needs to know the current state.
        layer._expanded = false;

        // anchored at the shape's center, not the cursor - a tooltip that chases the mouse
        // can never be clicked into.
        hoverTooltip = L.tooltip(layer.getBounds().getCenter(), {
          className: "source-tooltip", direction: "top", offset: [0, -10], interactive: true,
        })
          .setContent(tooltipHtml(zoneCode, layer._priceInfo, expanded))
          .addTo(map);
        // stable reference to *this* hover instance, since `hoverTooltip` gets reassigned the
        // moment a different zone is hovered.
        const myTooltip = hoverTooltip;

        const el = hoverTooltip.getElement();
        if (el) {
          // interactive:true stops the map from absorbing wheel/click events meant for the
          // card's own buttons/chart.
          L.DomEvent.disableScrollPropagation(el);
          L.DomEvent.disableClickPropagation(el);
          el.addEventListener("mouseenter", cancelClose);
          // collapsing the card can leave the cursor outside the new, smaller box, which some
          // browsers resolve into a spurious mouseleave - suppressLeaveClose blocks that (see
          // the expand button's click handler below, which re-checks real hover state instead).
          let suppressLeaveClose = false;
          el.addEventListener("mouseleave", () => {
            // small card only - an expanded card is dismissed via its own button.
            if (!expanded && !suppressLeaveClose) scheduleClose();
          });
          keepTooltipInView(map, hoverTooltip);
          bindChartHover(el, layer._priceInfo, expanded);

          // rebind after every toggle since setContent() replaces the button along with the
          // rest of the markup. keepTooltipInView() must run before this rebind, not after -
          // its tooltip.update() call unconditionally re-runs Leaflet's _updateContent(),
          // which recreates these nodes and would orphan whatever was just bound to them.
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
                // just collapsed to small - the resize itself may trigger a spurious mouseleave,
                // so wait for the user's next actual mouse movement before deciding to close.
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
          // same rebind-after-setContent need as bindExpandButton.
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
        // expanded card stays open on mouse-out - only its own button dismisses it.
        if (!layer._expanded) scheduleClose();
      });
    },
  }).addTo(map);

  const europeBounds = zonesLayer.getBounds();
  // panBy shifts the settled view right so the auctions panel (docked top-left) doesn't start
  // out overlapping IE/GB. setMaxBounds below derives from this shifted view (map.getBounds()),
  // not the raw europeBounds, or the clamp would undo the panBy immediately.
  map.fitBounds(europeBounds, { padding: [30, 30] });
  map.panBy([-80, 0], { animate: false });

  // lock the camera to "all of Europe" as the widest view, generously padded, as the pan limit.
  map.setMinZoom(map.getZoom());
  map.setMaxZoom(map.getZoom() + 6);
  map.setMaxBounds(map.getBounds().pad(0.25));
  window.addEventListener("resize", () => map.invalidateSize());

  // "reset view" button inserted into the same Leaflet control bar as zoom in/out. Resets to the
  // exact center/zoom the map settled on above, not a re-run of fitBounds (which would skip the
  // panBy shift).
  const defaultCenter = map.getCenter();
  const defaultZoom = map.getZoom();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const resetLink = L.DomUtil.create("a", "leaflet-control-zoom-reset");
  resetLink.href = "#";
  resetLink.title = "Reset view";
  resetLink.setAttribute("role", "button");
  resetLink.setAttribute("aria-label", "Reset view");
  // four corner brackets (viewfinder icon), same visual language as the hover card's icons.
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
  // OS setting changing while this tab is open - only matters with no explicit override here.
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
