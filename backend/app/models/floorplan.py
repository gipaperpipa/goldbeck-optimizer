"""
Floor plan data models for internal building layout generation.
Supports multiple construction systems (Goldbeck first).
All coordinates are in meters relative to building origin (bottom-left corner).
"""

from enum import Enum
from pydantic import BaseModel, Field, model_validator
from typing import Optional


# --- Enumerations ---

class WallType(str, Enum):
    BEARING_CROSS = "bearing_cross"        # Querwand, 21cm
    CORRIDOR = "corridor"                   # Flurwand, 21cm, bearing
    OUTER_LONG = "outer_long"              # Aussenlangswand, 14cm, non-bearing
    GABLE_END = "gable_end"                # Giebelwand, 21cm, bearing
    STAIRCASE = "staircase"                # Treppenhauswand, 21cm
    ELEVATOR_SHAFT = "elevator_shaft"      # Aufzugsschacht, 24cm
    PARTITION = "partition"                 # Trennwand, 10cm, drywall
    APT_SEPARATION = "apt_separation"      # Between apartments on same side


class RoomType(str, Enum):
    LIVING = "living"
    BEDROOM = "bedroom"
    KITCHEN = "kitchen"
    BATHROOM = "bathroom"
    HALLWAY = "hallway"
    STORAGE = "storage"
    BALCONY = "balcony"
    CORRIDOR = "corridor"       # Building central corridor (Mittelflur)
    STAIRCASE = "staircase"
    ELEVATOR = "elevator"
    SHAFT = "shaft"             # Utility/TGA shaft


class AccessType(str, Enum):
    GANGHAUS = "ganghaus"       # Central corridor, apartments both sides
    SPAENNER = "spaenner"      # Direct staircase access
    LAUBENGANG = "laubengang"  # External gallery/walkway, apartments full depth


class StaircaseType(str, Enum):
    TYPE_I = "type_i"           # 6.25m raster, integrated elevator
    TYPE_II = "type_ii"         # 3.125m raster, two-flight, no elevator
    TYPE_III = "type_iii"       # 3.125m raster, single-flight, narrow


class BathroomType(str, Enum):
    TYPE_I = "type_i"           # 2.25 x 2.60m, barrier-free, with washer
    TYPE_II = "type_ii"         # 1.61 x 2.96m, barrier-free
    TYPE_III = "type_iii"       # 1.34 x 1.96m, NOT barrier-free
    TYPE_IV = "type_iv"         # 1.82 x 2.32m, barrier-free


class ApartmentType(str, Enum):
    ONE_ROOM = "1_room"
    TWO_ROOM = "2_room"
    THREE_ROOM = "3_room"
    FOUR_ROOM = "4_room"
    FIVE_ROOM = "5_room"


class FloorType(str, Enum):
    GROUND = "ground"                  # Erdgeschoss — barrier-free priority, exterior access
    STANDARD = "standard"              # Regelgeschoss — typical residential floor
    STAFFELGESCHOSS = "staffelgeschoss"  # Setback top floor — reduced footprint


# --- Geometry Primitives ---

class Point2D(BaseModel):
    x: float  # meters from building origin
    y: float  # meters from building origin


class WallSegment(BaseModel):
    id: str
    wall_type: WallType
    start: Point2D
    end: Point2D
    thickness_m: float
    is_bearing: bool
    is_exterior: bool


class DoorPlacement(BaseModel):
    id: str
    position: Point2D           # center of door on wall
    wall_id: str                # references WallSegment.id
    width_m: float              # 1.01 (entrance) or 0.885 (interior)
    height_m: float = 2.135
    is_entrance: bool = False
    swing_direction: str = "inward"  # inward, outward


class WindowPlacement(BaseModel):
    id: str
    position: Point2D           # center of window on wall
    wall_id: str                # references WallSegment.id
    width_m: float              # 0.625, 1.25, 1.50, or 1.875
    height_m: float = 1.35      # default parapet window
    sill_height_m: float = 0.90
    is_floor_to_ceiling: bool = False


# --- Layout Elements ---

class FloorConfig(BaseModel):
    """Per-floor configuration for independent generation.

    Standard floors share the structural grid but can have different
    apartment allocations, room proportions, and unit mixes.
    Staffelgeschoss gets its own reduced grid.
    """
    floor_index: int
    floor_type: FloorType = FloorType.STANDARD
    unit_mix_override: Optional[dict] = None  # Per-floor unit mix (same format as FloorPlanRequest.unit_mix)
    allocation_order_override: Optional[str] = None  # "large_first" | "small_first" | "mixed"
    force_barrier_free: bool = False  # Ground floor: all units barrier-free
    setback_m: Optional[float] = None  # Staffelgeschoss only: setback from building edge


class Room(BaseModel):
    id: str
    room_type: RoomType
    polygon: list[Point2D]      # closed polygon vertices
    area_sqm: float
    label: str                  # e.g., "Living Room", "Bedroom 1"
    apartment_id: Optional[str] = None  # None for building-level rooms


class BathroomUnit(BaseModel):
    id: str
    bathroom_type: BathroomType
    position: Point2D           # bottom-left corner
    width_m: float
    depth_m: float
    area_sqm: float


class Apartment(BaseModel):
    id: str
    apartment_type: ApartmentType
    unit_number: str            # e.g., "A01", "B03"
    side: str                   # "south", "north", or "single"
    rooms: list[Room]
    bathroom: BathroomUnit
    total_area_sqm: float
    bay_indices: list[int]      # which structural bays this apartment spans
    entrance_door_id: str
    has_balcony: bool = True


class StaircaseUnit(BaseModel):
    id: str
    staircase_type: StaircaseType
    position: Point2D           # bottom-left corner
    width_m: float              # along building length
    depth_m: float              # building depth
    has_elevator: bool
    bay_index: int


class StructuralGrid(BaseModel):
    """The Goldbeck raster grid for this building."""
    origin: Point2D = Field(default_factory=lambda: Point2D(x=0, y=0))
    bay_widths: list[float]         # raster widths along building length (meters)
    building_depth_m: float         # total exterior depth
    building_length_m: float        # total exterior length
    south_zone_depth_m: float       # depth of south apartment zone (0 for Spaenner)
    north_zone_depth_m: float       # depth of north apartment zone (0 for Spaenner)
    corridor_width_m: float = 0.0   # 0 for Spaenner/Laubengang, ~1.50 for Ganghaus
    corridor_y_start_m: float = 0.0 # y position of corridor south wall axis
    story_height_m: float = 2.90
    axis_positions_x: list[float]   # x positions of all cross-wall axes
    outer_wall_south_y: float = 0.0
    outer_wall_north_y: float = 0.0
    gallery_side: Optional[str] = None  # "north" or "south" — side with external gallery (Laubengang only)


# --- Composite Models ---

class FloorPlan(BaseModel):
    """Complete floor plan for one story of a building."""
    floor_index: int            # 0 = ground floor
    floor_type: FloorType = FloorType.STANDARD
    structural_grid: StructuralGrid
    walls: list[WallSegment]
    doors: list[DoorPlacement]
    windows: list[WindowPlacement]
    apartments: list[Apartment]
    staircases: list[StaircaseUnit]
    rooms: list[Room]           # all rooms including corridors, stairs
    access_type: AccessType
    gross_area_sqm: float
    net_area_sqm: float
    num_apartments: int


class BuildingFloorPlans(BaseModel):
    """All floor plans for a single building.

    NOTE on naming: ``building_width_m`` corresponds to the generator's
    ``length_m`` (long facade), and ``building_depth_m`` corresponds to
    the generator's ``depth_m`` (short dimension / perpendicular to the
    long facade).  This mismatch is intentional — the API uses the
    architect-facing terms (width = longest extent on-screen) while the
    generator uses structural terms (length = direction of bays).
    Renaming would break the API contract so the mapping is documented
    here and in CLAUDE.md instead.
    """
    building_id: str
    construction_system: str = "goldbeck"
    building_width_m: float     # along long facade (= generator length_m)
    building_depth_m: float     # perpendicular to long facade (= generator depth_m)
    num_stories: int
    story_height_m: float
    access_type: AccessType
    structural_grid: StructuralGrid
    floor_plans: list[FloorPlan]
    total_apartments: int
    apartment_summary: dict[str, int]   # {"2_room": 4, "3_room": 2, ...}


# --- API Request/Response ---

class FloorPlanWeights(BaseModel):
    """User-controllable optimization priorities for floor plan generation.

    Livability now includes 5 advanced architectural quality criteria:
    connectivity (hallway-as-hub), furniture feasibility, daylight quality,
    kitchen-living relationship, and orientation-aware scoring.
    """
    efficiency: float = 0.20    # net/gross ratio, construction regularity
    livability: float = 0.35    # room connectivity, furniture fit, daylight, orientation, proportions
    revenue: float = 0.25       # unit count, mix match, area optimization
    compliance: float = 0.20    # fire egress, barrier-free, room size compliance

    @model_validator(mode="after")
    def normalize_weights(self) -> "FloorPlanWeights":
        total = self.efficiency + self.livability + self.revenue + self.compliance
        if total > 0:
            self.efficiency /= total
            self.livability /= total
            self.revenue /= total
            self.compliance /= total
        else:
            self.efficiency = self.livability = self.revenue = self.compliance = 0.25
        return self


class FloorPlanRequest(BaseModel):
    building_id: str
    building_width_m: float
    building_depth_m: float
    stories: int
    rotation_deg: float = 0.0
    unit_mix: Optional[dict] = None  # from BuildingFootprint.unit_mix
    construction_system: str = "goldbeck"
    story_height_m: float = 2.90
    prefer_barrier_free: bool = True
    access_type_override: Optional[AccessType] = None
    # Generational optimizer settings
    generations: int = Field(default=1, ge=1, le=500, description="Number of GA generations")
    population_size: int = Field(default=1, ge=1, le=200, description="Individuals per generation")
    weights: Optional[FloorPlanWeights] = None
    use_ai_generation: bool = False  # Enable AI-assisted generation with enhanced parameters
    # Per-floor independent generation
    enable_per_floor: bool = True  # Generate each floor independently (allocation + rooms vary)
    floor_configs: Optional[list[FloorConfig]] = None  # Optional per-floor overrides
    ground_floor_barrier_free: bool = True  # Force barrier-free on ground floor (BauO NRW §50)
    # Staffelgeschoss (setback top floor — does not count as Vollgeschoss)
    enable_staffelgeschoss: bool = False
    staffelgeschoss_setback_m: float = 2.0  # setback from building edge on each side


class FloorPlanVariant(BaseModel):
    """One ranked floor plan variant from the optimizer."""
    rank: int
    fitness_score: float
    fitness_breakdown: Optional[dict[str, float]] = None
    building_floor_plans: BuildingFloorPlans
    validation: Optional[dict] = None  # Building code validation results


class FitnessHistoryEntry(BaseModel):
    """One data point in the fitness-over-generations chart."""
    generation: int
    best_fitness: float
    avg_fitness: float = 0.0


class FloorPlanResult(BaseModel):
    job_id: str
    status: str = "pending"     # pending, running, completed, failed
    building_floor_plans: Optional[BuildingFloorPlans] = None
    variants: list[FloorPlanVariant] = []
    progress_pct: float = 0.0
    current_generation: int = 0
    total_generations: int = 0
    best_fitness: float = 0.0
    elapsed_seconds: float = 0.0
    estimated_remaining_seconds: float = 0.0
    fitness_history: list[FitnessHistoryEntry] = []
    live_preview: Optional[FloorPlanVariant] = None  # Current best during generation
    error: Optional[str] = None
