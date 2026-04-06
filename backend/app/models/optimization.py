from typing import Optional

from pydantic import BaseModel, Field

from app.models.building import BuildingFootprint
from app.models.floorplan import BuildingFloorPlans, FloorPlanVariant, FloorPlanWeights
from app.models.plot import PlotAnalysis
from app.models.regulation import RegulationSet


class UnitMixPreference(BaseModel):
    studio_pct: float = 0.15
    one_bed_pct: float = 0.40
    two_bed_pct: float = 0.30
    three_bed_pct: float = 0.15


class OptimizationWeights(BaseModel):
    efficiency: float = 0.30
    financial: float = 0.30
    livability: float = 0.20
    compliance: float = 0.20


class FloorPlanSettings(BaseModel):
    """Settings for floor plan generation when running combined mode."""
    generations: int = Field(default=20, ge=1, le=500, description="Floor-plan GA generations")
    population_size: int = Field(default=20, ge=1, le=200, description="Floor-plan individuals per generation")
    story_height_m: float = 2.90
    weights: FloorPlanWeights = FloorPlanWeights()


class OptimizationRequest(BaseModel):
    plot: PlotAnalysis
    regulations: RegulationSet
    objective: str = "balanced"
    unit_mix_preference: UnitMixPreference = UnitMixPreference()
    weights: OptimizationWeights = OptimizationWeights()
    max_buildings: int = 4
    min_buildings: int = 1
    allow_podium_parking: bool = True
    allow_surface_parking: bool = True
    allow_structured_parking: bool = False
    population_size: int = Field(ge=2, le=200, description="Individuals per generation")
    generations: int = Field(ge=1, le=500, description="Number of GA generations")
    # Combined mode: generate floor plans for top layouts
    include_floor_plans: bool = False
    floor_plan_settings: FloorPlanSettings = FloorPlanSettings()


class LayoutScores(BaseModel):
    overall: float
    efficiency: float
    financial: float
    livability: float
    compliance: float


class RegulationCheckResult(BaseModel):
    is_compliant: bool
    violations: list[str]
    warnings: list[str]
    far_used: float
    far_max: float
    lot_coverage_pct: float
    height_max_m: float
    total_parking_required: float
    total_parking_provided: float


class BuildingFloorPlanResult(BaseModel):
    """Floor plan variants for one building in a layout."""
    building_id: str
    best_floor_plan: Optional[BuildingFloorPlans] = None
    variants: list[FloorPlanVariant] = []


class LayoutOption(BaseModel):
    id: str
    rank: int
    buildings: list[BuildingFootprint]
    scores: LayoutScores
    regulation_check: RegulationCheckResult
    total_units: int
    total_residential_sqm: float
    total_commercial_sqm: float
    total_parking_spaces: int
    far_achieved: float
    lot_coverage_pct: float
    open_space_pct: float
    building_separation_min_m: float
    # Floor plans (populated in combined mode)
    floor_plans: list[BuildingFloorPlanResult] = []


class FitnessHistoryEntry(BaseModel):
    """One data point in the fitness-over-generations chart."""
    generation: int
    best_fitness: float
    avg_fitness: float = 0.0


class OptimizationResult(BaseModel):
    job_id: str
    status: str = "pending"  # "pending", "running", "completed", "failed"
    progress_pct: float = 0.0
    current_generation: int = 0
    total_generations: int = 0
    best_fitness: float | None = None
    layouts: list[LayoutOption] = []
    elapsed_seconds: float | None = None
    estimated_remaining_seconds: float | None = None
    fitness_history: list[FitnessHistoryEntry] = []
    error: str | None = None
    # Progress phase for combined mode
    phase: str = "layout"  # "layout" or "floor_plans"
