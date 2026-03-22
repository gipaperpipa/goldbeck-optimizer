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
            # Store override and notify optimizer on next generation
            logger.info(f"GH parameter override: {data.get('payload', {})}")
            # TODO: Feed back to optimizer
            await self._broadcast({
                "type": "parameter_override_ack",
                "payload": data.get("payload", {}),
            })

        elif msg_type == "request_variant":
            # Client wants a specific variant — handled by API layer
            logger.info(f"GH requested variant: {data.get('payload', {})}")

        elif msg_type == "geometry_edit":
            # Manual geometry edits from Grasshopper
            logger.info(f"GH geometry edit received: {data.get('payload', {}).get('room_id', 'unknown')}")
            # TODO: Validate edit against Goldbeck constraints and feed back

        elif msg_type == "request_full_state":
            # Client is asking for the current state (e.g., after reconnect)
            if self._current_state:
                await self._send(ws, {
                    "type": "full_state",
                    "payload": self._current_state,
                })

        else:
            logger.warning(f"Unknown message type from GH: {msg_type}")

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
            except Exception:
                disconnected.append(ws)

        for ws in disconnected:
            self._active_connections.discard(ws)

    async def _send(self, ws: WebSocket, message: dict):
        """Send a message to a single client."""
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
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
