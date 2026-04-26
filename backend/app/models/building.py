from pydantic import BaseModel


class UnitMixEntry(BaseModel):
    unit_type: str  # "studio", "1br", "2br", "3br", "commercial"
    count: int
    avg_sqm: float
    total_sqm: float


class UnitMix(BaseModel):
    entries: list[UnitMixEntry]
    total_units: int
    total_residential_sqm: float
    total_commercial_sqm: float


class BuildingFootprint(BaseModel):
    id: str
    building_type: str = "residential"
    position_x: float
    position_y: float
    width_m: float
    depth_m: float
    rotation_deg: float = 0.0
    stories: int
    floor_height_m: float = 3.05
    total_height_m: float
    gross_floor_area_sqm: float
    net_floor_area_sqm: float
    efficiency_factor: float = 0.85
    unit_mix: UnitMix | None = None
    ground_floor_commercial: bool = False
    ground_floor_commercial_sqm: float = 0.0
    ground_floor_parking: bool = False
    # Phase 8.5 — Staffelgeschoss is decided at the layout phase so the
    # §6 envelope check can account for it. The floor-plan generator
    # then receives this as a hard input rather than choosing on its
    # own. `setback_m` is the inset applied on each gable end (so the
    # SG length shrinks by 2×setback) and on the rear long facade.
    has_staffelgeschoss: bool = False
    staffelgeschoss_setback_m: float = 2.0
