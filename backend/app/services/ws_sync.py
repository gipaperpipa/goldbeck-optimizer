"""
WebSocket live-sync server for Rhino/Grasshopper integration.

Broadcasts optimizer state (floor plans, progress, variants) to connected
Grasshopper clients in real time. Supports bidirectional communication:
  - Server → GH: layout updates, progress, variant selection
  - GH → Server: parameter overrides, manual edits, constraint changes

Protocol: JSON messages with { "type": "...", "payload": {...} }
"""

import asyncio
import json
import logging
from typing import Optional
from weakref import WeakSet

from fastapi import WebSocket, WebSocketDisconnect
from app.services.floorplan import goldbeck_constants as C

logger = logging.getLogger("ws_sync")


class SyncManager:
    """Manages WebSocket connections and broadcasts to Grasshopper clients."""

    def __init__(self):
        self._clients: WeakSet[WebSocket] = WeakSet()
        self._active_connections: set[WebSocket] = set()
        self._current_state: Optional[dict] = None
        self._lock = asyncio.Lock()

    @property
    def client_count(self) -> int:
        return len(self._active_connections)

    async def connect(self, ws: WebSocket):
        """Accept a new Grasshopper client connection."""
        await ws.accept()
        self._active_connections.add(ws)
        logger.info(f"GH client connected. Total: {self.client_count}")

        # Send current state immediately so client gets up to speed
        if self._current_state:
            await self._send(ws, {
                "type": "full_state",
                "payload": self._current_state,
            })

    async def disconnect(self, ws: WebSocket):
        """Remove a disconnected client."""
        self._active_connections.discard(ws)
        logger.info(f"GH client disconnected. Total: {self.client_count}")

    async def broadcast_floor_plans(self, building_floor_plans: dict):
        """Broadcast complete floor plan data to all connected GH clients.

        Called by the optimizer after each generation or when a new best
        solution is found. The payload matches BuildingFloorPlans schema.
        """
        message = {
            "type": "floor_plans",
            "payload": building_floor_plans,
        }
        self._current_state = building_floor_plans
        await self._broadcast(message)

    async def broadcast_progress(
        self,
        generation: int,
        total: int,
        best_fitness: float,
        avg_fitness: float = 0.0,
    ):
        """Broadcast optimization progress."""
        await self._broadcast({
            "type": "progress",
            "payload": {
                "generation": generation,
                "total_generations": total,
                "best_fitness": round(best_fitness, 4),
                "avg_fitness": round(avg_fitness, 4),
                "pct": round((generation / total) * 100, 1) if total > 0 else 0,
            },
        })

    async def broadcast_variant_selected(self, variant_index: int, variant: dict):
        """Broadcast when user selects a specific variant to view."""
        await self._broadcast({
            "type": "variant_selected",
            "payload": {
                "variant_index": variant_index,
                "building_floor_plans": variant.get("building_floor_plans", {}),
                "fitness_score": variant.get("fitness_score", 0),
                "fitness_breakdown": variant.get("fitness_breakdown", {}),
            },
        })

    async def broadcast_optimization_complete(self, variants: list[dict]):
        """Broadcast when optimization finishes with all variants."""
        await self._broadcast({
            "type": "optimization_complete",
            "payload": {
                "num_variants": len(variants),
                "best_variant": variants[0] if variants else None,
            },
        })

    async def handle_client_message(self, ws: WebSocket, data: dict):
        """Process a message received FROM Grasshopper.

        Supported message types:
          - parameter_override: GH user changed a parameter manually
          - constraint_update: GH user added/removed a constraint
          - geometry_edit: GH user manually adjusted room geometry
          - request_variant: GH user wants to see a specific variant
          - ping: keep-alive
        """
        msg_type = data.get("type", "unknown")

        if msg_type == "ping":
            await self._send(ws, {"type": "pong"})

        elif msg_type == "parameter_override":
            payload = data.get("payload", {})
            logger.info(f"GH parameter override: {payload}")
            # Validate overrides against Goldbeck constraints
            violations = self._validate_parameter_override(payload)
            if violations:
                await self._send(ws, {
                    "type": "parameter_override_rejected",
                    "payload": {"violations": violations, "original": payload},
                })
            else:
                await self._broadcast({
                    "type": "parameter_override_ack",
                    "payload": payload,
                })

        elif msg_type == "request_variant":
            # Client wants a specific variant — handled by API layer
            logger.info(f"GH requested variant: {data.get('payload', {})}")

        elif msg_type == "geometry_edit":
            payload = data.get("payload", {})
            room_id = payload.get("room_id", "unknown")
            logger.info(f"GH geometry edit received: {room_id}")
            # Validate edit against Goldbeck constraints
            violations = self._validate_geometry_edit(payload)
            if violations:
                await self._send(ws, {
                    "type": "geometry_edit_rejected",
                    "payload": {"room_id": room_id, "violations": violations},
                })
            else:
                await self._send(ws, {
                    "type": "geometry_edit_ack",
                    "payload": {"room_id": room_id},
                })

        elif msg_type == "request_full_state":
            # Client is asking for the current state (e.g., after reconnect)
            if self._current_state:
                await self._send(ws, {
                    "type": "full_state",
                    "payload": self._current_state,
                })

        else:
            logger.warning(f"Unknown message type from GH: {msg_type}")

    # --- Validation ---

    @staticmethod
    def _validate_parameter_override(payload: dict) -> list[str]:
        """Validate parameter overrides against Goldbeck system constraints."""
        violations = []
        if "bay_width_m" in payload:
            bw = payload["bay_width_m"]
            if bw not in C.STANDARD_RASTERS:
                violations.append(
                    f"Bay width {bw}m not in Goldbeck grid. "
                    f"Allowed: {C.STANDARD_RASTERS}"
                )
        if "story_height_m" in payload:
            sh = payload["story_height_m"]
            valid_heights = (
                C.STORY_HEIGHT_STANDARD_A, C.STORY_HEIGHT_STANDARD_B,
                C.STORY_HEIGHT_ELEVATED_GF, C.STORY_HEIGHT_ELEVATED_GF_B,
            )
            if sh not in valid_heights:
                violations.append(
                    f"Story height {sh}m not valid. Allowed: {valid_heights}"
                )
        if "building_depth_m" in payload:
            depth = payload["building_depth_m"]
            if depth < 6.0 or depth > 16.0:
                violations.append(f"Building depth {depth}m out of range (6.0–16.0m)")
        return violations

    @staticmethod
    def _validate_geometry_edit(payload: dict) -> list[str]:
        """Validate a manual geometry edit against Goldbeck constraints."""
        violations = []
        grid = C.GRID_UNIT  # 0.625m
        # Check wall positions snap to 62.5cm grid (Schottwand)
        if "wall_position_m" in payload:
            pos = payload["wall_position_m"]
            remainder = round(pos % grid, 4)
            if remainder > 0.001 and abs(remainder - grid) > 0.001:
                violations.append(
                    f"Wall position {pos}m doesn't snap to {grid}m grid"
                )
        # Check room width is a multiple of grid module
        if "room_width_m" in payload:
            rw = payload["room_width_m"]
            remainder = round(rw % grid, 4)
            if remainder > 0.001 and abs(remainder - grid) > 0.001:
                violations.append(
                    f"Room width {rw}m not a multiple of {grid}m grid"
                )
        # Check minimum room area
        if "room_area_sqm" in payload:
            area = payload["room_area_sqm"]
            room_type = payload.get("room_type", "")
            min_area = {
                "bedroom": 8.0, "living": 14.0, "kitchen": 6.0,
                "bathroom": 3.5, "hallway": 2.0,
            }.get(room_type, 4.0)
            if area < min_area:
                violations.append(
                    f"Room area {area}m² below minimum {min_area}m² for {room_type or 'room'}"
                )
        return violations

    # --- Internal ---

    async def _broadcast(self, message: dict):
        """Send a message to all connected clients."""
        if not self._active_connections:
            return

        data = json.dumps(message)
        disconnected = []

        for ws in self._active_connections:
            try:
                await ws.send_text(data)
            except Exception as e:
                logger.debug(f"WS send failed, marking client disconnected: {e}")
                disconnected.append(ws)

        for ws in disconnected:
            self._active_connections.discard(ws)

    async def _send(self, ws: WebSocket, message: dict):
        """Send a message to a single client."""
        try:
            await ws.send_text(json.dumps(message))
        except Exception as e:
            logger.debug(f"WS direct send failed: {e}")
            self._active_connections.discard(ws)


# Singleton instance
sync_manager = SyncManager()


async def ws_sync_endpoint(websocket: WebSocket):
    """FastAPI WebSocket endpoint for Grasshopper live-sync.

    Mount this at /ws/sync in your app.
    """
    await sync_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            await sync_manager.handle_client_message(websocket, data)
    except WebSocketDisconnect:
        await sync_manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        await sync_manager.disconnect(websocket)
