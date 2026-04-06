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
import logging
from fastapi import APIRouter, HTTPException

from app.models.floorplan import FloorPlanRequest, FloorPlanResult, FitnessHistoryEntry, BuildingFloorPlans
from app.services.floorplan.optimizer import FloorPlanOptimizer
from app.services.ws_sync import sync_manager
from app.utils.job_store import JobStore

router = APIRouter()
logger = logging.getLogger(__name__)

# TTL-bounded, thread-safe job storage (evicts completed jobs after 30 min)
_store: JobStore[FloorPlanResult] = JobStore(name="floorplan")

# Version tag — if you see this in the backend console, the new code is loaded
_CODE_VERSION = "2026-04-04-v5-ttl-cache"


def _run_generation(job_id: str, request: FloorPlanRequest):
    """Background thread for floor plan generation. ALWAYS uses the optimizer."""
    start_time = time.time()
    try:
        _store.update(job_id, status="running", total_generations=request.generations)

        logger.info(
            f"[FloorPlan] Job {job_id[:8]}: "
            f"generations={request.generations}, "
            f"population_size={request.population_size}, "
            f"code_version={_CODE_VERSION}"
        )

        # ALWAYS run the optimizer — no more deterministic shortcut
        optimizer = FloorPlanOptimizer()

        # Create a dedicated event loop for async WebSocket broadcasting
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        def _ws_broadcast_progress(gen, total, best_fit, avg_fit):
            """Fire-and-forget WebSocket broadcast from background thread."""
            try:
                asyncio.run_coroutine_threadsafe(
                    sync_manager.broadcast_progress(gen, total, best_fit, avg_fit),
                    loop,
                )
            except Exception as e:
                logger.debug(f"WS progress broadcast failed: {e}")  # Don't break optimizer

        def progress_callback(gen: int, total: int, best_fit: float, avg_fit: float = 0.0, live_preview=None):
            elapsed = time.time() - start_time
            est_remaining = round((elapsed / gen) * (total - gen), 1) if gen > 0 else 0.0

            updates = dict(
                current_generation=gen,
                total_generations=total,
                progress_pct=(gen / total) * 100 if total > 0 else 0,
                best_fitness=round(best_fit, 2),
                elapsed_seconds=round(elapsed, 1),
                estimated_remaining_seconds=est_remaining,
            )
            if live_preview is not None:
                updates["live_preview"] = live_preview

            _store.update(job_id, **updates)
            _store.append_to_list(job_id, "fitness_history", FitnessHistoryEntry(
                generation=gen,
                best_fitness=round(best_fit, 4),
                avg_fitness=round(avg_fit, 4),
            ))

            # Broadcast progress to Grasshopper clients
            if sync_manager.client_count > 0:
                _ws_broadcast_progress(gen, total, best_fit, avg_fit)

        variants = optimizer.optimize(request, progress_callback)

        if not variants:
            _store.update(
                job_id,
                status="failed",
                error="Optimizer produced no valid variants. Try relaxing constraints or increasing generations.",
                progress_pct=100.0,
                elapsed_seconds=round(time.time() - start_time, 1),
                estimated_remaining_seconds=0.0,
            )
            logger.warning(f"[FloorPlan] Job {job_id[:8]}: 0 variants — marking as failed")
            return

        # Run validation on all variants
        from app.services.floorplan.validation import validate_building_dict
        for variant in variants:
            try:
                variant.validation = validate_building_dict(variant.building_floor_plans)
            except Exception:
                logger.warning(f"[FloorPlan] Job {job_id[:8]}: validation failed for rank {variant.rank}", exc_info=True)

        # Build completion state atomically
        _store.update(
            job_id,
            status="completed",
            variants=variants,
            building_floor_plans=variants[0].building_floor_plans,
            progress_pct=100.0,
            elapsed_seconds=round(time.time() - start_time, 1),
            estimated_remaining_seconds=0.0,
        )

        # Broadcast best variant to Grasshopper clients (outside lock)
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
                logger.warning(f"[FloorPlan] Job {job_id[:8]}: WS broadcast failed", exc_info=True)

        elapsed = time.time() - start_time
        logger.info(
            f"[FloorPlan] Job {job_id[:8]}: COMPLETED in {elapsed:.1f}s, "
            f"{len(variants)} unique variants"
        )

    except Exception as e:
        _store.update(job_id, status="failed", error=str(e))
        logger.exception(f"[FloorPlan] Job {job_id[:8]}: FAILED - {e}")


@router.post("", response_model=FloorPlanResult)
async def generate_floor_plan(request: FloorPlanRequest):
    """Start floor plan generation for a building."""
    logger.info(
        f"[FloorPlan] POST received (code={_CODE_VERSION}): "
        f"building={request.building_id}, "
        f"size={request.building_width_m}x{request.building_depth_m}m, "
        f"stories={request.stories}, "
        f"generations={request.generations}, "
        f"pop_size={request.population_size}"
    )

    job_id = str(uuid.uuid4())
    initial = FloorPlanResult(
        job_id=job_id,
        status="pending",
        total_generations=request.generations,
    )
    _store.put(job_id, initial)

    thread = threading.Thread(
        target=_run_generation,
        args=(job_id, request),
        daemon=True,
    )
    thread.start()

    # Return a separate copy so serialization can't race with the thread
    return FloorPlanResult(
        job_id=job_id,
        status="pending",
        total_generations=request.generations,
    )


@router.get("/{job_id}", response_model=FloorPlanResult)
async def get_floor_plan_result(job_id: str):
    """Poll for floor plan generation result with progress."""
    job = _store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/validate")
async def validate_floor_plan_endpoint(plans: BuildingFloorPlans):
    """Run building code validation on a floor plan.

    Returns a validation report with errors, warnings, and compliance status.
    """
    from app.services.floorplan.validation import validate_building_dict
    return validate_building_dict(plans)


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
