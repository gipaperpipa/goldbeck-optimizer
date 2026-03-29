"""
Parcel API endpoints — cache-first parcel loading, metadata, contacts.

Replaces the old cadastral parcel endpoints with DB-backed versions.
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, field_validator
from typing import Optional

router = APIRouter()


# ── Request / Response Models ─────────────────────────────────────

class ParcelOut(BaseModel):
    id: str = ""
    parcel_id: str = ""
    state: str = ""
    gemarkung: str = ""
    flur_nr: str = ""
    flurstueck_nr: str = ""
    area_sqm: float = 0.0
    polygon_wgs84: list[list[float]] = []
    address_hint: str = ""
    source: str = ""
    centroid_lng: Optional[float] = None
    centroid_lat: Optional[float] = None
    properties: dict = {}
    metadata: Optional[dict] = None
    project_count: int = 0

    @field_validator("parcel_id", "gemarkung", "flurstueck_nr", "flur_nr", mode="before")
    @classmethod
    def coerce_str(cls, v):
        if v is None:
            return ""
        return str(v)


class MetadataUpdate(BaseModel):
    bebauungsplan_nr: Optional[str] = None
    bebauungsplan_url: Optional[str] = None
    bebauungsplan_notes: Optional[str] = None
    zoning_type: Optional[str] = None
    grz: Optional[float] = None
    gfz: Optional[float] = None
    max_height_m: Optional[float] = None
    max_stories: Optional[int] = None
    bauweise: Optional[str] = None
    dachform: Optional[str] = None
    noise_zone: Optional[str] = None
    asking_price_eur: Optional[float] = None
    price_per_sqm: Optional[float] = None
    status: Optional[str] = None
    notes: Optional[str] = None


class ContactLink(BaseModel):
    contact_id: str
    role: str = ""


# ── Endpoints ─────────────────────────────────────────────────────

@router.get("/in-radius")
async def parcels_in_radius(
    lng: float = Query(..., description="Longitude (WGS84)"),
    lat: float = Query(..., description="Latitude (WGS84)"),
    radius_m: float = Query(500.0, description="Radius in meters"),
):
    """
    Cache-first parcel loading.
    Returns parcels from DB; if area is new, fetches from WFS and stores.
    """
    from app.services.parcel_store import get_parcels_in_radius
    from app.services.cadastral import detect_state

    state = detect_state(lng, lat)
    if not state:
        raise HTTPException(404, "Coordinates are outside Germany.")

    parcels = await get_parcels_in_radius(lng, lat, radius_m, state)
    return parcels


@router.get("/at-point")
async def parcel_at_point(
    lng: float = Query(...),
    lat: float = Query(...),
):
    """
    Cache-first single parcel lookup at a click point.
    Checks DB first, then WFS, stores result permanently.
    """
    from app.services.parcel_store import get_or_fetch_parcel_at_point
    from app.services.cadastral import detect_state

    state = detect_state(lng, lat)
    if not state:
        raise HTTPException(404, "Coordinates are outside Germany.")

    try:
        result = await get_or_fetch_parcel_at_point(lng, lat, state)
        return result
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Parcel lookup failed: {e}", exc_info=True)
        raise HTTPException(500, f"Parcel lookup failed: {e}")


@router.get("/stats/overview")
async def parcel_stats():
    """Get overall database statistics."""
    from app.services.parcel_store import get_stats
    return await get_stats()


@router.get("/{parcel_id}")
async def get_parcel(parcel_id: str):
    """Get full parcel detail including metadata, contacts, projects."""
    from app.services.parcel_store import get_parcel_detail
    result = await get_parcel_detail(parcel_id)
    if not result:
        raise HTTPException(404, "Parcel not found")
    return result


@router.put("/{parcel_id}/metadata")
async def update_metadata(parcel_id: str, data: MetadataUpdate):
    """Update user-entered metadata for a parcel."""
    from app.services.parcel_store import update_parcel_metadata
    update_dict = data.model_dump(exclude_none=True)
    if not update_dict:
        raise HTTPException(400, "No fields to update")
    result = await update_parcel_metadata(parcel_id, update_dict)
    if not result:
        raise HTTPException(404, "Parcel not found")
    return result


@router.post("/{parcel_id}/contacts")
async def link_contact(parcel_id: str, data: ContactLink):
    """Link a contact to a parcel."""
    from app.services.project_store import link_contact_to_parcel
    await link_contact_to_parcel(parcel_id, data.contact_id, data.role)
    return {"ok": True}
