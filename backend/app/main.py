import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings, configure_logging
from app.api.v1.router import api_router
from app.services.ws_sync import ws_sync_endpoint

logger = logging.getLogger("api")


# ── Request logging middleware (M4) ──────────────────────────────────

class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.monotonic()
        response = await call_next(request)
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.info(
            "%s %s %d %.0fms",
            request.method, request.url.path, response.status_code, elapsed_ms,
        )
        return response


# ── API version header middleware (M3) ───────────────────────────────

class VersionHeaderMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-API-Version"] = "1.0"
        # L25: Security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response


# ── Rate limiting middleware (L22) ─────────────────────────────────

class RateLimitMiddleware(BaseHTTPMiddleware):
    """Simple in-memory rate limiter: 60 requests/minute per client IP."""

    def __init__(self, app, requests_per_minute: int = 60):
        super().__init__(app)
        self.rpm = requests_per_minute
        self._hits: dict[str, list[float]] = defaultdict(list)

    async def dispatch(self, request: Request, call_next):
        # Skip health checks and docs
        if request.url.path in ("/api/health", "/api/docs", "/api/redoc", "/api/openapi.json"):
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        window = now - 60.0

        # Clean old entries and check
        hits = self._hits[client_ip]
        self._hits[client_ip] = [t for t in hits if t > window]
        if len(self._hits[client_ip]) >= self.rpm:
            return JSONResponse(
                status_code=429,
                content={"detail": "Zu viele Anfragen. Bitte warten Sie eine Minute."},
            )
        self._hits[client_ip].append(now)
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize logging + DB on startup, clean up on shutdown."""
    configure_logging(debug=settings.debug)
    from app.database.engine import init_db, close_db
    await init_db()
    logger.info("Application started (debug=%s)", settings.debug)
    yield
    await close_db()


app = FastAPI(
    title=settings.app_name,
    version="2.0.0",
    lifespan=lifespan,
    # M7: OpenAPI schema customization
    description=(
        "Goldbeck Optimizer API — Genetischer Algorithmus für Gebäudelayout "
        "und Grundrissoptimierung im Goldbeck-Fertigteilsystem."
    ),
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# M5: CORS preflight caching (max_age=600 = 10 minutes)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    max_age=600,
)

app.add_middleware(RequestLoggingMiddleware)
app.add_middleware(VersionHeaderMiddleware)
app.add_middleware(RateLimitMiddleware, requests_per_minute=120)


# ── Request size limit (L23): 10 MB ───────────────────────────────
@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > 10 * 1024 * 1024:
        return JSONResponse(status_code=413, content={"detail": "Request body too large (max 10 MB)"})
    return await call_next(request)

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
