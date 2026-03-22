"""
Floor plan generation API endpoints.
POST /floorplan - starts generation job (ALWAYS uses optimizer)
GET /floorplan/{job_id} - polls for result with progress
POST /floorplan/estimate - estimates runtime
"""

import uuid
import time
import asyncio
import threading
from fastapi import APIRouter, HTTPException

from app.models.floorplan import FloorPlanRequest, FloorPlanResult, FitnessHistoryEntry
from app.services.floorplan.optimizer import FloorPlanOptimizer
from app.services.ws_sync import sync_manager

router = APIRouter()

# In-memory job storage (production: use Redis or DB)
_jobs: dict[str, FloorPlanResult] = {}

# Version tag — if you see this in the backend console, the new code is loaded
_CODE_VERSION = "2026-03-17-v3-optimizer-always"


def _run_generation(job_id: str, request: FloorPlanRequest):
    """Background thread for floor plan generation. ALWAYS uses the optimizer."""
    start_time = time.time()
    try:
        _jobs[job_id].status = "running"
        _jobs[job_id].total_generations = request.generations

        print(f"[FloorPlan] Job {job_id[:8]}: "
              f"generations={request.generations}, "
              f"population_size={request.population_size}, "
              f"code_version={_CODE_VERSION}",
              flush=True)

        # ALWAYS run the optimizer — no more deterministic shortcut
        optimizer = FloorPlanOptimizer()

        # Get or create event loop for async WebSocket broadcasting
        try:
            loop = asyncio.get_event_loop()
            if loop.is_closed():
                loop = asyncio.new_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()

        def _ws_broadcast_progress(gen, total, best_fit, avg_fit):
            """Fire-and-forget WebSocket broadcast from background thread."""
            try:
                asyncio.run_coroutine_threadsafe(
                    sync_manager.broadcast_progress(gen, total, best_fit, avg_fit),
                    loop,
                )
            except Exception:
                pass  # Don't let WS errors break the optimizer

        def progress_callback(gen: int, total: int, best_fit: float, avg_fit: float = 0.0):
            elapsed = time.time() - start_time
            _jobs[job_id].current_generation = gen
            _jobs[job_id].total_generations = total
            _jobs[job_id].progress_pct = (gen / total) * 100 if total > 0 else 0
            _jobs[job_id].best_fitness = round(best_fit, 2)
            _jobs[job_id].elapsed_seconds = round(elapsed, 1)
            _jobs[job_id].fitness_history.append(
                FitnessHistoryEntry(generation=gen, best_fitness=round(best_fit, 4), avg_fitness=round(avg_fit, 4))
            )
            if gen > 0:
                avg_per_gen = elapsed / gen
                remaining = total - gen
                _jobs[job_id].estimated_remaining_seconds = round(
                    avg_per_gen * remaining, 1
                )

            # Broadcast progress to Grasshopper clients
            if sync_manager.client_count > 0:
                _ws_broadcast_progress(gen, total, best_fit, avg_fit)

        variants = optimizer.optimize(request, progress_callback)

        _jobs[job_id].status = "completed"
        _jobs[job_id].variants = variants
        _jobs[job_id].progress_pct = 100.0
        if variants:
            _jobs[job_id].building_floor_plans = variants[0].building_floor_plans

            # Broadcast best variant to Grasshopper clients
            if sync_manager.client_count > 0:
                try:
                    best_data = variants[0].building_floor_plans.model_dump()
                    asyncio.run_coroutine_threadsafe(
                        sync_manager.broadcast_floor_plans(best_data), loop,
                    )
                    asyncio.run_coroutine_threadsafe(
                        sync_manager.broadcast_optimization_complete(
                            [v.model_dump() for v in variants]
                        ), loop,
                    )
                except Exception:
                    pass

        elapsed = time.time() - start_time
        _jobs[job_id].elapsed_seconds = round(elapsed, 1)
        _jobs[job_id].estimated_remaining_seconds = 0.0

        print(f"[FloorPlan] Job {job_id[:8]}: COMPLETED in {elapsed:.1f}s, "
              f"{len(variants)} unique variants", flush=True)
        for i, v in enumerate(variants):
            bp = v.building_floor_plans
            print(f"  Variant {i+1}: fitness={v.fitness_score} "
                  f"bays={bp.structural_grid.bay_widths} "
                  f"access={bp.access_type.value} "
                  f"apts={bp.total_apartments}", flush=True)

    except Exception as e:
        _jobs[job_id].status = "failed"
        _jobs[job_id].error = str(e)
        import traceback
        traceback.print_exc()
        print(f"[FloorPlan] Job {job_id[:8]}: FAILED - {e}", flush=True)


@router.post("", response_model=FloorPlanResult)
async def generate_floor_plan(request: FloorPlanRequest):
    """Start floor plan generation for a building."""
    print(f"[FloorPlan] POST received (code={_CODE_VERSION}): "
          f"building={request.building_id}, "
          f"size={request.building_width_m}x{request.building_depth_m}m, "
          f"stories={request.stories}, "
          f"generations={request.generations}, "
          f"pop_size={request.population_size}",
          flush=True)

    job_id = str(uuid.uuid4())
    _jobs[job_id] = FloorPlanResult(
        job_id=job_id,
        status="pending",
        total_generations=request.generations,
    )

    thread = threading.Thread(
        target=_run_generation,
        args=(job_id, request),
        daemon=True,
    )
    thread.start()

    # Return a SEPARATE object so the thread's mutations don't
    # race with FastAPI's response serialization
    return FloorPlanResult(
        job_id=job_id,
        status="pending",
        total_generations=request.generations,
    )


@router.get("/{job_id}", response_model=FloorPlanResult)
async def get_floor_plan_result(job_id: str):
    """Poll for floor plan generation result with progress."""
    if job_id not in _jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return _jobs[job_id]


@router.post("/estimate")
async def estimate_runtime(request: FloorPlanRequest):
    """Estimate runtime for floor plan generation."""
    total_evaluations = request.population_size * request.generations
    estimated_seconds = total_evaluations * 0.005
    return {
        "estimated_seconds": round(estimated_seconds, 1),
        "population_size": request.population_size,
        "generations": request.generations,
        "total_evaluations": total_evaluations,
    }


@router.get("/systems/list")
async def list_construction_systems():
    """List available construction systems."""
    from app.services.floorplan.registry import list_systems
    return {"systems": list_systems()}
