from pydantic import BaseModel


class SetbackRequirements(BaseModel):
    front_m: float = 6.10
    rear_m: float = 4.57
    side_left_m: float = 3.05
    side_right_m: float = 3.05


class ParkingRequirements(BaseModel):
    studio_ratio: float = 1.0
    one_bed_ratio: float = 1.0
    two_bed_ratio: float = 1.5
    three_bed_ratio: float = 2.0
    commercial_ratio_per_1000sqm: float = 3.0
    guest_ratio: float = 0.25


class MinimumUnitSize(BaseModel):
    studio_sqm: float = 37.16
    one_bed_sqm: float = 55.74
    two_bed_sqm: float = 78.97
    three_bed_sqm: float = 102.19


class RegulationSet(BaseModel):
    zoning_type: str = "R-3"
    setbacks: SetbackRequirements = SetbackRequirements()
    max_far: float = 1.5
    max_height_m: float = 13.72
    max_stories: int = 3
    max_lot_coverage_pct: float = 50.0
    min_open_space_pct: float = 25.0
    parking: ParkingRequirements = ParkingRequirements()
    min_unit_sizes: MinimumUnitSize = MinimumUnitSize()
    fire_access_width_m: float = 6.10
    min_building_separation_m: float = 4.57
    max_units_per_acre: float | None = None
    allow_commercial_ground_floor: bool = False
    max_impervious_surface_pct: float | None = None


class RegulationValidationResult(BaseModel):
    is_valid: bool
    issues: list[str]
    warnings: list[str]


class RegulationLookupRequest(BaseModel):
    address: str
    city: str | None = None
    state: str | None = None


class RegulationLookupResponse(BaseModel):
    regulations: RegulationSet
    confidence: float
    source_description: str
    notes: list[str]
    raw_zoning_code: str | None = None
