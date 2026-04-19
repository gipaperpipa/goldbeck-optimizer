"""
Floor plan edit-override persistence (Phase 3.7c).

Stores user-edited floor plans server-side so edits sync across devices
and survive browser cache clears. Paired with the Zustand localStorage
cache (Phase 3.7b) — localStorage is the write-through read cache;
this table is the source of truth on cold start / new device.

Endpoints are keyed by (building_id, floor_index). No user scoping yet —
single-tenant until auth lands. Once we wire user_id, add it to the
unique key and filter all reads/writes by it.
"""

import json
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from app.database.engine import get_db
from app.database.models import EditedFloorPlan

router = APIRouter()
logger = logging.getLogger(__name__)


# ── Request / Response Models ─────────────────────────────────────

class OverrideIn(BaseModel):
    """Client payload on PUT — the full edited FloorPlan plus its staleness fingerprint."""
    original_fingerprint: str = Field(..., min_length=1, max_length=64)
    plan: dict  # serialized FloorPlan (opaque to the backend; just stored as JSON)


class OverrideOut(BaseModel):
    building_id: str
    floor_index: int
    original_fingerprint: str
    plan: dict
    saved_at: datetime
    created_at: datetime


class OverrideSummary(BaseModel):
    building_id: str
    floor_index: int
    original_fingerprint: str
    saved_at: datetime


# ── Helpers ───────────────────────────────────────────────────────

def _row_to_out(row: EditedFloorPlan) -> OverrideOut:
    try:
        plan = json.loads(row.plan_json)
    except (TypeError, ValueError):
        logger.warning(
            "Corrupt plan_json for override %s/%s — returning empty dict",
            row.building_id, row.floor_index,
        )
        plan = {}
    return OverrideOut(
        building_id=row.building_id,
        floor_index=row.floor_index,
        original_fingerprint=row.original_fingerprint,
        plan=plan,
        saved_at=row.saved_at,
        created_at=row.created_at,
    )


# ── Endpoints ─────────────────────────────────────────────────────

@router.get("", response_model=list[OverrideSummary])
async def list_overrides():
    """List all stored overrides (summary only — does not include plan JSON).

    Useful on app cold-start to seed the localStorage cache without pulling
    every plan body.
    """
    async with get_db() as session:
        result = await session.execute(select(EditedFloorPlan))
        rows = result.scalars().all()
        return [
            OverrideSummary(
                building_id=r.building_id,
                floor_index=r.floor_index,
                original_fingerprint=r.original_fingerprint,
                saved_at=r.saved_at,
            )
            for r in rows
        ]


@router.get("/{building_id}/{floor_index}", response_model=OverrideOut)
async def get_override(building_id: str, floor_index: int):
    """Fetch the stored edited plan for a given (building, floor) key.

    Returns 404 if none is stored — the client should fall back to the
    server-generated plan.
    """
    async with get_db() as session:
        result = await session.execute(
            select(EditedFloorPlan).where(
                EditedFloorPlan.building_id == building_id,
                EditedFloorPlan.floor_index == floor_index,
            )
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="No override stored")
        return _row_to_out(row)


@router.put("/{building_id}/{floor_index}", response_model=OverrideOut)
async def upsert_override(building_id: str, floor_index: int, payload: OverrideIn):
    """Upsert an override. Client calls this after every committed edit.

    Failures are tolerable: the client's localStorage remains the primary
    cache, so a dropped PUT just means the edit is local-only until the
    next successful call.
    """
    if not building_id:
        raise HTTPException(status_code=400, detail="building_id required")
    if floor_index < 0:
        raise HTTPException(status_code=400, detail="floor_index must be >= 0")

    plan_json = json.dumps(payload.plan, separators=(",", ":"))

    async with get_db() as session:
        result = await session.execute(
            select(EditedFloorPlan).where(
                EditedFloorPlan.building_id == building_id,
                EditedFloorPlan.floor_index == floor_index,
            )
        )
        row = result.scalar_one_or_none()

        if row is None:
            row = EditedFloorPlan(
                building_id=building_id,
                floor_index=floor_index,
                original_fingerprint=payload.original_fingerprint,
                plan_json=plan_json,
            )
            session.add(row)
        else:
            row.original_fingerprint = payload.original_fingerprint
            row.plan_json = plan_json
            # saved_at updates automatically via onupdate=_now

        await session.flush()
        await session.refresh(row)
        return _row_to_out(row)


@router.delete("/{building_id}/{floor_index}")
async def delete_override(building_id: str, floor_index: int):
    """Delete a stored override (idempotent — no-op if missing).

    Called on Reset button click; returns `{ deleted: bool }`.
    """
    async with get_db() as session:
        result = await session.execute(
            delete(EditedFloorPlan).where(
                EditedFloorPlan.building_id == building_id,
                EditedFloorPlan.floor_index == floor_index,
            )
        )
        deleted = (result.rowcount or 0) > 0
        return {"deleted": deleted}


@router.delete("")
async def clear_all_overrides():
    """Delete every stored override. Debug / admin use; not wired to the UI."""
    async with get_db() as session:
        result = await session.execute(delete(EditedFloorPlan))
        return {"deleted_count": result.rowcount or 0}
