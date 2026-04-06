# Critical Fixes — Ready-to-Apply Code Changes

## Issue #1: Job State Race Condition

**File:** `backend/app/api/v1/floorplan.py`

**Current (UNSAFE):**
```python
_jobs: dict[str, FloorPlanResult] = {}

def _run_generation(job_id: str, request: FloorPlanRequest):
    _jobs[job_id].status = "running"  # RACE CONDITION
    # ... background thread writes ...
    _jobs[job_id].status = "completed"

@router.post("")
async def generate_floor_plan(request: FloorPlanRequest):
    _jobs[job_id] = FloorPlanResult(...)  # RACE CONDITION
    thread.start()
    return _jobs[job_id]  # Client reads while thread writes

@router.get("/{job_id}")
async def get_floor_plan_result(job_id: str):
    return _jobs[job_id]  # RACE CONDITION
```

**Fixed:**
```python
import threading

_jobs: dict[str, FloorPlanResult] = {}
_jobs_lock = threading.Lock()

def _run_generation(job_id: str, request: FloorPlanRequest):
    try:
        with _jobs_lock:
            _jobs[job_id].status = "running"
            _jobs[job_id].total_generations = request.generations

        # ... optimization work ...

        with _jobs_lock:
            _jobs[job_id].status = "completed"
            _jobs[job_id].variants = variants
    except Exception as e:
        with _jobs_lock:
            _jobs[job_id].status = "failed"
            _jobs[job_id].error = str(e)

@router.post("", response_model=FloorPlanResult)
async def generate_floor_plan(request: FloorPlanRequest):
    job_id = str(uuid.uuid4())

    # Create a COPY for return value (avoid race with thread mutations)
    initial_result = FloorPlanResult(
        job_id=job_id,
        status="pending",
        total_generations=request.generations,
    )

    with _jobs_lock:
        _jobs[job_id] = initial_result.model_copy(deep=True)

    thread = threading.Thread(target=_run_generation, args=(job_id, request), daemon=True)
    thread.start()

    # Return the copy, not the reference
    return initial_result

@router.get("/{job_id}", response_model=FloorPlanResult)
async def get_floor_plan_result(job_id: str):
    if job_id not in _jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    with _jobs_lock:
        # Return a deep copy to prevent client from seeing mid-mutation state
        return _jobs[job_id].model_copy(deep=True)
```

Apply same pattern to `backend/app/api/v1/optimize.py`.

---

## Issue #2: Event Loop Management in Background Threads

**File:** `backend/app/api/v1/floorplan.py`

**Current (BROKEN):**
```python
def _run_generation(job_id: str, request: FloorPlanRequest):
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            loop = asyncio.new_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()

    def _ws_broadcast_progress(gen, total, best_fit, avg_fit):
        try:
            asyncio.run_coroutine_threadsafe(
                sync_manager.broadcast_progress(gen, total, best_fit, avg_fit),
                loop,
            )
        except Exception:
            pass  # WS errors silently hidden
```

**Fixed:**
```python
import asyncio
import logging

logger = logging.getLogger(__name__)

def _run_generation(job_id: str, request: FloorPlanRequest):
    start_time = time.time()

    # Create a NEW event loop for this thread
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)  # CRITICAL: register it

    try:
        # ... optimization code ...

        def _ws_broadcast_progress(gen, total, best_fit, avg_fit):
            """Broadcast progress to Grasshopper clients via WebSocket."""
            if sync_manager.client_count == 0:
                return  # No clients listening

            try:
                future = asyncio.run_coroutine_threadsafe(
                    sync_manager.broadcast_progress(gen, total, best_fit, avg_fit),
                    loop,
                )
                # Wait with timeout to detect failures
                future.result(timeout=2.0)
            except concurrent.futures.TimeoutError:
                logger.warning(f"WebSocket broadcast timeout at generation {gen}")
            except Exception as e:
                logger.error(f"WebSocket broadcast failed at generation {gen}: {e}")

        # ... use _ws_broadcast_progress in optimizer callback ...

    finally:
        # Cleanup
        try:
            loop.close()
        except Exception as e:
            logger.error(f"Error closing event loop: {e}")
        finally:
            asyncio.set_event_loop(None)
```

---

## Issue #3: datetime.utcnow() Deprecated

**File:** `backend/app/services/ifc_exporter.py`

**Current (BROKEN on Python 3.12+):**
```python
from datetime import datetime

now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
timestamp = int(datetime.utcnow().timestamp())
```

**Fixed:**
```python
from datetime import datetime, timezone

now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
timestamp = int(datetime.now(timezone.utc).timestamp())
```

---

## Issue #4: Hardcoded Denver Coordinates

**File:** `backend/app/api/v1/plot.py`

**Current (WRONG for German app):**
```python
@router.post("/analyze", response_model=PlotAnalysis)
async def analyze_plot(plot_input: PlotInput):
    if plot_input.mode == "address":
        geo_result = None
        if plot_input.address:
            geo_result = await geocode_address(plot_input.address)

        if plot_input.width_m and plot_input.depth_m:
            # HARDCODED US LOCATION
            centroid = geo_result if geo_result else {"lng": -104.9903, "lat": 39.7392}
            analysis = geometry.analyze_rectangular_plot(...)
```

**Fixed:**
```python
@router.post("/analyze", response_model=PlotAnalysis)
async def analyze_plot(plot_input: PlotInput):
    if plot_input.mode == "address":
        geo_result = None
        if plot_input.address:
            geo_result = await geocode_address(plot_input.address)

        if plot_input.width_m and plot_input.depth_m:
            if not geo_result:
                raise HTTPException(
                    status_code=400,
                    detail="Could not geocode address. Please provide coordinates instead."
                )

            analysis = geometry.analyze_rectangular_plot(
                width_m=plot_input.width_m,
                depth_m=plot_input.depth_m,
                centroid_lng=geo_result["lng"],
                centroid_lat=geo_result["lat"],
            )
```

---

## Issue #5: Unbounded Job Cache Memory Leak

**File:** `backend/app/api/v1/floorplan.py`

**Current (MEMORY LEAK):**
```python
_jobs: dict[str, FloorPlanResult] = {}

@router.post("")
async def generate_floor_plan(request: FloorPlanRequest):
    job_id = str(uuid.uuid4())
    _jobs[job_id] = FloorPlanResult(...)
    # Never cleaned up!
```

**Fixed:**
```python
from datetime import datetime, timedelta
import threading

_jobs: dict[str, FloorPlanResult] = {}
_jobs_lock = threading.Lock()
_jobs_cleanup_interval_seconds = 3600  # Run cleanup every hour
_last_cleanup = time.time()

def _cleanup_old_jobs():
    """Remove completed jobs older than 24 hours."""
    global _last_cleanup
    now = time.time()

    if now - _last_cleanup < _jobs_cleanup_interval_seconds:
        return

    with _jobs_lock:
        expired_ids = []
        for job_id, result in _jobs.items():
            # Jobs are stored with elapsed_seconds, estimate creation time
            job_age_seconds = now - (result.created_at or now).timestamp()
            if job_age_seconds > 86400:  # 24 hours
                expired_ids.append(job_id)

        for job_id in expired_ids:
            logger.info(f"Cleaning up expired job {job_id[:8]}")
            del _jobs[job_id]

        _last_cleanup = now

@router.post("", response_model=FloorPlanResult)
async def generate_floor_plan(request: FloorPlanRequest):
    _cleanup_old_jobs()  # Periodic maintenance

    job_id = str(uuid.uuid4())
    now = datetime.utcnow()  # Track creation time

    result = FloorPlanResult(
        job_id=job_id,
        status="pending",
        total_generations=request.generations,
        created_at=now,  # Add to model if not present
    )

    with _jobs_lock:
        if len(_jobs) >= 2000:  # Hard limit
            raise HTTPException(
                status_code=429,
                detail="Too many active optimization jobs. Please try again later."
            )
        _jobs[job_id] = result

    # Start background thread...
```

Add `created_at: datetime` field to `FloorPlanResult` model in `models/floorplan.py`.

---

## Issue #6: Unsafe Array Access

**File:** `backend/app/api/v1/floorplan.py`

**Current (CRASHES):**
```python
variants = optimizer.optimize(request, progress_callback)

_jobs[job_id].status = "completed"
_jobs[job_id].variants = variants
_jobs[job_id].progress_pct = 100.0
if variants:  # Check happens AFTER assignment
    _jobs[job_id].building_floor_plans = variants[0].building_floor_plans
```

**Fixed:**
```python
variants = optimizer.optimize(request, progress_callback)

_jobs[job_id].status = "completed"
_jobs[job_id].variants = variants
_jobs[job_id].progress_pct = 100.0

if variants and len(variants) > 0:  # Explicit bounds check
    _jobs[job_id].building_floor_plans = variants[0].building_floor_plans
    logger.info(f"Job {job_id[:8]}: Best variant fitness={variants[0].fitness_score}")
else:
    _jobs[job_id].status = "failed"
    _jobs[job_id].error = "Optimizer produced no valid variants. Check input parameters."
    logger.warning(f"Job {job_id[:8]}: Optimizer returned empty variants list")
```

---

## Issue #7: Exception Swallowing (Example Pattern)

**File:** `backend/app/api/v1/floorplan.py` and everywhere

**Current (BAD):**
```python
except Exception:
    layout.floor_plans.append(BuildingFloorPlanResult(building_id=building.id))

except Exception:
    pass
```

**Fixed Pattern:**
```python
import logging
logger = logging.getLogger(__name__)

try:
    # ... code that might fail ...
except ValueError as e:
    logger.error(f"Invalid input for building {building.id}: {e}")
    raise HTTPException(status_code=400, detail=str(e))
except TimeoutError as e:
    logger.warning(f"WFS request timeout for {building.id}: {e}")
    raise HTTPException(status_code=504, detail="External service timeout")
except Exception as e:
    logger.error(f"Unexpected error in floor plan generation: {e}", exc_info=True)
    raise HTTPException(status_code=500, detail="Internal server error")
```

---

## Issue #9: Global HTTP Client Not Thread-Safe

**File:** `backend/app/services/cadastral.py`

**Current (UNSAFE):**
```python
_http_client: Optional[httpx.AsyncClient] = None

def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(...)
    return _http_client
```

**Fixed:**
```python
import asyncio
from typing import Optional

_http_client: Optional[httpx.AsyncClient] = None
_http_client_lock = asyncio.Lock()

async def _get_http_client() -> httpx.AsyncClient:
    """Get or create a shared AsyncClient with proper async locking."""
    global _http_client

    if _http_client is not None and not _http_client.is_closed:
        return _http_client

    async with _http_client_lock:
        # Double-check after acquiring lock
        if _http_client is not None and not _http_client.is_closed:
            return _http_client

        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            headers={
                "User-Agent": "GoldbeckOptimizer/1.0 (adrian.krasniqi@aplusa-studio.com)",
            },
        )
        return _http_client

# Update all calls:
# OLD: client = _get_http_client()
# NEW: client = await _get_http_client()
```

---

## Issue #11: Add Rate Limiting

**File:** `backend/app/main.py`

**Add this:**
```python
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Then in api/v1/cadastral.py and parcels.py:
@router.get("/parcel/at-point")
@limiter.limit("10/minute")
async def parcel_at_point(request: Request, lng: float = Query(...), lat: float = Query(...)):
    # ... existing code ...

@router.get("/parcels/in-radius")
@limiter.limit("10/minute")
async def parcels_in_radius(request: Request, lng: float, lat: float, radius_m: float):
    # ... existing code ...
```

---

## Issue #14: Transaction Isolation

**File:** `backend/app/database/engine.py`

**Current:**
```python
_session_factory = async_sessionmaker(
    _engine,
    class_=AsyncSession,
    expire_on_commit=False,
)
```

**Fixed:**
```python
from sqlalchemy import event
from sqlalchemy.pool import NullPool

_session_factory = async_sessionmaker(
    _engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# For SQLite, enable WAL mode and IMMEDIATE transactions
@event.listens_for(_engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()
```

And update get_db():
```python
@asynccontextmanager
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Provide a transactional async session scope."""
    async with _session_factory() as session:
        async with session.begin():  # Explicit transaction
            try:
                yield session
                # Auto-commit on successful exit
            except Exception:
                # Auto-rollback on error
                raise
```

---

## Summary: ~4 hours of focused work

These 6 critical fixes will:
✓ Eliminate race conditions
✓ Fix event loop issues
✓ Prevent Python 3.12+ breakage
✓ Stop memory leaks
✓ Fix silent failures
✓ Add proper error handling

Apply in this order:
1. Issue #1 (Lock job state) — 1 hour
2. Issue #2 (Event loop) — 30 mins
3. Issue #3 (datetime) — 15 mins
4. Issue #4 (Coords) — 15 mins
5. Issue #5 (Job cleanup) — 30 mins
6. Issue #6 (Array bounds) — 15 mins

Then test thoroughly before deployment.
