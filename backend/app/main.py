from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.api.v1.router import api_router
from app.services.ws_sync import ws_sync_endpoint


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize DB on startup, clean up on shutdown."""
    from app.database.engine import init_db, close_db
    await init_db()
    yield
    await close_db()


app = FastAPI(title=settings.app_name, version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")

# WebSocket endpoint for Rhino/Grasshopper live-sync
app.websocket("/ws/sync")(ws_sync_endpoint)


@app.get("/api/health")
async def health_check():
    from app.services.ws_sync import sync_manager
    from app.services.parcel_store import get_stats
    stats = await get_stats()
    return {
        "status": "ok",
        "grasshopper_clients": sync_manager.client_count,
        "db": stats,
    }
