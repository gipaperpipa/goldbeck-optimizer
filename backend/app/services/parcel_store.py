"""
Cache-first parcel store.

The core idea: never depend on live WFS for the user experience.
1. Check the local SQLite DB first (instant).
2. If not found, fetch from WFS (BKG → State → Overpass) and store permanently.
3. Return results from DB.

Over time this builds a comprehensive cadastral mirror of every area explored.
"""

import json
import logging
import math
from datetime import datetime, timezone
from typing import Optional

from shapely.geometry import Polygon, shape, mapping
from sqlalchemy import select, and_, func, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.engine import get_db
from app.database.models import (
    Parcel,
    ParcelMetadata,
    Contact,
    ParcelContact,
    Project,
    ProjectParcel,
    TimelineEntry,
)

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════

def _bbox_from_center(lng: float, lat: float, radius_m: float) -> tuple[float, float, float, float]:
    """Approximate bounding box from center + radius in meters."""
    # 1 degree lat ≈ 111320m, 1 degree lng ≈ 111320 * cos(lat)
    dlat = radius_m / 111320.0
    dlng = radius_m / (111320.0 * math.cos(math.radians(lat)))
    return (lng - dlng, lat - dlat, lng + dlng, lat + dlat)


def _polygon_wgs84_to_geojson(coords: list[list[float]]) -> str:
    """Convert [[lng,lat],...] to GeoJSON Polygon string."""
    # Ensure ring is closed
    ring = [c[:2] for c in coords]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    geojson = {"type": "Polygon", "coordinates": [ring]}
    return json.dumps(geojson)


def _geojson_to_polygon_wgs84(geojson_str: str) -> list[list[float]]:
    """Convert GeoJSON Polygon string back to [[lng,lat],...] (open ring)."""
    geojson = json.loads(geojson_str)
    ring = geojson.get("coordinates", [[]])[0]
    # Return open ring (remove closing duplicate)
    if len(ring) > 1 and ring[0] == ring[-1]:
        ring = ring[:-1]
    return ring


def _centroid(coords: list[list[float]]) -> tuple[float, float]:
    """Compute centroid of a polygon given as [[lng,lat],...]."""
    if not coords:
        return (0.0, 0.0)
    n = len(coords)
    clng = sum(c[0] for c in coords) / n
    clat = sum(c[1] for c in coords) / n
    return (clng, clat)


def _parcel_to_dict(p: Parcel) -> dict:
    """Convert ORM Parcel to API-compatible dict."""
    polygon_wgs84 = []
    if p.geometry_geojson:
        try:
            polygon_wgs84 = _geojson_to_polygon_wgs84(p.geometry_geojson)
        except Exception as e:
            logger.warning(f"Failed to parse GeoJSON for parcel {p.id}: {e}")

    props = {}
    if p.raw_properties:
        try:
            props = json.loads(p.raw_properties)
        except Exception as e:
            logger.warning(f"Failed to parse raw_properties for parcel {p.id}: {e}")

    result = {
        "id": p.id,
        "parcel_id": p.cadastral_ref or p.id,
        "state": p.state or "",
        "gemarkung": p.gemarkung or "",
        "flur_nr": p.flur_nr or "",
        "flurstueck_nr": p.flurstueck_nr or "",
        "area_sqm": p.area_sqm or 0.0,
        "polygon_wgs84": polygon_wgs84,
        "address_hint": p.address_hint or "",
        "source": p.source or "",
        "properties": props,
        "centroid_lng": p.centroid_lng,
        "centroid_lat": p.centroid_lat,
    }

    # Include metadata if loaded
    if p.metadata_rel:
        m = p.metadata_rel
        result["metadata"] = {
            "bebauungsplan_nr": m.bebauungsplan_nr or "",
            "bebauungsplan_url": m.bebauungsplan_url or "",
            "zoning_type": m.zoning_type or "",
            "grz": m.grz,
            "gfz": m.gfz,
            "max_height_m": m.max_height_m,
            "max_stories": m.max_stories,
            "bauweise": m.bauweise or "",
            "status": m.status or "available",
            "asking_price_eur": m.asking_price_eur,
            "price_per_sqm": m.price_per_sqm,
            "notes": m.notes or "",
        }

    # Include project count
    if p.project_links is not None:
        result["project_count"] = len(p.project_links)

    return result


# ═══════════════════════════════════════════════════════════════════
# STORE A PARCEL (from WFS result dict → DB)
# ═══════════════════════════════════════════════════════════════════

async def store_parcel_from_wfs(session: AsyncSession, wfs_result: dict) -> Optional[Parcel]:
    """
    Store a parcel dict (from cadastral.py WFS functions) into the DB.
    If a parcel with the same cadastral_ref already exists, return existing.
    """
    cadastral_ref = str(wfs_result.get("parcel_id", ""))
    if not cadastral_ref or cadastral_ref == "synthetic":
        return None

    # Check if already stored
    stmt = select(Parcel).where(Parcel.cadastral_ref == cadastral_ref)
    result = await session.execute(stmt)
    existing = result.scalar_one_or_none()
    if existing:
        return existing

    polygon_wgs84 = wfs_result.get("polygon_wgs84", [])
    geojson_str = ""
    clng, clat = 0.0, 0.0
    area = wfs_result.get("area_sqm", 0.0)

    if polygon_wgs84 and len(polygon_wgs84) >= 3:
        geojson_str = _polygon_wgs84_to_geojson(polygon_wgs84)
        clng, clat = _centroid(polygon_wgs84)
        # Compute area from geometry if not provided
        if not area:
            try:
                poly = shape(json.loads(geojson_str))
                # Very rough: degrees² → m² (only for small polygons in Germany)
                area = poly.area * (111320 ** 2) * math.cos(math.radians(clat))
            except Exception as e:
                logger.warning(f"Area computation from geometry failed: {e}")

    props = wfs_result.get("properties", {})

    parcel = Parcel(
        cadastral_ref=cadastral_ref,
        state=wfs_result.get("state", ""),
        gemarkung=wfs_result.get("gemarkung", props.get("gemarkung", "")),
        flur_nr=wfs_result.get("flur_nr", props.get("flur_nr", "")),
        flurstueck_nr=wfs_result.get("flurstueck_nr", props.get("flurstueck_nr", "")),
        geometry_geojson=geojson_str,
        area_sqm=area,
        centroid_lng=clng,
        centroid_lat=clat,
        source=props.get("source", wfs_result.get("source", "wfs")),
        raw_properties=json.dumps(props, default=str),
    )
    session.add(parcel)
    await session.flush()

    # Create empty metadata record
    meta = ParcelMetadata(parcel_id=parcel.id)
    session.add(meta)

    return parcel


async def store_many_parcels_from_wfs(wfs_results: list[dict]) -> int:
    """Store multiple WFS parcel dicts. Returns count of newly stored."""
    count = 0
    async with get_db() as session:
        for r in wfs_results:
            p = await store_parcel_from_wfs(session, r)
            if p:
                count += 1
    return count


# ═══════════════════════════════════════════════════════════════════
# CACHE-FIRST PARCEL LOADING (the key function)
# ═══════════════════════════════════════════════════════════════════

async def get_parcels_in_radius(
    lng: float,
    lat: float,
    radius_m: float = 500.0,
    state: Optional[str] = None,
) -> list[dict]:
    """
    Cache-first parcel loading:
    1. Query local DB for parcels in bounding box
    2. If few results, trigger WFS fetch and store
    3. Return all parcels (DB + newly fetched)
    """
    min_lng, min_lat, max_lng, max_lat = _bbox_from_center(lng, lat, radius_m)

    # Step 1: Check local DB
    async with get_db() as session:
        stmt = (
            select(Parcel)
            .where(
                and_(
                    Parcel.centroid_lng >= min_lng,
                    Parcel.centroid_lng <= max_lng,
                    Parcel.centroid_lat >= min_lat,
                    Parcel.centroid_lat <= max_lat,
                )
            )
            .limit(500)
        )
        result = await session.execute(stmt)
        db_parcels = list(result.scalars().all())

    # Step 2: If we have fewer than 5 parcels, try WFS fetch
    # Hard timeout of 20s to stay within Railway's ~30s response limit
    if len(db_parcels) < 5:
        import asyncio

        logger.info(
            f"Only {len(db_parcels)} parcels in DB for ({lng:.5f}, {lat:.5f}) r={radius_m}m, "
            f"triggering WFS fetch..."
        )
        try:
            from app.services.cadastral import get_parcels_in_bbox, detect_state

            if not state:
                state = detect_state(lng, lat)

            wfs_parcels = await asyncio.wait_for(
                get_parcels_in_bbox(min_lng, min_lat, max_lng, max_lat, state=state),
                timeout=15.0,
            )

            if wfs_parcels:
                logger.info(f"WFS bbox returned {len(wfs_parcels)} parcels, storing...")
                await store_many_parcels_from_wfs(wfs_parcels)
            else:
                logger.warning(
                    f"WFS bbox returned 0 parcels for ({lng:.5f}, {lat:.5f}) in {state}"
                )

            # Re-query DB to get stored parcels with IDs
            async with get_db() as session:
                stmt = (
                    select(Parcel)
                    .where(
                        and_(
                            Parcel.centroid_lng >= min_lng,
                            Parcel.centroid_lng <= max_lng,
                            Parcel.centroid_lat >= min_lat,
                            Parcel.centroid_lat <= max_lat,
                        )
                    )
                    .limit(500)
                )
                result = await session.execute(stmt)
                db_parcels = list(result.scalars().all())
        except asyncio.TimeoutError:
            logger.warning(
                f"WFS fetch timed out (15s) for ({lng:.5f}, {lat:.5f}) in {state or 'unknown'}"
            )
        except Exception as e:
            logger.error(f"WFS fetch failed: {e}", exc_info=True)

    return [_parcel_to_dict(p) for p in db_parcels]


# ═══════════════════════════════════════════════════════════════════
# SINGLE-PARCEL CACHE-FIRST LOADING (for click-to-select)
# ═══════════════════════════════════════════════════════════════════

async def get_or_fetch_parcel_at_point(lng: float, lat: float, state: Optional[str] = None) -> dict:
    """
    Cache-first single parcel lookup.
    1. Check DB for parcel containing point
    2. If not found, fetch via WFS and store
    3. Return parcel dict
    """
    # Check DB first — find nearby parcels and check containment
    bbox = _bbox_from_center(lng, lat, 100.0)
    async with get_db() as session:
        stmt = (
            select(Parcel)
            .where(
                and_(
                    Parcel.centroid_lng >= bbox[0],
                    Parcel.centroid_lng <= bbox[2],
                    Parcel.centroid_lat >= bbox[1],
                    Parcel.centroid_lat <= bbox[3],
                    Parcel.geometry_geojson.isnot(None),
                )
            )
            .limit(50)
        )
        result = await session.execute(stmt)
        candidates = list(result.scalars().all())

    # Check which parcel contains the click point
    from shapely.geometry import Point
    click_point = Point(lng, lat)
    for p in candidates:
        if p.geometry_geojson:
            try:
                geom = shape(json.loads(p.geometry_geojson))
                if geom.contains(click_point):
                    return _parcel_to_dict(p)
            except Exception as e:
                logger.warning(f"Geometry check failed for parcel {p.id}: {e}")
                continue

    # Not in DB — fetch from WFS
    logger.info(f"Parcel at ({lng:.5f}, {lat:.5f}) not in DB, fetching from WFS...")
    try:
        from app.services.cadastral import get_parcel_geometry_at_point, detect_state

        if not state:
            state = detect_state(lng, lat)

        wfs_result = await get_parcel_geometry_at_point(lng, lat, state)
        if wfs_result and wfs_result.get("polygon_wgs84"):
            # Store it
            async with get_db() as session:
                parcel = await store_parcel_from_wfs(session, wfs_result)
                if parcel:
                    return _parcel_to_dict(parcel)

            # If store returned None (synthetic), return the WFS result directly
            return wfs_result
    except Exception as e:
        logger.error(f"WFS point lookup failed: {e}", exc_info=True)

    # Last resort: return empty
    return {
        "parcel_id": "not_found",
        "state": state or "",
        "polygon_wgs84": [],
        "area_sqm": 0,
        "properties": {"error": "No parcel data available"},
    }


# ═══════════════════════════════════════════════════════════════════
# PARCEL METADATA CRUD
# ═══════════════════════════════════════════════════════════════════

async def update_parcel_metadata(parcel_id: str, data: dict) -> Optional[dict]:
    """Update user-entered metadata for a parcel."""
    async with get_db() as session:
        stmt = select(ParcelMetadata).where(ParcelMetadata.parcel_id == parcel_id)
        result = await session.execute(stmt)
        meta = result.scalar_one_or_none()

        if not meta:
            # Create if it doesn't exist
            meta = ParcelMetadata(parcel_id=parcel_id)
            session.add(meta)

        # Update fields
        for key, value in data.items():
            if hasattr(meta, key) and key != "parcel_id":
                setattr(meta, key, value)

        meta.updated_at = datetime.now(timezone.utc)
        await session.flush()

        return {
            "parcel_id": meta.parcel_id,
            "bebauungsplan_nr": meta.bebauungsplan_nr,
            "zoning_type": meta.zoning_type,
            "grz": meta.grz,
            "gfz": meta.gfz,
            "max_height_m": meta.max_height_m,
            "max_stories": meta.max_stories,
            "status": meta.status,
            "asking_price_eur": meta.asking_price_eur,
            "notes": meta.notes,
        }


async def get_parcel_detail(parcel_id: str) -> Optional[dict]:
    """Get full parcel detail including metadata, contacts, projects."""
    async with get_db() as session:
        stmt = select(Parcel).where(Parcel.id == parcel_id)
        result = await session.execute(stmt)
        parcel = result.scalar_one_or_none()
        if not parcel:
            # Try by cadastral_ref
            stmt = select(Parcel).where(Parcel.cadastral_ref == parcel_id)
            result = await session.execute(stmt)
            parcel = result.scalar_one_or_none()

        if not parcel:
            return None

        d = _parcel_to_dict(parcel)

        # Load contacts
        stmt = (
            select(ParcelContact, Contact)
            .join(Contact, ParcelContact.contact_id == Contact.id)
            .where(ParcelContact.parcel_id == parcel.id)
        )
        result = await session.execute(stmt)
        d["contacts"] = [
            {
                "contact_id": c.id,
                "name": c.name,
                "company": c.company,
                "email": c.email,
                "phone": c.phone,
                "type": c.type,
                "role": pc.role,
            }
            for pc, c in result.all()
        ]

        # Load projects
        stmt = (
            select(ProjectParcel, Project)
            .join(Project, ProjectParcel.project_id == Project.id)
            .where(ProjectParcel.parcel_id == parcel.id)
        )
        result = await session.execute(stmt)
        d["projects"] = [
            {
                "project_id": proj.id,
                "name": proj.name,
                "status": proj.status,
                "role": pp.role,
            }
            for pp, proj in result.all()
        ]

        return d


# ═══════════════════════════════════════════════════════════════════
# STATISTICS
# ═══════════════════════════════════════════════════════════════════

async def get_stats() -> dict:
    """Get overall database statistics."""
    async with get_db() as session:
        parcel_count = (await session.execute(select(func.count(Parcel.id)))).scalar() or 0
        project_count = (await session.execute(select(func.count(Project.id)))).scalar() or 0
        contact_count = (await session.execute(select(func.count(Contact.id)))).scalar() or 0
        timeline_count = (await session.execute(select(func.count(TimelineEntry.id)))).scalar() or 0

        return {
            "total_parcels": parcel_count,
            "total_projects": project_count,
            "total_contacts": contact_count,
            "total_timeline_entries": timeline_count,
        }
