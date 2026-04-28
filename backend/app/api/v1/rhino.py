"""
Manual Rhino / Grasshopper sync endpoint (Phase 14b).

The optimizer pipeline already broadcasts the best variant over the
WebSocket channel each time a generation completes. This endpoint lets
the frontend re-broadcast a specific BuildingFloorPlans on demand —
the workspace's "An Rhino senden" button uses it so the architect can
push the currently selected layout to Rhino without re-running the
optimizer.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from app.models.floorplan import BuildingFloorPlans
from app.services.ws_sync import sync_manager

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/sync")
async def push_to_rhino(plans: BuildingFloorPlans) -> dict:
    """Broadcast the supplied floor plans to all connected GH clients.

    Returns the number of clients that received the payload. When no
    Grasshopper instance is connected we still 200 — the caller can
    show a "no clients connected" toast based on the count.
    """
    client_count = sync_manager.client_count
    if client_count == 0:
        return {
            "ok": True,
            "client_count": 0,
            "message": "No Grasshopper clients connected.",
        }

    try:
        payload = plans.model_dump()
        await sync_manager.broadcast_floor_plans(payload)
    except Exception as exc:  # noqa: BLE001 — log + surface a friendly error
        logger.warning("Rhino sync failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Broadcast failed: {exc}") from None

    return {
        "ok": True,
        "client_count": client_count,
        "message": f"Floor plans broadcast to {client_count} client(s).",
    }


@router.get("/status")
async def rhino_status() -> dict:
    """Lightweight liveness check the workspace status bar can poll
    to display the Rhino-connected dot."""
    return {
        "connected": sync_manager.client_count > 0,
        "client_count": sync_manager.client_count,
    }
