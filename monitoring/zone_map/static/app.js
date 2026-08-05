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
const PRICE_LOW = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-good"));
const PRICE_MID = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-warn"));
const PRICE_HIGH = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue("--data-bad"));

// only zones actually priced in EUR feed the price-intensity scale. in practice that's every
// SDAC/SEM_DA zone (including CH and the Nordics, whose day-ahead auction clears in EUR even
// though their retail currency isn't) - only GB (its own N2EX/GbHalfHour auctions, not SDAC)
// lands in GBP. there's no FX conversion anywhere in this repo (see project-overview.md), so
// mixing a non-EUR price into the same 0-1 scale as EUR zones would silently compare unrelated
// units instead of just excluding the rare zone that isn't on this scale.
const SCALE_CURRENCY = "EUR";

// display names for the hover card only - map/API both key everything by the plain
// bidding_zone code (see monitoring/zone_map/zones.py IN_SCOPE_ZONES).
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
  sdac: "SDAC", n2ex: "N2EX", epex_gb_hourly: "EPEX GB Hourly", gb_hh: "GB HalfHourly",
  epex_gb_hh: "EPEX GB HalfHourly", sem_da: "SEM-DA",
  ida1: "IDA1", ida2: "IDA2", ida3: "IDA3", id1: "ID1", id3: "ID3", idfull: "IDFULL",
};

// groups the auctions panel into Day-ahead / IDA / VWAP sections - purely a rendering grouping
// (see loadAuctions), mirrors app.py's MARKET_OPTIONS ordering rather than driving it.
const AUCTION_GROUPS = {
  sdac: "Day-ahead", n2ex: "Day-ahead", epex_gb_hourly: "Day-ahead", gb_hh: "Day-ahead",
  epex_gb_hh: "Day-ahead", sem_da: "Day-ahead",
  ida1: "IDA", ida2: "IDA", ida3: "IDA", id1: "VWAP", id3: "VWAP", idfull: "VWAP",
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
  // asymmetric padding, not a flat [40,40] - the auctions panel is docked top-left over the
  // map itself (see index.html), so a tight zoom (e.g. IDA1's single BE polygon today) would
  // otherwise land straight underneath it. Left/top gets extra room for the panel; the other
  // two edges keep an ordinary margin.
  map.flyToBounds(bounds, { paddingTopLeft: [300, 40], paddingBottomRight: [40, 40], animate: !reduceMotion });
}

// switching view is purely a re-render of whatever /api/prices already returned - no new fetch,
// since coverage just reads the same has_data/sources fields the price view already has.
function selectView(view) {
  if (view === currentView) return;
  currentView = view;
  document.querySelectorAll(".view-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  document.getElementById("page-title").textContent = view === "coverage" ? "COVERAGE" : "PRICES";
  document.getElementById("price-scale").hidden = view !== "prices";
  document.getElementById("coverage-scale").hidden = view !== "coverage";
  for (const [zoneCode, layer] of zoneLayers) {
    layer.setStyle(zoneStyle(layer._priceInfo, zoneCode));
    layer.setTooltipContent(zoneLabelHtml(zoneCode, layer._priceInfo));
  }
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

// auctions panel: status per auction for whatever date is currently on the map (dateStr comes
// straight from the resolved /api/prices date, see loadPrices/main below) - so paging back to
// an already-backfilled day shows e.g. 41/41 there, not always the live day's own status.
async function loadAuctions(dateStr) {
  const params = dateStr ? `?date=${dateStr}` : "";
  lastAuctionsData = await fetch(`/api/auctions${params}`).then((r) => r.json());
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
// while still reading as the lightest/most "alive" of the three no-data greys (see
// notApplicableStyle and the context layer below) - the closer a zone is to actually getting
// data, the more visually prominent its grey. shared by both views.
function noDataStyle() {
  return {
    fillColor: cssVar("--nodata-fill"), fillOpacity: 0.4,
    color: cssVar("--nodead-stroke"), weight: 1,
  };
}

// zone this market will never cover (e.g. GB/IE under SDAC) - not "pending", not a gap, but
// still distinct from the context layer's "never in scope at all" grey (e.g. Russia): both mean
// "no data here", but one is a real bidding zone just outside this particular auction, the other
// isn't tracked at all. Unlike the context layer itself (bottom of the stack, grid drawn on top
// of it), these zone shapes sit above the grid line layer - full opacity here would blot out the
// grid lines under this zone instead of just tinting them, looking like a hole punched in the
// map. Partial opacity keeps the same muted look while letting the grid show through. shared by
// both views.
function notApplicableStyle() {
  return {
    fillColor: cssVar("--notapplicable-fill"), fillOpacity: 0.55,
    color: cssVar("--notapplicable-stroke"), weight: 1,
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
  // coverage view is a quick have-we-got-it check, not a price readout - price stays hidden
  // there even when available, so the chip doesn't compete with the green/orange/grey fill.
  const price = currentView === "prices" ? formatPrice(info) : null;
  return `<div class="zone-chip"><span class="zone-code">${zoneCode}</span>${price ? `<span class="price">${price}</span>` : ""}</div>`;
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

function curveChartHtml(info) {
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
  const area = `${line} L${xAt(n).toFixed(1)},${H - PAD} L${xAt(0).toFixed(1)},${H - PAD} Z`;

  let zeroLine = "";
  if (lo < 0 && hi > 0) {
    const zy = PAD + (H - PAD * 2) * (1 - (0 - lo) / span);
    zeroLine = `<line x1="${PAD}" y1="${zy.toFixed(1)}" x2="${W - PAD}" y2="${zy.toFixed(1)}" class="chart-zero" />`;
  }

  const maxIdx = prices.indexOf(hi);
  const minIdx = prices.indexOf(lo);
  // dot sits mid-way across the period's flat segment, not at its leading edge.
  const dot = (i) => `<circle class="chart-dot" cx="${(xAt(i) + stepX / 2).toFixed(1)}" cy="${yAt(prices[i]).toFixed(1)}" r="2.2" />`;

  return `
    <div class="curve-heading">Baseload curve &mdash; ${info.curve_source}</div>
    <div class="chart-wrap">
      <svg class="curve-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="fill-${info.curve_source.replace(/\W/g, "")}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" class="chart-fill-a" />
            <stop offset="100%" class="chart-fill-b" />
          </linearGradient>
        </defs>
        ${zeroLine}
        <path d="${area}" fill="url(#fill-${info.curve_source.replace(/\W/g, "")})" />
        <path d="${line}" class="chart-line" />
        ${dot(maxIdx)}${dot(minIdx)}
      </svg>
      <div class="chart-hover-line"></div>
      <div class="chart-hover-label"></div>
    </div>
    <div class="chart-minmax">
      <span>${info.curve[minIdx].time} &middot; ${lo.toFixed(1)} ${info.currency}</span>
      <span>${info.curve[maxIdx].time} &middot; ${hi.toFixed(1)} ${info.currency}</span>
    </div>
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

    label.textContent = `${point.time} · ${point.price.toFixed(2)} ${info.currency}`;
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

function tooltipHtml(zoneCode, info, expanded) {
  const name = ZONE_NAMES[zoneCode] || "";
  const expandBtn = `<button class="expand-btn" aria-label="${expanded ? "Collapse" : "Expand"}" title="${expanded ? "Collapse" : "Expand"}">${expanded ? COLLAPSE_ICON : EXPAND_ICON}</button>`;
  const title = `<div class="zone-title">${zoneCode}<span class="zone-name">${name}</span>${expandBtn}</div>`;
  if (!info || !info.has_data) {
    return `<div class="tooltip-inner">${title}<div class="empty-note">no ${MARKET_LABELS[currentMarket]} data yet</div></div>`;
  }
  const headlineColor = info.currency === SCALE_CURRENCY ? priceToColor(info.avg_price) : cssVar("--noneur-stroke");
  return `
    <div class="tooltip-inner">
      ${title}
      <div class="headline" style="color:${headlineColor}">${formatPrice(info)}<span class="headline-label">baseload</span></div>
      <table>${sourceBreakdownHtml(info)}</table>
      ${curveChartHtml(info)}
    </div>
  `;
}

function updateZone(zoneCode, layer, info) {
  layer._priceInfo = info; // read by the mouseover handler below, always the latest fetch
  layer.setStyle(zoneStyle(info, zoneCode));
  layer.setTooltipContent(zoneLabelHtml(zoneCode, info));
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
// monitoring/zone_map/zones.py DELIVERY_DAY_TZ), not the viewer's own browser timezone.
function todayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Copenhagen" });
}

function setDateInput(dateStr) {
  const dateInput = document.getElementById("date-input");
  dateInput.value = dateStr;
  dateInput.classList.toggle("is-today", dateStr === todayStr());
}

async function loadPrices(dateStr) {
  const params = new URLSearchParams({ market: currentMarket });
  if (dateStr) params.set("date", dateStr);
  const prices = await fetch(`/api/prices?${params}`).then((r) => r.json());
  setDateInput(prices.date);
  applyPrices(prices.zones, prices.cleared, prices.market_zones);
  loadAuctions(prices.date);
}

async function main() {
  const [contextGeo, gridGeo, zonesGeo, prices] = await Promise.all([
    fetch("/static/geo/context.geojson").then((r) => r.json()),
    fetch("/static/geo/grid.geojson").then((r) => r.json()),
    fetch("/static/geo/zones.geojson").then((r) => r.json()),
    fetch(`/api/prices?market=${currentMarket}`).then((r) => r.json()),
  ]);

  const priceByZone = prices.zones;
  marketCleared = prices.cleared;
  currentMarketZones = new Set(prices.market_zones);
  setDateInput(prices.date);
  loadAuctions(prices.date);
  computePriceRange(priceByZone);
  updateScaleLegend();
  updateCoverageScale(priceByZone);

  // zoomSnap/zoomDelta below 1 let the map rest at quarter zoom levels instead of only whole
  // integers - Leaflet's default (zoomSnap: 1) is what makes wheel-zoom feel stepped/jumpy,
  // since every scroll tick has to commit to a full level; a smaller snap lets it ease in
  // continuously instead. zoomControl is added separately, top-right, to leave the top-left
  // corner free for the auctions panel.
  map = L.map("map", {
    attributionControl: true, zoomControl: false, worldCopyJump: false, maxBoundsViscosity: 1.0,
    zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 100,
  });
  const zoomControl = L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix(false);

  L.geoJSON(contextGeo, {
    interactive: false,
    attribution: "Natural Earth",
    style: () => ({ fillColor: cssVar("--context-fill"), fillOpacity: 1, color: cssVar("--context-stroke"), weight: 1 }),
  }).addTo(map);

  // faint, purely decorative - not meant to be noticed at a glance (see project-overview.md).
  // real attribution matters here though: ODbL requires it for the produced map, not just the
  // license name in a code comment.
  L.geoJSON(gridGeo, {
    interactive: false,
    attribution: "Grid: &copy; OpenStreetMap contributors, via GridKit (ODbL)",
    style: () => ({ color: cssVar("--grid-line"), weight: 0.6, opacity: 1 }),
  }).addTo(map);

  const zonesLayer = L.geoJSON(zonesGeo, {
    attribution: "Zones: EnergieID/entsoe-py",
    style: (feature) => zoneStyle(priceByZone[feature.properties.bidding_zone], feature.properties.bidding_zone),
    onEachFeature: (feature, layer) => {
      const zoneCode = feature.properties.bidding_zone;
      layer._priceInfo = priceByZone[zoneCode];
      zoneLayers.set(zoneCode, layer);

      layer.bindTooltip(zoneLabelHtml(zoneCode, layer._priceInfo), {
        permanent: true, direction: "center", className: "zone-label", interactive: false,
      });

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

        // anchored at the shape's center, not the cursor - a tooltip that chases the mouse
        // can never be clicked into (moving toward it just keeps moving it away).
        hoverTooltip = L.tooltip(layer.getBounds().getCenter(), {
          className: "source-tooltip", direction: "top", offset: [0, -10], interactive: true,
        })
          .setContent(tooltipHtml(zoneCode, layer._priceInfo, expanded))
          .addTo(map);

        const el = hoverTooltip.getElement();
        if (el) {
          // interactive:true stops mouse/wheel events from passing through to the map (so the
          // expand button is actually clickable), which otherwise also lets the map itself
          // absorb the wheel event as a zoom - disableScrollPropagation stops that.
          L.DomEvent.disableScrollPropagation(el);
          L.DomEvent.disableClickPropagation(el);
          el.addEventListener("mouseenter", cancelClose);
          el.addEventListener("mouseleave", scheduleClose);
          bindChartHover(el, layer._priceInfo, expanded);

          // setContent() replaces the button along with the rest of the markup, so the click
          // listener needs rebinding after every toggle, not just once.
          const bindExpandButton = () => {
            const btn = el.querySelector(".expand-btn");
            if (!btn) return;
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              expanded = !expanded;
              el.classList.toggle("expanded", expanded);
              // setContent() triggers Leaflet's own reposition logic based on the new size, so
              // the card grows/shrinks in place instead of drifting off its anchor.
              hoverTooltip.setContent(tooltipHtml(zoneCode, layer._priceInfo, expanded));
              bindExpandButton();
              bindChartHover(el, layer._priceInfo, expanded);
            });
          };
          bindExpandButton();
        }
      });
      layer.on("mouseout", () => {
        layer.setStyle({ weight: 1 });
        scheduleClose();
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

  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectView(btn.dataset.view));
  });

  document.getElementById("auctions-toggle").addEventListener("click", toggleAuctionsCollapsed);

  const loader = document.getElementById("loader");
  if (loader) {
    loader.classList.add("hidden");
    setTimeout(() => loader.remove(), 300);
  }
}

main();
