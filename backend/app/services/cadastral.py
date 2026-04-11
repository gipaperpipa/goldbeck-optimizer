"""
German cadastral (Kataster/ALKIS) service.

Handles:
- Address geocoding via Nominatim (German addresses)
- State detection from coordinates
- WMS tile proxying for cadastral map overlay
- WFS GetFeatureInfo for parcel identification
- WFS GetFeature for parcel polygon geometry
- BKG (Bundesamt für Kartographie und Geodäsie) federal WFS
- Overpass API for OSM landuse/building polygons

Architecture:
  - Concurrent multi-source queries (Nominatim + BKG + State WFS + Overpass)
  - In-memory TTL cache for parcel lookups
  - Graceful degradation with synthetic parcel fallback
  - Structured logging for debugging failed sources
"""

import asyncio
import logging
import math
import time
from typing import Optional
from xml.etree import ElementTree

import httpx
from pyproj import Transformer
from shapely.geometry import Polygon

from app.models.plot import CoordinatePoint
from app.utils.rate_limiter import rate_limiter

logger = logging.getLogger(__name__)


# ── In-memory cache with TTL ────────────────────────────────────────────

class ParcelCache:
    """Simple in-memory cache with TTL for parcel lookups."""

    def __init__(self, ttl_seconds: int = 3600, max_entries: int = 2000):
        self._cache: dict[str, tuple[float, dict]] = {}
        self._ttl = ttl_seconds
        self._max = max_entries

    def _key(self, lng: float, lat: float) -> str:
        # Round to ~1m precision to group nearby clicks
        return f"{lng:.5f},{lat:.5f}"

    def get(self, lng: float, lat: float) -> Optional[dict]:
        key = self._key(lng, lat)
        entry = self._cache.get(key)
        if entry is None:
            return None
        ts, data = entry
        if time.time() - ts > self._ttl:
            del self._cache[key]
            return None
        return data

    def put(self, lng: float, lat: float, data: dict) -> None:
        if len(self._cache) >= self._max:
            # Evict oldest 25%
            sorted_keys = sorted(self._cache, key=lambda k: self._cache[k][0])
            for k in sorted_keys[: self._max // 4]:
                del self._cache[k]
        self._cache[self._key(lng, lat)] = (time.time(), data)

    @property
    def size(self) -> int:
        return len(self._cache)


_parcel_cache = ParcelCache(ttl_seconds=3600, max_entries=2000)


# ── Shared HTTP client (connection pooling) ─────────────────────────────

_http_client: Optional[httpx.AsyncClient] = None


def _get_http_client() -> httpx.AsyncClient:
    """Reuse a single AsyncClient for connection pooling."""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=8.0, read=20.0, write=5.0, pool=8.0),
            limits=httpx.Limits(max_connections=30, max_keepalive_connections=15),
            headers={
                "User-Agent": "GoldbeckOptimizer/1.0 (adrian.krasniqi@aplusa-studio.com)",
            },
        )
    return _http_client


# ── German State → Geoportal WMS/WFS endpoints ──────────────────────────

# Maps German state names to their cadastral WMS/WFS service URLs.
# These are INSPIRE-compliant or AdV-compliant ALKIS services.
# Coverage: all 16 states. Some use INSPIRE, some use AdV WMS.
GERMAN_STATE_SERVICES = {
    "Nordrhein-Westfalen": {
        "wms": "https://www.wms.nrw.de/geobasis/wms_nw_inspire-flurstuecke_alkis",
        "wfs": "https://www.wfs.nrw.de/geobasis/wfs_nw_inspire-flurstuecke_alkis",
        "wms_layers": "CP.CadastralParcel",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25832",
    },
    "Bayern": {
        "wms": "https://geoservices.bayern.de/wms/v2/ogc_alkis.cgi",
        "wfs": "https://geoservices.bayern.de/wfs/v2/ogc_alkis.cgi",
        "wms_layers": "adv_alkis_flurstuecke",
        "wfs_typename": "adv_alkis_flurstuecke",
        "crs": "EPSG:25832",
    },
    "Baden-Württemberg": {
        "wms": "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_INSP_BW_Flst_ALKIS",
        "wfs": "https://owsproxy.lgl-bw.de/owsproxy/ows/WFS_INSP_BW_Flst_ALKIS",
        "wms_layers": "CP.CadastralParcel",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25832",
    },
    "Hessen": {
        "wms": "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-maps.ows",
        "wfs": "https://inspire-hessen.de/ows/services/org.2.d66ec21e-39e7-45c4-bf68-438e8baea882_wfs",
        "wms_layers": "he_alkis_flurstuecke",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25832",
    },
    "Niedersachsen": {
        "wms": "https://www.geobasisdaten.niedersachsen.de/doorman/noauth/wms_ni_alkis",
        "wfs": "https://www.geobasisdaten.niedersachsen.de/doorman/noauth/wfs_ni_inspire-cp_alkis",
        "wms_layers": "adv_alkis_flurstuecke",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25832",
    },
    "Sachsen": {
        "wms": "https://geodienste.sachsen.de/wms_geosn_alkis-adv/guest",
        "wfs": "https://geodienste.sachsen.de/wfs_geosn_inspire-cp/guest",
        "wms_layers": "adv_alkis_flurstuecke",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25833",
    },
    "Sachsen-Anhalt": {
        "wms": "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_ALKIS_WMS_AdV_konform_App/guest",
        "wfs": "https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_ALKIS_WFS_OpenData/guest",
        "wms_layers": "adv_alkis_flurstuecke",
        "wfs_typename": "ave:Flurstueck",
        "crs": "EPSG:25832",
    },
    "Thüringen": {
        "wms": "https://www.geoproxy.geoportal-th.de/geoproxy/services/DLM/WMS_ALKIS_GS",
        "wfs": "https://www.geoproxy.geoportal-th.de/geoproxy/services/DLM/WFS_ALKIS_GS",
        "wms_layers": "adv_alkis_flurstuecke",
        "wfs_typename": "ave:Flurstueck",
        "crs": "EPSG:25832",
    },
    "Brandenburg": {
        "wms": "https://inspire.brandenburg.de/services/cp_wms",
        "wfs": "https://inspire.brandenburg.de/services/cp_wfs",
        "wms_layers": "CP.CadastralParcel",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25833",
    },
    "Berlin": {
        "wms": "https://fbinter.stadt-berlin.de/fb/wms/senstadt/wmsk_alkis",
        "wfs": "https://fbinter.stadt-berlin.de/fb/wfs/data/senstadt/s_wfs_alkis_flst",
        "wms_layers": "0",
        "wfs_typename": "fis:s_wfs_alkis_flst",
        "crs": "EPSG:25833",
    },
    "Schleswig-Holstein": {
        "wms": "https://service.gdi-sh.de/WMS_SH_ALKIS_OpenGBD",
        "wfs": "https://service.gdi-sh.de/WFS_SH_INSPIRE_CP",
        "wms_layers": "adv_alkis_flurstuecke",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25832",
    },
    "Mecklenburg-Vorpommern": {
        "wms": "https://www.geodaten-mv.de/dienste/adv_alkis",
        "wfs": "https://www.geodaten-mv.de/dienste/inspire_cp_alkis_download",
        "wms_layers": "adv_alkis_flurstuecke",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25833",
    },
    "Rheinland-Pfalz": {
        "wms": "https://geo5.service24.rlp.de/wms/alkis_rp.fcgi",
        "wfs": "https://geo5.service24.rlp.de/wfs/alkis_rp.fcgi",
        "wms_layers": "Flurstueck",
        "wfs_typename": "ave:Flurstueck",
        "crs": "EPSG:25832",
    },
    "Saarland": {
        "wms": "https://geoportal.saarland.de/mapbender/php/wms.php?inspire=1&layer_id=59384",
        "wfs": "https://geoportal.saarland.de/mapbender/php/wfs.php?inspire=1&layer_id=59384",
        "wms_layers": "CP.CadastralParcel",
        "wfs_typename": "CP:CadastralParcel",
        "crs": "EPSG:25832",
    },
    "Hamburg": {
        "wms": "https://geodienste.hamburg.de/HH_WMS_ALKIS_Basiskarte",
        "wfs": "https://geodienste.hamburg.de/HH_WFS_ALKIS_vereinfacht",
        "wms_layers": "0",
        "wfs_typename": "app:flurstuecke",
        "crs": "EPSG:25832",
    },
    "Bremen": {
        "wms": "https://geodienste.bremen.de/wms_alkis_flurstuecke",
        "wfs": "https://geodienste.bremen.de/wfs_alkis_flurstuecke",
        "wms_layers": "Flurstuecke",
        "wfs_typename": "ave:Flurstueck",
        "crs": "EPSG:25832",
    },
}


# ── BKG federal-level services (nationwide, single endpoint) ─────────────
# The BKG provides INSPIRE-compliant WFS for cadastral parcels across Germany.
# These are more reliable than individual state services for many regions.
BKG_SERVICES = {
    "wfs": "https://sgx.geodatenzentrum.de/wfs_inspire_cp",
    "wfs_typename": "CP:CadastralParcel",
    "crs": "EPSG:25832",
    # Fallback BKG basemap WMS (always works, but no parcel polygons)
    "wms_basemap": "https://sgx.geodatenzentrum.de/wms_basemapde",
}

# Bounding boxes for German states (approximate, in WGS84 lng/lat)
# Used to determine which state a coordinate falls in
GERMAN_STATE_BOUNDS = {
    "Schleswig-Holstein": (7.87, 53.36, 11.35, 55.06),
    "Hamburg": (9.73, 53.39, 10.33, 53.74),
    "Niedersachsen": (6.59, 51.30, 11.60, 53.90),
    "Bremen": (8.48, 53.01, 8.99, 53.60),
    "Nordrhein-Westfalen": (5.87, 50.32, 9.46, 52.53),
    "Hessen": (7.77, 49.39, 10.24, 51.66),
    "Rheinland-Pfalz": (6.11, 48.97, 8.51, 50.94),
    "Baden-Württemberg": (7.51, 47.53, 10.50, 49.79),
    "Bayern": (8.98, 47.27, 13.84, 50.56),
    "Saarland": (6.36, 49.11, 7.41, 49.64),
    "Berlin": (13.09, 52.34, 13.76, 52.68),
    "Brandenburg": (11.27, 51.36, 14.77, 53.56),
    "Mecklenburg-Vorpommern": (10.59, 53.11, 14.41, 54.68),
    "Sachsen": (11.87, 50.17, 15.04, 51.68),
    "Sachsen-Anhalt": (10.56, 50.94, 13.19, 52.99),
    "Thüringen": (9.88, 50.20, 12.65, 51.65),
}


# ── Coordinate transformations ───────────────────────────────────────────

_transformer_4326_to_25832 = Transformer.from_crs("EPSG:4326", "EPSG:25832", always_xy=True)
_transformer_4326_to_25833 = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)
_transformer_25832_to_4326 = Transformer.from_crs("EPSG:25832", "EPSG:4326", always_xy=True)
_transformer_25833_to_4326 = Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True)


def wgs84_to_utm(lng: float, lat: float, epsg: str = "EPSG:25832") -> tuple[float, float]:
    """Convert WGS84 (lng, lat) to UTM (easting, northing)."""
    t = _transformer_4326_to_25833 if epsg == "EPSG:25833" else _transformer_4326_to_25832
    return t.transform(lng, lat)


def utm_to_wgs84(easting: float, northing: float, epsg: str = "EPSG:25832") -> tuple[float, float]:
    """Convert UTM (easting, northing) to WGS84 (lng, lat)."""
    t = _transformer_25833_to_4326 if epsg == "EPSG:25833" else _transformer_25832_to_4326
    return t.transform(easting, northing)


# ── State detection ──────────────────────────────────────────────────────

def detect_state(lng: float, lat: float) -> Optional[str]:
    """Detect which German state a WGS84 coordinate falls in.
    Uses bounding box check. For overlapping boxes, picks the smallest area match.
    """
    matches = []
    for state, (min_lng, min_lat, max_lng, max_lat) in GERMAN_STATE_BOUNDS.items():
        if min_lng <= lng <= max_lng and min_lat <= lat <= max_lat:
            area = (max_lng - min_lng) * (max_lat - min_lat)
            matches.append((area, state))

    if not matches:
        return None

    # Smallest bounding box wins (more specific match, e.g. Berlin over Brandenburg)
    matches.sort()
    return matches[0][1]


def get_state_service(state: str) -> Optional[dict]:
    """Get WMS/WFS service config for a German state."""
    return GERMAN_STATE_SERVICES.get(state)


# ── Nominatim geocoding ─────────────────────────────────────────────────

async def geocode_german_address(query: str, limit: int = 5) -> list[dict]:
    """
    Geocode a German address using Nominatim (OSM).
    Returns list of {display_name, lat, lng, type, importance, bbox}.
    """
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "q": query,
        "format": "json",
        "countrycodes": "de",
        "limit": limit,
        "addressdetails": 1,
        "polygon_geojson": 0,
    }

    client = _get_http_client()
    await rate_limiter.acquire("nominatim")
    response = await client.get(url, params=params)
    response.raise_for_status()
    results = response.json()

    return [
        {
            "display_name": r["display_name"],
            "lat": float(r["lat"]),
            "lng": float(r["lon"]),
            "type": r.get("type", ""),
            "importance": float(r.get("importance", 0)),
            "bbox": r.get("boundingbox"),  # [south_lat, north_lat, west_lng, east_lng]
            "state": r.get("address", {}).get("state", ""),
        }
        for r in results
    ]


# ── WMS proxy ────────────────────────────────────────────────────────────

async def proxy_wms_request(
    state: str,
    params: dict,
) -> tuple[bytes, str]:
    """
    Proxy a WMS request to the appropriate state geoportal.
    Returns (response_bytes, content_type).
    """
    service = get_state_service(state)
    if not service:
        raise ValueError(f"No WMS service configured for state: {state}")

    wms_url = service["wms"]
    client = _get_http_client()
    await rate_limiter.acquire("wfs")
    response = await client.get(wms_url, params=params)
    response.raise_for_status()
    return response.content, response.headers.get("content-type", "image/png")


# ── Primary: Nominatim reverse geocoding for parcel polygon ──────────────

async def _get_parcel_via_nominatim(lng: float, lat: float, state: str) -> Optional[dict]:
    """
    Use Nominatim reverse geocoding with polygon output to get the parcel
    boundary at a click point. Tries multiple zoom levels for better coverage.

    Zoom levels in Nominatim:
      18 = building / land parcel (most precise)
      17 = minor street / path
      16 = major street
    """
    # Try zoom levels from most precise to less precise
    for zoom in [18, 17]:
        result = await _nominatim_reverse_with_polygon(lng, lat, state, zoom)
        if result and result.get("polygon_wgs84"):
            # Validate polygon has reasonable parcel size (>10m² and <100000m²)
            area = result.get("area_sqm", 0)
            if not (10 < area < 100000):
                continue
            # Validate the click point actually falls inside the returned polygon
            if not _point_in_polygon(lng, lat, result["polygon_wgs84"]):
                logger.debug(f"Nominatim zoom={zoom}: polygon doesn't contain click point, skipping")
                continue
            logger.info(f"Nominatim success for ({lng:.5f}, {lat:.5f}) zoom={zoom}")
            return result

    return None


async def _nominatim_reverse_with_polygon(
    lng: float, lat: float, state: str, zoom: int
) -> Optional[dict]:
    """Single Nominatim reverse geocode attempt at a specific zoom level."""
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "lat": lat,
        "lon": lng,
        "format": "json",
        "zoom": zoom,
        "polygon_geojson": 1,
        "addressdetails": 1,
    }

    try:
        client = _get_http_client()
        await rate_limiter.acquire("nominatim")
        response = await client.get(url, params=params)
        response.raise_for_status()
        data = response.json()

        geojson = data.get("geojson")
        if not geojson:
            return None

        geom_type = geojson.get("type", "")
        coords = geojson.get("coordinates", [])

        wgs84_coords = None
        if geom_type == "Polygon" and coords:
            ring = coords[0]
            wgs84_coords = [[pt[0], pt[1]] for pt in ring]
        elif geom_type == "MultiPolygon" and coords:
            largest = max(coords, key=lambda poly: len(poly[0]))
            ring = largest[0]
            wgs84_coords = [[pt[0], pt[1]] for pt in ring]

        if not wgs84_coords or len(wgs84_coords) < 3:
            return None

        area, width, depth, perimeter = _calculate_polygon_metrics(wgs84_coords)

        address = data.get("address", {})
        display_name = data.get("display_name", "")

        return {
            "state": state,
            "parcel_id": data.get("osm_id", str(data.get("place_id", ""))),
            "gemarkung": address.get("suburb", address.get("city_district", address.get("town", ""))),
            "flurstueck_nr": address.get("house_number", ""),
            "area_sqm": area,
            "width_m": width,
            "depth_m": depth,
            "perimeter_m": perimeter,
            "polygon_wgs84": wgs84_coords,
            "properties": {
                "display_name": display_name,
                "osm_type": data.get("osm_type", ""),
                "category": data.get("category", ""),
                "type": data.get("type", ""),
                **{k: v for k, v in address.items()},
            },
        }
    except Exception as e:
        logger.debug(f"Nominatim reverse geocode failed: {e}")
        return None


# ── Fallback: WFS GetFeature for parcel polygon ─────────────────────────

async def _get_parcel_via_wfs(
    lng: float, lat: float, state: str
) -> Optional[dict]:
    """
    Query state WFS to get the parcel polygon. Tries JSON first, then GML.
    Uses shared HTTP client for connection pooling.
    """
    service = get_state_service(state)
    if not service:
        return None

    epsg = service["crs"]
    easting, northing = wgs84_to_utm(lng, lat, epsg)

    half = 50.0  # 100m×100m search area to catch parcels reliably
    bbox_filter = f"{easting - half},{northing - half},{easting + half},{northing + half},{epsg}"

    client = _get_http_client()

    for output_format in ["application/json", "application/geo+json",
                          "text/xml; subtype=gml/3.2.1", "text/xml"]:
        params = {
            "SERVICE": "WFS",
            "VERSION": "2.0.0",
            "REQUEST": "GetFeature",
            "TYPENAMES": service["wfs_typename"],
            "BBOX": bbox_filter,
            "SRSNAME": epsg,
            "COUNT": 10,  # Fetch multiple to pick the one containing the click
            "OUTPUTFORMAT": output_format,
        }

        try:
            await rate_limiter.acquire("wfs")
            response = await client.get(service["wfs"], params=params)
            if response.status_code != 200:
                continue

            content_type = response.headers.get("content-type", "")
            if "json" in content_type:
                data = response.json()
                parcels = _process_geojson_parcels(data, epsg, state)
                # Pick the parcel that contains the click point
                for p in parcels:
                    if p.get("polygon_wgs84") and _point_in_polygon(lng, lat, p["polygon_wgs84"]):
                        p["properties"]["source"] = f"state_wfs_{state}"
                        logger.info(f"State WFS ({state}) success for ({lng:.5f}, {lat:.5f})")
                        return p
                # If none contain the point, return the first one as fallback
                if parcels:
                    parcels[0]["properties"]["source"] = f"state_wfs_{state}"
                    return parcels[0]
            elif "xml" in content_type or "gml" in content_type:
                parcels = _process_gml_parcels(response.text, epsg, state)
                for p in parcels:
                    if p.get("polygon_wgs84") and _point_in_polygon(lng, lat, p["polygon_wgs84"]):
                        p["properties"]["source"] = f"state_wfs_{state}"
                        logger.info(f"State WFS GML ({state}) success for ({lng:.5f}, {lat:.5f})")
                        return p
                if parcels:
                    parcels[0]["properties"]["source"] = f"state_wfs_{state}"
                    return parcels[0]
        except Exception as e:
            logger.debug(f"State WFS ({state}, {output_format}) failed: {e}")
            continue

    return None


# ── WMS GetFeatureInfo (parcel identification by click) ──────────────────

async def get_parcel_info_at_point(
    lng: float,
    lat: float,
    state: Optional[str] = None,
) -> Optional[dict]:
    """
    Query WMS GetFeatureInfo at a click point to identify the parcel.
    Returns parcel attributes or None.
    """
    if not state:
        state = detect_state(lng, lat)
    if not state:
        return None

    service = get_state_service(state)
    if not service:
        return None

    epsg = service["crs"]
    easting, northing = wgs84_to_utm(lng, lat, epsg)

    # Create a small bbox around the click point (50m × 50m)
    half = 25.0
    bbox = f"{easting - half},{northing - half},{easting + half},{northing + half}"

    # Try multiple info formats
    for info_format in ["application/json", "application/geojson",
                        "text/xml", "application/vnd.ogc.gml"]:
        params = {
            "SERVICE": "WMS",
            "VERSION": "1.3.0",
            "REQUEST": "GetFeatureInfo",
            "LAYERS": service["wms_layers"],
            "QUERY_LAYERS": service["wms_layers"],
            "CRS": epsg,
            "BBOX": bbox,
            "WIDTH": 256,
            "HEIGHT": 256,
            "I": 128,
            "J": 128,
            "INFO_FORMAT": info_format,
            "FEATURE_COUNT": 1,
        }

        try:
            client = _get_http_client()
            await rate_limiter.acquire("wfs")
            response = await client.get(service["wms"], params=params)
            if response.status_code != 200:
                continue

            content_type = response.headers.get("content-type", "")
            if "json" in content_type:
                data = response.json()
                features = data.get("features", [])
                if features:
                    feat = features[0]
                    props = feat.get("properties", {})
                    geom = feat.get("geometry")
                    return {
                        "state": state,
                        "properties": props,
                        "geometry": geom,
                        "source": "wms_getfeatureinfo",
                    }
            elif "xml" in content_type or "gml" in content_type:
                result = _parse_xml_feature_info(response.text, state)
                if result:
                    return result
        except Exception as e:
            logger.debug(f"WMS GetFeatureInfo attempt failed: {e}")
            continue

    return None


# ── BKG federal WFS query ────────────────────────────────────────────────

async def _get_parcel_via_bkg(lng: float, lat: float, state: str) -> Optional[dict]:
    """
    Query the BKG (federal) INSPIRE Cadastral Parcel WFS.
    Single nationwide endpoint — more reliable than individual state services.
    """
    epsg = BKG_SERVICES["crs"]
    easting, northing = wgs84_to_utm(lng, lat, epsg)
    half = 50.0  # 100m×100m search area to catch parcels reliably
    bbox_filter = f"{easting - half},{northing - half},{easting + half},{northing + half},{epsg}"

    client = _get_http_client()

    for output_format in ["application/json", "application/geo+json",
                          "text/xml; subtype=gml/3.2.1"]:
        params = {
            "SERVICE": "WFS",
            "VERSION": "2.0.0",
            "REQUEST": "GetFeature",
            "TYPENAMES": BKG_SERVICES["wfs_typename"],
            "BBOX": bbox_filter,
            "SRSNAME": epsg,
            "COUNT": 10,  # Fetch multiple to pick the one containing the click
            "OUTPUTFORMAT": output_format,
        }

        try:
            await rate_limiter.acquire("bkg")
            response = await client.get(BKG_SERVICES["wfs"], params=params)
            if response.status_code != 200:
                continue

            content_type = response.headers.get("content-type", "")
            if "json" in content_type:
                data = response.json()
                parcels = _process_geojson_parcels(data, epsg, state)
                for p in parcels:
                    if p.get("polygon_wgs84") and _point_in_polygon(lng, lat, p["polygon_wgs84"]):
                        p["properties"]["source"] = "bkg_wfs"
                        logger.info(f"BKG WFS success for ({lng:.5f}, {lat:.5f})")
                        return p
                if parcels:
                    parcels[0]["properties"]["source"] = "bkg_wfs"
                    return parcels[0]
            elif "xml" in content_type or "gml" in content_type:
                parcels = _process_gml_parcels(response.text, epsg, state)
                for p in parcels:
                    if p.get("polygon_wgs84") and _point_in_polygon(lng, lat, p["polygon_wgs84"]):
                        p["properties"]["source"] = "bkg_wfs"
                        logger.info(f"BKG WFS (GML) success for ({lng:.5f}, {lat:.5f})")
                        return p
                if parcels:
                    parcels[0]["properties"]["source"] = "bkg_wfs"
                    return parcels[0]
        except Exception as e:
            logger.debug(f"BKG WFS failed ({output_format}): {e}")
            continue

    return None


# ── Main entry point: CONCURRENT multi-source parcel lookup ──────────────

async def get_parcel_geometry_at_point(
    lng: float,
    lat: float,
    state: Optional[str] = None,
) -> Optional[dict]:
    """
    Get parcel polygon at a click point using concurrent multi-source queries.

    Fires all sources in parallel and returns the first valid result,
    prioritized by data quality:
      1. BKG federal WFS (official ALKIS, nationwide)
      2. State-specific WFS (official ALKIS, per-state)
      3. Nominatim reverse geocoding (OSM data, good coverage)
      4. Overpass API (OSM landuse/building polygons)
      5. Synthetic rectangular parcel (always succeeds — last resort)

    Results are cached in memory (1h TTL) to avoid redundant requests.
    """
    if not state:
        state = detect_state(lng, lat)
    if not state:
        return None

    # Check cache first
    cached = _parcel_cache.get(lng, lat)
    if cached is not None:
        logger.info(f"Cache hit for ({lng:.5f}, {lat:.5f})")
        return cached

    # Fire all sources concurrently
    results = await asyncio.gather(
        _get_parcel_via_bkg(lng, lat, state),
        _get_parcel_via_wfs(lng, lat, state),
        _get_parcel_via_nominatim(lng, lat, state),
        _get_parcel_via_overpass(lng, lat, state),
        return_exceptions=True,
    )

    # Priority order: BKG > State WFS > Nominatim > Overpass
    # Validate each result: polygon must contain the click point
    source_names = ["BKG", "State WFS", "Nominatim", "Overpass"]
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            logger.warning(f"{source_names[i]} failed for ({lng:.5f}, {lat:.5f}): {result}")
            continue
        if result and result.get("polygon_wgs84"):
            poly = result["polygon_wgs84"]
            if _point_in_polygon(lng, lat, poly):
                logger.info(f"Using {source_names[i]} result for ({lng:.5f}, {lat:.5f})")
                _parcel_cache.put(lng, lat, result)
                return result
            else:
                logger.debug(f"{source_names[i]}: polygon doesn't contain click point, skipping")

    # Last resort: synthetic parcel (always succeeds)
    logger.warning(f"All sources failed for ({lng:.5f}, {lat:.5f}) — using synthetic parcel")
    result = _generate_synthetic_parcel(lng, lat, state)
    _parcel_cache.put(lng, lat, result)
    return result


async def get_parcels_in_bbox(
    min_lng: float,
    min_lat: float,
    max_lng: float,
    max_lat: float,
    state: Optional[str] = None,
) -> list[dict]:
    """
    Fetch all parcels within a bounding box.
    Tries BKG federal WFS first (nationwide, most reliable), then state WFS as fallback.
    Returns list of parcel dicts with WGS84 polygon coordinates.
    """
    center_lng = (min_lng + max_lng) / 2
    center_lat = (min_lat + max_lat) / 2

    if not state:
        state = detect_state(center_lng, center_lat)
    if not state:
        return []

    # ── Try BKG federal WFS first (most reliable, nationwide) ────────
    bkg_results = await _get_parcels_in_bbox_bkg(min_lng, min_lat, max_lng, max_lat, state)
    if bkg_results:
        logger.info(f"BKG bbox returned {len(bkg_results)} parcels")
        return bkg_results

    # ── Fallback to state WFS ────────────────────────────────────────
    service = get_state_service(state)
    if not service:
        return []

    epsg = service["crs"]
    min_e, min_n = wgs84_to_utm(min_lng, min_lat, epsg)
    max_e, max_n = wgs84_to_utm(max_lng, max_lat, epsg)

    bbox_filter = f"{min_e},{min_n},{max_e},{max_n},{epsg}"

    for output_format in ["application/json", "application/geo+json",
                          "text/xml; subtype=gml/3.2.1"]:
        params = {
            "SERVICE": "WFS",
            "VERSION": "2.0.0",
            "REQUEST": "GetFeature",
            "TYPENAMES": service["wfs_typename"],
            "BBOX": bbox_filter,
            "SRSNAME": epsg,
            "COUNT": 100,
            "OUTPUTFORMAT": output_format,
        }

        try:
            client = _get_http_client()
            await rate_limiter.acquire("wfs")
            response = await client.get(service["wfs"], params=params)
            if response.status_code != 200:
                continue

            content_type = response.headers.get("content-type", "")
            if "json" in content_type:
                data = response.json()
                results = _process_geojson_parcels(data, epsg, state)
                if results:
                    logger.info(f"State WFS bbox ({state}) returned {len(results)} parcels")
                    return results
            elif "xml" in content_type or "gml" in content_type:
                results = _process_gml_parcels(response.text, epsg, state)
                if results:
                    logger.info(f"State WFS GML bbox ({state}) returned {len(results)} parcels")
                    return results
        except Exception as e:
            logger.debug(f"State WFS bbox format {output_format} failed: {e}")
            continue

    return []


async def _get_parcels_in_bbox_bkg(
    min_lng: float, min_lat: float, max_lng: float, max_lat: float, state: str
) -> list[dict]:
    """Fetch parcels in bbox via BKG federal INSPIRE WFS."""
    epsg = BKG_SERVICES["crs"]
    min_e, min_n = wgs84_to_utm(min_lng, min_lat, epsg)
    max_e, max_n = wgs84_to_utm(max_lng, max_lat, epsg)
    bbox_filter = f"{min_e},{min_n},{max_e},{max_n},{epsg}"

    client = _get_http_client()

    for output_format in ["application/json", "application/geo+json",
                          "text/xml; subtype=gml/3.2.1"]:
        params = {
            "SERVICE": "WFS",
            "VERSION": "2.0.0",
            "REQUEST": "GetFeature",
            "TYPENAMES": BKG_SERVICES["wfs_typename"],
            "BBOX": bbox_filter,
            "SRSNAME": epsg,
            "COUNT": 100,
            "OUTPUTFORMAT": output_format,
        }
        try:
            await rate_limiter.acquire("bkg")
            response = await client.get(BKG_SERVICES["wfs"], params=params, timeout=15.0)
            if response.status_code != 200:
                continue

            content_type = response.headers.get("content-type", "")
            if "json" in content_type:
                data = response.json()
                results = _process_geojson_parcels(data, epsg, state)
                if results:
                    return results
            elif "xml" in content_type or "gml" in content_type:
                results = _process_gml_parcels(response.text, epsg, state)
                if results:
                    return results
        except Exception as e:
            logger.debug(f"BKG bbox format {output_format} failed: {e}")
            continue

    return []


# ── Overpass API fallback ────────────────────────────────────────────────

async def _get_parcel_via_overpass(lng: float, lat: float, state: str) -> Optional[dict]:
    """
    Query the Overpass API for the smallest enclosing polygon (landuse, building,
    or boundary=lot) at the given point. This covers cases where Nominatim's
    reverse geocoding returns no polygon but OSM does have area data.
    """
    # Search radius in meters — 50m should catch the parcel we're standing on
    radius = 50
    query = f"""
[out:json][timeout:10];
(
  way["landuse"](around:{radius},{lat},{lng});
  relation["landuse"](around:{radius},{lat},{lng});
  way["building"](around:{radius},{lat},{lng});
  way["boundary"="lot"](around:{radius},{lat},{lng});
);
out body;
>;
out skel qt;
"""

    try:
        client = _get_http_client()
        await rate_limiter.acquire("overpass")
        response = await client.post(
            "https://overpass-api.de/api/interpreter",
            data={"data": query},
        )
        if response.status_code != 200:
            return None
        data = response.json()

        elements = data.get("elements", [])
        if not elements:
            return None

        # Build a node lookup
        nodes: dict[int, tuple[float, float]] = {}
        ways: list[dict] = []
        for el in elements:
            if el["type"] == "node":
                nodes[el["id"]] = (el["lon"], el["lat"])
            elif el["type"] == "way" and "tags" in el:
                ways.append(el)

        # Find the smallest polygon that contains or is nearest to the click point
        best_polygon = None
        best_area = float("inf")
        best_tags: dict = {}

        for way in ways:
            node_ids = way.get("nodes", [])
            if len(node_ids) < 4:  # need at least a triangle (closed ring = 4 entries)
                continue
            coords = []
            for nid in node_ids:
                if nid in nodes:
                    coords.append(list(nodes[nid]))  # [lng, lat]
            if len(coords) < 4:
                continue

            area, width, depth, perimeter = _calculate_polygon_metrics(coords)
            # Must be a plausible parcel size
            if 10 < area < 100000 and area < best_area:
                best_area = area
                best_polygon = coords
                best_tags = way.get("tags", {})

        if not best_polygon:
            return None

        area, width, depth, perimeter = _calculate_polygon_metrics(best_polygon)

        return {
            "state": state,
            "parcel_id": f"overpass_{best_tags.get('name', '')}",
            "gemarkung": "",
            "flurstueck_nr": "",
            "area_sqm": area,
            "width_m": width,
            "depth_m": depth,
            "perimeter_m": perimeter,
            "polygon_wgs84": best_polygon,
            "properties": {
                "source": "overpass_api",
                **best_tags,
            },
        }
    except Exception as e:
        logger.debug(f"Overpass API parcel lookup failed: {e}")
        return None


# ── Synthetic rectangular parcel (last resort) ──────────────────────────

def _generate_synthetic_parcel(
    lng: float, lat: float, state: str,
    default_width_m: float = 30.0,
    default_depth_m: float = 50.0,
) -> dict:
    """
    Generate a synthetic rectangular parcel centered on the click point.
    Used as a last resort so the user can always proceed with a plot, even
    if no real cadastral data is available. The user can manually adjust
    dimensions afterwards.
    """
    # Approximate meters to degrees at this latitude
    m_per_deg_lat = 110_947.0
    m_per_deg_lng = m_per_deg_lat * math.cos(math.radians(lat))

    half_w = (default_width_m / 2.0) / m_per_deg_lng
    half_d = (default_depth_m / 2.0) / m_per_deg_lat

    # Rectangular parcel corners (clockwise)
    polygon = [
        [lng - half_w, lat - half_d],
        [lng + half_w, lat - half_d],
        [lng + half_w, lat + half_d],
        [lng - half_w, lat + half_d],
        [lng - half_w, lat - half_d],  # close the ring
    ]

    return {
        "state": state,
        "parcel_id": "synthetic",
        "gemarkung": "",
        "flurstueck_nr": "",
        "area_sqm": default_width_m * default_depth_m,
        "width_m": default_width_m,
        "depth_m": default_depth_m,
        "perimeter_m": 2.0 * (default_width_m + default_depth_m),
        "polygon_wgs84": polygon,
        "properties": {
            "source": "synthetic_rectangle",
            "note": "Auto-generated placeholder parcel. Adjust dimensions as needed.",
        },
    }


# ── Helper functions ─────────────────────────────────────────────────────

def _process_geojson_parcel(data: dict, epsg: str, state: str) -> Optional[dict]:
    """Process a GeoJSON WFS response and extract the first parcel."""
    features = data.get("features", [])
    if not features:
        return None

    feat = features[0]
    props = feat.get("properties", {})
    geom = feat.get("geometry", {})

    # Convert coordinates from UTM to WGS84
    wgs84_coords = _convert_geometry_to_wgs84(geom, epsg)
    if not wgs84_coords:
        return None

    # Calculate area and dimensions from the polygon
    area, width, depth, perimeter = _calculate_polygon_metrics(wgs84_coords)

    return {
        "state": state,
        "parcel_id": _extract_parcel_id(props),
        "gemarkung": props.get("gemarkung", props.get("cadastralZoning", "")),
        "flurstueck_nr": props.get("flurstuecksnummer", props.get("nationalCadastralReference", "")),
        "area_sqm": area,
        "width_m": width,
        "depth_m": depth,
        "perimeter_m": perimeter,
        "polygon_wgs84": wgs84_coords,
        "properties": props,
    }


def _process_geojson_parcels(data: dict, epsg: str, state: str) -> list[dict]:
    """Process a GeoJSON WFS response and extract all parcels."""
    features = data.get("features", [])
    result = []
    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        wgs84_coords = _convert_geometry_to_wgs84(geom, epsg)
        if not wgs84_coords:
            continue

        area, width, depth, perimeter = _calculate_polygon_metrics(wgs84_coords)
        result.append({
            "state": state,
            "parcel_id": _extract_parcel_id(props),
            "gemarkung": props.get("gemarkung", props.get("cadastralZoning", "")),
            "flurstueck_nr": props.get("flurstuecksnummer", props.get("nationalCadastralReference", "")),
            "area_sqm": area,
            "width_m": width,
            "depth_m": depth,
            "perimeter_m": perimeter,
            "polygon_wgs84": wgs84_coords,
            "properties": props,
        })
    return result


def _convert_geometry_to_wgs84(geom: dict, epsg: str) -> Optional[list[list[float]]]:
    """Convert a GeoJSON geometry's coordinates from UTM to WGS84."""
    geom_type = geom.get("type", "")
    coords = geom.get("coordinates", [])

    if geom_type == "Polygon" and coords:
        ring = coords[0]  # outer ring
        wgs84 = []
        for pt in ring:
            lng, lat = utm_to_wgs84(pt[0], pt[1], epsg)
            wgs84.append([lng, lat])
        return wgs84
    elif geom_type == "MultiPolygon" and coords:
        # Take the largest polygon
        largest = max(coords, key=lambda poly: len(poly[0]))
        ring = largest[0]
        wgs84 = []
        for pt in ring:
            lng, lat = utm_to_wgs84(pt[0], pt[1], epsg)
            wgs84.append([lng, lat])
        return wgs84

    return None


def _point_in_polygon(lng: float, lat: float, polygon: list[list[float]]) -> bool:
    """
    Ray-casting point-in-polygon test.
    Returns True if (lng, lat) is inside the polygon defined by WGS84 coords.
    """
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if ((yi > lat) != (yj > lat)) and (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _calculate_polygon_metrics(
    wgs84_coords: list[list[float]],
) -> tuple[float, float, float, float]:
    """Calculate area, width, depth, and perimeter from WGS84 polygon coords."""
    if len(wgs84_coords) < 3:
        return 0.0, 0.0, 0.0, 0.0

    # Convert to local meters for accurate measurement
    centroid_lng = sum(c[0] for c in wgs84_coords) / len(wgs84_coords)
    centroid_lat = sum(c[1] for c in wgs84_coords) / len(wgs84_coords)

    m_per_deg_lat = 110_947.0
    m_per_deg_lng = m_per_deg_lat * math.cos(math.radians(centroid_lat))

    local_coords = []
    for c in wgs84_coords:
        x = (c[0] - centroid_lng) * m_per_deg_lng
        y = (c[1] - centroid_lat) * m_per_deg_lat
        local_coords.append((x, y))

    poly = Polygon(local_coords)
    if not poly.is_valid:
        poly = poly.buffer(0)

    bounds = poly.bounds
    return (
        poly.area,
        bounds[2] - bounds[0],  # width
        bounds[3] - bounds[1],  # depth
        poly.length,  # perimeter
    )


def _extract_parcel_id(props: dict) -> str:
    """Extract a parcel identifier from WFS properties."""
    for key in ["gml_id", "id", "fid", "nationalCadastralReference", "flurstueckskennzeichen"]:
        if key in props and props[key]:
            return str(props[key])
    return ""


def _parse_xml_feature_info(xml_text: str, state: str) -> Optional[dict]:
    """Parse XML/GML GetFeatureInfo response."""
    try:
        root = ElementTree.fromstring(xml_text)
        # Try to find any feature element
        for elem in root.iter():
            if "Flurstueck" in elem.tag or "CadastralParcel" in elem.tag or "Feature" in elem.tag:
                props = {}
                for child in elem:
                    tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
                    if child.text:
                        props[tag] = child.text
                return {
                    "state": state,
                    "properties": props,
                    "source": "wms_getfeatureinfo_xml",
                }
    except Exception as e:
        logger.debug(f"XML FeatureInfo parsing failed: {e}")
    return None


def _process_gml_parcel(xml_text: str, epsg: str, state: str) -> Optional[dict]:
    """Process GML/XML WFS response and extract the first parcel."""
    parcels = _process_gml_parcels(xml_text, epsg, state)
    return parcels[0] if parcels else None


def _process_gml_parcels(xml_text: str, epsg: str, state: str) -> list[dict]:
    """Process GML/XML WFS response and extract all parcels."""
    results = []
    try:
        root = ElementTree.fromstring(xml_text)
        ns = {
            "gml": "http://www.opengis.net/gml/3.2",
            "wfs": "http://www.opengis.net/wfs/2.0",
            "cp": "http://inspire.ec.europa.eu/schemas/cp/4.0",
        }

        # Find all member elements
        for member in root.iter():
            if "member" in member.tag.lower():
                for child in member:
                    # Extract properties
                    props = {}
                    for prop in child:
                        tag = prop.tag.split("}")[-1] if "}" in prop.tag else prop.tag
                        if prop.text and prop.text.strip():
                            props[tag] = prop.text.strip()

                    # Find geometry (posList or coordinates)
                    coords = _extract_gml_coordinates(child, epsg)
                    if coords:
                        area, width, depth, perimeter = _calculate_polygon_metrics(coords)
                        results.append({
                            "state": state,
                            "parcel_id": _extract_parcel_id(props),
                            "gemarkung": props.get("gemarkung", props.get("cadastralZoning", "")),
                            "flurstueck_nr": props.get("flurstuecksnummer", props.get("nationalCadastralReference", "")),
                            "area_sqm": area,
                            "width_m": width,
                            "depth_m": depth,
                            "perimeter_m": perimeter,
                            "polygon_wgs84": coords,
                            "properties": props,
                        })
    except Exception as e:
        logger.debug(f"GML parcel processing failed: {e}")

    return results


def _extract_gml_coordinates(element, epsg: str) -> Optional[list[list[float]]]:
    """Extract coordinates from a GML geometry element and convert to WGS84."""
    for elem in element.iter():
        tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag

        if tag == "posList" and elem.text:
            nums = [float(x) for x in elem.text.strip().split()]
            # posList is pairs of easting,northing
            coords_utm = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
            wgs84 = []
            for e, n in coords_utm:
                lng, lat = utm_to_wgs84(e, n, epsg)
                wgs84.append([lng, lat])
            return wgs84 if len(wgs84) >= 3 else None

        if tag == "pos" and elem.text:
            # Single point — not useful for polygon
            continue

        if tag == "coordinates" and elem.text:
            pairs = elem.text.strip().split()
            coords_utm = []
            for pair in pairs:
                parts = pair.split(",")
                if len(parts) >= 2:
                    coords_utm.append((float(parts[0]), float(parts[1])))
            wgs84 = []
            for e, n in coords_utm:
                lng, lat = utm_to_wgs84(e, n, epsg)
                wgs84.append([lng, lat])
            return wgs84 if len(wgs84) >= 3 else None

    return None
