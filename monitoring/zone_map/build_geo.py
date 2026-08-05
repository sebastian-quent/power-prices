"""one-off script: builds geo/{zones,context,grid}.geojson from public sources.

not run by the FastAPI app - run manually (`poetry run python -m monitoring.zone_map.build_geo`)
whenever the zone list changes or upstream shapes are updated, then commit the output files.

sources:
- bidding-zone polygons: EnergieID/entsoe-py `entsoe/geo/geojson/` (MIT license), covers every
  IN_SCOPE_ZONES entry except GB/IE (matches project-overview.md - GB has no ENTSO-E area at all).
  Clipped against the Natural Earth land outline below (see _clip_to_land) - entsoe-py's
  multi-zone-country shapes (Norway, Sweden, Italy) are custom-drawn envelopes that don't trace
  every fjord/island, so left unclipped they visibly bulge out to sea.
- GB/IE + the "everything else, greyed out" context layer (the whole rest of the world, not just
  Europe - see build_context_geojson): Natural Earth 1:50m admin-0 countries (public domain),
  via the nvkelso/natural-earth-vector GitHub mirror. Also doubles as the clip layer above.
- grid.geojson: Europe's high-voltage transmission lines, a purely decorative background layer
  (see build_grid_geojson) from GridKit (github.com/PyPSA/GridKit), an OpenStreetMap `power=line`
  extraction published under ODbL 1.0 on Zenodo.
"""

import csv
import gzip
import io
import json
import logging
import re
import zipfile
from pathlib import Path

import requests
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GEO_DIR = Path(__file__).resolve().parent / "static" / "geo"

# simplification/rounding - none of this data needs survey-grade precision at the zoom range this
# map actually uses (locked to a Europe-wide view, see static/app.js's setMinZoom/setMaxZoom).
# tolerances are in degrees (~1 degree latitude = ~111km). zones keeps more detail than context
# since it's the interactive/hovered layer; context is pure background. grid.geojson's links are
# already minimal 2-point segments (nothing to simplify), so only coordinate rounding applies there.
ZONE_SIMPLIFY_TOLERANCE = 0.003
CONTEXT_SIMPLIFY_TOLERANCE = 0.01
COORD_DECIMALS = 5  # ~1m precision, plenty for on-screen rendering

ENTSOE_RAW_BASE = "https://raw.githubusercontent.com/EnergieID/entsoe-py/master/entsoe/geo/geojson"
NE_COUNTRIES_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
    "ne_50m_admin_0_countries.geojson"
)
GRIDKIT_EUROPE_ZIP_URL = "https://zenodo.org/api/records/47317/files/gridkit_euorpe.zip/content"

# our bidding_zone -> entsoe-py's geojson filename (without extension). entsoe-py's DE_LU covers
# the merged DE/LU bidding zone, close enough to our plain "DE" zone; non-2020 IT files match the
# current (post-2021) zone config used everywhere else in this repo.
BIDDING_ZONE_TO_ENTSOE_FILE = {
    "AT": "AT", "BE": "BE", "BG": "BG", "CH": "CH", "CZ": "CZ", "DE": "DE_LU",
    "DK1": "DK_1", "DK2": "DK_2", "EE": "EE", "ES": "ES", "FI": "FI", "FR": "FR",
    "GR": "GR", "HR": "HR", "HU": "HU",
    "IT_NORD": "IT_NORD", "IT_CNOR": "IT_CNOR", "IT_CSUD": "IT_CSUD", "IT_SUD": "IT_SUD",
    "IT_SICI": "IT_SICI", "IT_SARD": "IT_SARD", "IT_CALA": "IT_CALA",
    "LT": "LT", "LV": "LV", "NL": "NL",
    "NO1": "NO_1", "NO2": "NO_2", "NO3": "NO_3", "NO4": "NO_4", "NO5": "NO_5",
    "PL": "PL", "PT": "PT", "RO": "RO",
    "SE1": "SE_1", "SE2": "SE_2", "SE3": "SE_3", "SE4": "SE_4",
    "SI": "SI", "SK": "SK",
}

# GB/IE aren't in entsoe-py (no ENTSO-E area) - plain country outlines from Natural Earth instead.
BIDDING_ZONE_TO_ISO_A2 = {"GB": "GB", "IE": "IE"}

# country ISO_A2 code(s) each entsoe-py zone gets clipped against (see _clip_to_land) - DE_LU is
# the only merged case, everything else is a single country. IT's 7 sub-zones all clip against
# the whole IT outline since entsoe-py has no per-sub-zone Natural Earth boundary to clip to.
BIDDING_ZONE_TO_CLIP_ISO_A2 = {
    "AT": ["AT"], "BE": ["BE"], "BG": ["BG"], "CH": ["CH"], "CZ": ["CZ"], "DE": ["DE", "LU"],
    "DK1": ["DK"], "DK2": ["DK"], "EE": ["EE"], "ES": ["ES"], "FI": ["FI"], "FR": ["FR"],
    "GR": ["GR"], "HR": ["HR"], "HU": ["HU"],
    "IT_NORD": ["IT"], "IT_CNOR": ["IT"], "IT_CSUD": ["IT"], "IT_SUD": ["IT"],
    "IT_SICI": ["IT"], "IT_SARD": ["IT"], "IT_CALA": ["IT"],
    "LT": ["LT"], "LV": ["LV"], "NL": ["NL"],
    "NO1": ["NO"], "NO2": ["NO"], "NO3": ["NO"], "NO4": ["NO"], "NO5": ["NO"],
    "PL": ["PL"], "PT": ["PT"], "RO": ["RO"],
    "SE1": ["SE"], "SE2": ["SE"], "SE3": ["SE"], "SE4": ["SE"],
    "SI": ["SI"], "SK": ["SK"],
}

# country-level ISO_A2 codes already covered (directly or via sub-zones) by BIDDING_ZONE_TO_ENTSOE_FILE
# / BIDDING_ZONE_TO_ISO_A2 above - excluded from the grey context layer so they don't double-draw
# underneath their own colored zone shapes.
COVERED_ISO_A2 = {
    "AT", "BE", "BG", "CH", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
    "IT", "LT", "LV", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK", "GB", "IE",
}

def _round_coords(coords, ndigits: int = COORD_DECIMALS):
    """recursively rounds a GeoJSON `coordinates` array (arbitrary nesting depth depending on
    geometry type) to ndigits - shrinks file size independent of simplify() below, since full
    float precision (~15-17 significant digits) is pure waste at this map's display scale."""
    if isinstance(coords[0], (int, float)):
        return [round(c, ndigits) for c in coords]
    return [_round_coords(c, ndigits) for c in coords]


def _simplify_and_round(geom, tolerance: float) -> dict:
    simplified = geom.simplify(tolerance, preserve_topology=True)
    geometry = mapping(simplified)
    geometry["coordinates"] = _round_coords(geometry["coordinates"])
    return geometry


def _clip_to_land(zone_geom, iso_codes: list[str], land_by_iso: dict):
    """intersects an entsoe-py zone polygon with the real coastline (Natural Earth land, at the
    same 50m resolution already used for the context layer) - entsoe-py's multi-zone-country
    shapes (Norway, Sweden, Italy) are custom-drawn envelopes that smooth across every fjord and
    island rather than tracing the coast, so left unclipped they visibly bulge out to sea (worst
    for NO4, ~34% of the unclipped NO1-5 union area measured outside Norway's real 10m coastline).
    Clipping an already-coastline-accurate zone (most single-zone countries, sourced from Natural
    Earth to begin with) against its own country is a no-op, so this applies uniformly rather than
    special-casing NO/SE/IT.
    """
    land = unary_union([land_by_iso[iso] for iso in iso_codes if iso in land_by_iso])
    clipped = zone_geom.intersection(land)
    if clipped.is_empty:
        raise RuntimeError(f"clipping against {iso_codes} produced an empty geometry")
    return clipped


def build_zones_geojson() -> dict:
    logger.info("fetching country outlines for clipping/GB/IE")
    ne_resp = requests.get(NE_COUNTRIES_URL, timeout=60)
    ne_resp.raise_for_status()
    ne_countries = ne_resp.json()

    # ISO_A2 is the sentinel "-99" for a handful of countries with complex sovereignty status
    # (Norway and France among them, see build_context_geojson) - ISO_A2_EH ("extended"/de-facto)
    # carries the real code for those, and is used as the primary key here since Norway is one of
    # our clip targets.
    land_by_iso: dict = {}
    for feature in ne_countries["features"]:
        iso_a2 = feature["properties"].get("ISO_A2_EH") or feature["properties"].get("ISO_A2")
        if iso_a2 and iso_a2 != "-99":
            land_by_iso.setdefault(iso_a2, []).append(shape(feature["geometry"]))
    land_by_iso = {iso: unary_union(geoms) for iso, geoms in land_by_iso.items()}

    features = []
    for bidding_zone, entsoe_file in BIDDING_ZONE_TO_ENTSOE_FILE.items():
        url = f"{ENTSOE_RAW_BASE}/{entsoe_file}.geojson"
        logger.info("fetching zone %s from %s", bidding_zone, url)
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        source_fc = resp.json()
        zone_geom = unary_union([shape(f["geometry"]) for f in source_fc["features"]])
        clipped = _clip_to_land(zone_geom, BIDDING_ZONE_TO_CLIP_ISO_A2[bidding_zone], land_by_iso)
        geometry = _simplify_and_round(clipped, ZONE_SIMPLIFY_TOLERANCE)
        features.append({"type": "Feature", "properties": {"bidding_zone": bidding_zone}, "geometry": geometry})

    iso_to_bidding_zone = {iso: bz for bz, iso in BIDDING_ZONE_TO_ISO_A2.items()}
    for feature in ne_countries["features"]:
        iso_a2 = feature["properties"].get("ISO_A2")
        if iso_a2 in iso_to_bidding_zone:
            geometry = _simplify_and_round(shape(feature["geometry"]), ZONE_SIMPLIFY_TOLERANCE)
            features.append(
                {
                    "type": "Feature",
                    "properties": {"bidding_zone": iso_to_bidding_zone[iso_a2]},
                    "geometry": geometry,
                }
            )

    found = {f["properties"]["bidding_zone"] for f in features}
    expected = set(BIDDING_ZONE_TO_ENTSOE_FILE) | set(BIDDING_ZONE_TO_ISO_A2)
    missing = expected - found
    if missing:
        raise RuntimeError(f"missing geometry for zones: {sorted(missing)}")

    return {"type": "FeatureCollection", "features": features}, ne_countries


def build_context_geojson(ne_countries: dict) -> dict:
    """every country worldwide except the ones we draw as colored zones - not clipped to a
    Europe bounding box. the map's own maxBounds (see static/app.js) keeps the user from ever
    panning/zooming far enough to reach the far side of antimeridian-crossing countries (Russia's
    Far East, USA/Alaska) where an unclipped polygon would otherwise render as a stray line
    across the whole map - so there's no need to clip the data itself, just restrict the camera.
    """
    features = []
    for feature in ne_countries["features"]:
        # plain ISO_A2 is "-99" for France and Norway in this dataset (Natural Earth's sentinel
        # for disputed/complex sovereignty cases) - falls through the exclusion check below,
        # leaving their full country outline double-drawn under the zones layer's own FR/NO1-5
        # shapes. ISO_A2_EH ("extended"/de-facto) carries the real code for exactly this case.
        iso_a2 = feature["properties"].get("ISO_A2_EH") or feature["properties"].get("ISO_A2")
        if iso_a2 in COVERED_ISO_A2:
            continue
        geometry = _simplify_and_round(shape(feature["geometry"]), CONTEXT_SIMPLIFY_TOLERANCE)
        features.append(
            {
                "type": "Feature",
                "properties": {"name": feature["properties"].get("NAME", "")},
                "geometry": geometry,
            }
        )
    return {"type": "FeatureCollection", "features": features}


_WKT_LINESTRING_RE = re.compile(r"LINESTRING\s*\((.*)\)", re.IGNORECASE)


def _parse_wkt_linestring(wkt: str) -> list[list[float]] | None:
    match = _WKT_LINESTRING_RE.search(wkt)
    if not match:
        return None
    coords = [[float(v) for v in pair.strip().split(" ")] for pair in match.group(1).split(",")]
    return coords if len(coords) >= 2 else None


def build_grid_geojson() -> dict:
    """Europe's high-voltage transmission lines - a faint decorative background layer, not
    analytical data (see module docstring: 2016 extract, ODbL 1.0). every link already ships
    its own ready-to-use WKT LINESTRING, so this just needs parsing, no vertex-table join.
    """
    logger.info("fetching GridKit Europe high-voltage grid dataset")
    resp = requests.get(GRIDKIT_EUROPE_ZIP_URL, timeout=60)
    resp.raise_for_status()

    features = []
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        with zf.open("gridkit_europe-highvoltage-links.csv") as f:
            for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
                coords = _parse_wkt_linestring(row.get("wkt_srid_4326", ""))
                if coords is None:
                    continue
                coords = _round_coords(coords)
                features.append({"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": coords}})
    return {"type": "FeatureCollection", "features": features}


def _write_geojson(path: Path, data: dict) -> None:
    """writes the plain file plus a precomputed `.gz` sibling - served directly by app.py's
    CachedStaticFiles when the client accepts gzip, so compressing these multi-MB files happens
    once here at build time rather than on every request via GZipMiddleware."""
    raw = json.dumps(data).encode("utf-8")
    path.write_bytes(raw)
    Path(f"{path}.gz").write_bytes(gzip.compress(raw, compresslevel=9))


def main() -> None:
    GEO_DIR.mkdir(parents=True, exist_ok=True)

    zones_fc, ne_countries = build_zones_geojson()
    context_fc = build_context_geojson(ne_countries)
    grid_fc = build_grid_geojson()

    _write_geojson(GEO_DIR / "zones.geojson", zones_fc)
    _write_geojson(GEO_DIR / "context.geojson", context_fc)
    _write_geojson(GEO_DIR / "grid.geojson", grid_fc)
    logger.info(
        "wrote %d zone features, %d context features, %d grid features to %s",
        len(zones_fc["features"]), len(context_fc["features"]), len(grid_fc["features"]), GEO_DIR,
    )


if __name__ == "__main__":
    main()
