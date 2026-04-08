"""
Cadastral API endpoints for German parcel/Flurstück data.

Provides:
- Address search (German geocoding via Nominatim)
- WMS tile proxy (cadastral map overlay)
- Parcel info at click point (WFS GetFeatureInfo)
- Parcel geometry (WFS GetFeature)
- Multi-parcel merge (combine selected parcels into one plot)
"""

import logging

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, field_validator

from app.services.cadastral import (
    geocode_german_address,
    detect_state,
    get_state_service,
    proxy_wms_request,
    get_parcel_info_at_point,
    get_parcel_geometry_at_point,
    get_parcels_in_bbox,
    wgs84_to_utm,
    utm_to_wgs84,
)
from app.services.geometry_engine import GeometryEngine
from app.models.plot import PlotAnalysis, CoordinatePoint

router = APIRouter()
logger = logging.getLogger(__name__)
geometry = GeometryEngine()


# ── Models ───────────────────────────────────────────────────────────────

class AddressSearchResult(BaseModel):
    display_name: str
    lat: float
    lng: float
    type: str
    importance: float
    bbox: list[str] | None = None
    state: str = ""


class ParcelInfo(BaseModel):
    parcel_id: str = ""
    gemarkung: str = ""
    flurstueck_nr: str = ""
    area_sqm: float = 0.0
    width_m: float = 0.0
    depth_m: float = 0.0
    perimeter_m: float = 0.0
    polygon_wgs84: list[list[float]] = []
    state: str = ""
    properties: dict = {}

    @field_validator("parcel_id", "gemarkung", "flurstueck_nr", mode="before")
    @classmethod
    def coerce_to_str(cls, v):
        """WFS services sometimes return numeric IDs — coerce to string."""
        if v is None:
            return ""
        return str(v)


class MergeRequest(BaseModel):
    parcels: list[ParcelInfo]


# ── Endpoints ────────────────────────────────────────────────────────────

@router.get("/search", response_model=list[AddressSearchResult])
async def search_address(
    q: str = Query(..., description="Address search query"),
    limit: int = Query(5, ge=1, le=10),
):
    """Search for German addresses using Nominatim."""
    try:
        results = await geocode_german_address(q, limit=limit)
        return [AddressSearchResult(**r) for r in results]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Geocoding failed: {str(e)}")


@router.get("/state")
async def get_state_at_point(
    lng: float = Query(...),
    lat: float = Query(...),
):
    """Detect which German state a coordinate falls in."""
    state = detect_state(lng, lat)
    if not state:
        raise HTTPException(status_code=404, detail="Coordinates not in Germany")

    service = get_state_service(state)
    return {
        "state": state,
        "has_wms": service is not None,
        "has_wfs": service is not None,
        "crs": service["crs"] if service else None,
        "wms_layers": service["wms_layers"] if service else None,
    }


@router.get("/wms/tile")
async def wms_tile_proxy(
    state: str = Query(..., description="German state name"),
    bbox: str = Query(..., description="Bounding box in WMS format"),
    width: int = Query(256),
    height: int = Query(256),
    crs: str = Query("EPSG:3857"),
):
    """
    Proxy WMS GetMap requests to state geoportals.
    This solves CORS issues — the frontend calls our backend, which calls the state WMS.
    Accepts EPSG:3857 (web mercator) bbox from Mapbox and reprojects to the state's
    native CRS if needed, since many German WMS services don't support EPSG:3857.
    """
    from pyproj import Transformer

    service = get_state_service(state)
    if not service:
        raise HTTPException(status_code=404, detail=f"No WMS service for state: {state}")

    native_crs = service["crs"]
    request_crs = crs
    request_bbox = bbox

    # Reproject from EPSG:3857 → state native CRS if different
    if crs == "EPSG:3857" and native_crs != "EPSG:3857":
        try:
            transformer = Transformer.from_crs("EPSG:3857", native_crs, always_xy=True)
            parts = [float(x) for x in bbox.split(",")]
            min_x, min_y = transformer.transform(parts[0], parts[1])
            max_x, max_y = transformer.transform(parts[2], parts[3])
            # WMS 1.3.0 with EPSG:25832/25833 uses easting,northing order
            request_bbox = f"{min_x},{min_y},{max_x},{max_y}"
            request_crs = native_crs
        except Exception as e:
            logger.warning(f"CRS reprojection failed, using EPSG:3857: {e}")

    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": service["wms_layers"],
        "CRS": request_crs,
        "BBOX": request_bbox,
        "WIDTH": width,
        "HEIGHT": height,
        "FORMAT": "image/png",
        "TRANSPARENT": "TRUE",
        "STYLES": "",
    }

    try:
        content, content_type = await proxy_wms_request(state, params)
        return Response(
            content=content,
            media_type=content_type,
            headers={"Cache-Control": "public, max-age=86400"},  # Cache tiles for 24h
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"WMS request failed: {str(e)}")


@router.get("/parcel/at-point", response_model=ParcelInfo | None)
async def parcel_at_point(
    lng: float = Query(...),
    lat: float = Query(...),
):
    """
    Get parcel (Flurstück) geometry at a clicked point.

    Queries multiple sources concurrently (BKG, State WFS, Nominatim, Overpass)
    and returns the best available result. Falls back to a synthetic rectangular
    parcel if all sources fail, so the user can always proceed.
    """
    state = detect_state(lng, lat)
    if not state:
        raise HTTPException(
            status_code=404,
            detail="Coordinates are outside Germany. Please click within German borders."
        )

    try:
        # Multi-source concurrent lookup (always returns a result)
        result = await get_parcel_geometry_at_point(lng, lat, state)
        if result:
            info = ParcelInfo(**result)
            # Surface a warning when all real sources failed
            if result.get("parcel_id") == "synthetic":
                source_note = result.get("properties", {}).get("source", "")
                if source_note == "synthetic_rectangle":
                    info.properties = {
                        **(info.properties or {}),
                        "warning": (
                            f"Keine Katasterdaten für {state} verfügbar. "
                            "Platzhalter-Flurstück erstellt — bitte manuell anpassen."
                        ),
                    }
                    logger.info(f"Returning synthetic parcel for ({lng:.5f}, {lat:.5f}) in {state}")
            return info

        # Should not reach here (synthetic fallback always succeeds), but just in case
        return ParcelInfo(
            state=state,
            properties={"note": "No parcel data available for this location."},
        )
    except Exception as e:
        logger.error(f"Parcel lookup failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Parcel lookup failed: {str(e)}. Please try again or click a different location."
        )


@router.get("/parcels/in-bbox", response_model=list[ParcelInfo])
async def parcels_in_bbox(
    min_lng: float = Query(...),
    min_lat: float = Query(...),
    max_lng: float = Query(...),
    max_lat: float = Query(...),
):
    """Get all parcels within a bounding box via WFS."""
    results = await get_parcels_in_bbox(min_lng, min_lat, max_lng, max_lat)
    return [ParcelInfo(**r) for r in results]


@router.post("/parcels/merge", response_model=PlotAnalysis)
async def merge_parcels(req: MergeRequest):
    """
    Merge multiple selected parcels into a single plot boundary.
    Returns a PlotAnalysis with the combined polygon.
    """
    if not req.parcels:
        raise HTTPException(status_code=400, detail="No parcels provided")

    # Collect all polygon coordinates
    all_coords = []
    for parcel in req.parcels:
        if parcel.polygon_wgs84:
            for coord in parcel.polygon_wgs84:
                all_coords.append((coord[0], coord[1]))  # (lng, lat)

    if len(all_coords) < 3:
        raise HTTPException(status_code=400, detail="Insufficient polygon data to merge")

    if len(req.parcels) == 1 and req.parcels[0].polygon_wgs84:
        # Single parcel — use its exact polygon
        coords = [(c[0], c[1]) for c in req.parcels[0].polygon_wgs84]
        analysis = geometry.analyze_from_geo_coordinates(coords)

        # Enrich with parcel info
        p = req.parcels[0]
        address_parts = [p.gemarkung, f"Flst. {p.flurstueck_nr}"] if p.gemarkung else []
        if address_parts:
            analysis.address_resolved = ", ".join(filter(None, address_parts))

        return analysis

    else:
        # Multiple parcels — merge polygons using Shapely union
        from shapely.geometry import Polygon as ShapelyPolygon
        from shapely import ops
        import math

        polygons = []
        for parcel in req.parcels:
            if parcel.polygon_wgs84 and len(parcel.polygon_wgs84) >= 3:
                ring = [(c[0], c[1]) for c in parcel.polygon_wgs84]
                poly = ShapelyPolygon(ring)
                if poly.is_valid:
                    polygons.append(poly)
                else:
                    polygons.append(poly.buffer(0))

        if not polygons:
            raise HTTPException(status_code=400, detail="No valid polygons to merge")

        merged = ops.unary_union(polygons)
        if merged.geom_type == "MultiPolygon":
            # Take the largest polygon
            merged = max(merged.geoms, key=lambda g: g.area)

        # Get the exterior ring coordinates
        exterior_coords = list(merged.exterior.coords)
        coords = [(c[0], c[1]) for c in exterior_coords[:-1]]  # remove closing duplicate

        analysis = geometry.analyze_from_geo_coordinates(coords)

        # Combine parcel info for address
        gemarkungen = set(p.gemarkung for p in req.parcels if p.gemarkung)
        flst_nrs = [p.flurstueck_nr for p in req.parcels if p.flurstueck_nr]
        parts = []
        if gemarkungen:
            parts.append(", ".join(gemarkungen))
        if flst_nrs:
            parts.append(f"Flst. {', '.join(flst_nrs)}")
        if parts:
            analysis.address_resolved = " — ".join(parts)

        return analysis
