import uuid
import threading
import time

from fastapi import APIRouter, HTTPException

from app.models.optimization import (
    OptimizationRequest, OptimizationResult, BuildingFloorPlanResult,
    FitnessHistoryEntry,
)
from app.models.floorplan import FloorPlanRequest, FloorPlanWeights
from app.services.optimizer.core import LayoutOptimizer
from app.services.floorplan.optimizer import FloorPlanOptimizer

router = APIRouter()

# In-memory job store (production would use Redis/DB)
jobs: dict[str, OptimizationResult] = {}


def _run_floor_plans_for_layout(layout, request: OptimizationRequest, job_id: str):
    """Generate floor plans for each building in a layout."""
    fps = request.floor_plan_settings
    total_buildings = len(layout.buildings)

    for b_idx, building in enumerate(layout.buildings):
        jobs[job_id].progress_pct = (b_idx / total_buildings) * 100
        jobs[job_id].current_generation = b_idx
        jobs[job_id].total_generations = total_buildings

        fp_request = FloorPlanRequest(
            building_id=building.id,
            building_width_m=building.width_m,
            building_depth_m=building.depth_m,
            stories=building.stories,
            rotation_deg=building.rotation_deg,
            unit_mix=building.unit_mix.model_dump() if building.unit_mix else None,
            construction_system="goldbeck",
            story_height_m=fps.story_height_m,
            prefer_barrier_free=True,
            generations=fps.generations,
            population_size=fps.population_size,
            weights=fps.weights,
        )

        try:
            optimizer = FloorPlanOptimizer()
            variants = optimizer.optimize(fp_request)

            result = BuildingFloorPlanResult(
                building_id=building.id,
                best_floor_plan=variants[0].building_floor_plans if variants else None,
                variants=variants,
            )
            layout.floor_plans.append(result)
        except Exception:
            layout.floor_plans.append(BuildingFloorPlanResult(building_id=building.id))


def _run_optimization(job_id: str, request: OptimizationRequest):
    """Run optimization in background thread."""
    try:
        jobs[job_id].status = "running"
        jobs[job_id].phase = "layout"
        optimizer = LayoutOptimizer()

        start = time.time()

        def progress_callback(gen: int, total: int, best_fit: float, avg_fit: float = 0.0):
            elapsed = time.time() - start
            jobs[job_id].current_generation = gen
            jobs[job_id].total_generations = total
            jobs[job_id].progress_pct = (gen / total) * 100
            jobs[job_id].best_fitness = best_fit
            jobs[job_id].elapsed_seconds = round(elapsed, 1)
            jobs[job_id].fitness_history.append(
                FitnessHistoryEntry(generation=gen, best_fitness=round(best_fit, 4), avg_fitness=round(avg_fit, 4))
            )
            if gen > 0:
                avg_per_gen = elapsed / gen
                remaining_gens = total - gen
                jobs[job_id].estimated_remaining_seconds = round(avg_per_gen * remaining_gens, 1)

        layouts = optimizer.optimize(request, progress_callback=progress_callback)

        jobs[job_id].layouts = layouts
        jobs[job_id].elapsed_seconds = round(time.time() - start, 1)

        # Phase 2: Generate floor plans if combined mode
        if request.include_floor_plans and layouts:
            jobs[job_id].phase = "floor_plans"
            jobs[job_id].progress_pct = 0.0
            jobs[job_id].current_generation = 0

            for layout in layouts:
                _run_floor_plans_for_layout(layout, request, job_id)

        jobs[job_id].status = "completed"
        jobs[job_id].progress_pct = 100.0
        jobs[job_id].elapsed_seconds = round(time.time() - start, 1)
        jobs[job_id].estimated_remaining_seconds = 0.0
    except Exception as e:
        jobs[job_id].status = "failed"
        jobs[job_id].error = str(e)
        import traceback
        traceback.print_exc()


@router.post("", response_model=OptimizationResult)
async def start_optimization(request: OptimizationRequest):
    job_id = str(uuid.uuid4())
    result = OptimizationResult(
        job_id=job_id,
        status="pending",
        total_generations=request.generations,
    )
    jobs[job_id] = result

    thread = threading.Thread(target=_run_optimization, args=(job_id, request))
    thread.daemon = True
    thread.start()

    return result


@router.post("/estimate")
async def estimate_runtime(request: OptimizationRequest):
    """Estimate runtime for layout optimization + optional floor plans."""
    layout_evaluations = request.population_size * request.generations
    # Layout: ~0.5ms per evaluation
    layout_seconds = layout_evaluations * 0.0005

    floor_plan_seconds = 0.0
    if request.include_floor_plans:
        fps = request.floor_plan_settings
        fp_evaluations = fps.population_size * fps.generations
        # Floor plans: ~15ms per evaluation, per building, for top 5 layouts
        num_buildings = request.max_buildings  # estimate
        num_layouts = min(5, request.population_size)
        floor_plan_seconds = fp_evaluations * 0.015 * num_buildings * num_layouts

    total_seconds = layout_seconds + floor_plan_seconds
    return {
        "estimated_seconds": round(total_seconds, 1),
        "layout_seconds": round(layout_seconds, 1),
        "floor_plan_seconds": round(floor_plan_seconds, 1),
        "population_size": request.population_size,
        "generations": request.generations,
        "total_evaluations": layout_evaluations,
        "include_floor_plans": request.include_floor_plans,
    }


@router.get("/{job_id}", response_model=OptimizationResult)
async def get_optimization_result(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]
