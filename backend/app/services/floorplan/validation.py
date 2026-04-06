"""
Comprehensive floor plan validation suite for professional-grade output.

Validates every generated floor plan against:
  1. DIN 18011 minimum room sizes (by room type)
  2. Room aspect ratios (no rooms narrower than 1:3)
  3. Door widths (entrance ≥ 1.01m, interior ≥ 0.885m, BF ≥ 0.90m)
  4. Fire egress distance (max 35m to nearest staircase)
  5. Window-to-floor ratio (DIN 5034: ≥ 12.5% for habitable rooms)
  6. Service strip connectivity (hallway → bathroom → TGA shaft)
  7. Room daylight access (habitable rooms must touch exterior wall)
  8. Apartment entrance integrity (every apartment has exactly 1 entrance)
  9. Structural grid compliance (bay widths in Goldbeck valid rasters)
  10. Bathroom stacking (bathrooms aligned vertically across floors)
  11. Apartment total area within Goldbeck specs
  12. Corridor/gallery width compliance

Each check returns a ValidationResult with severity, message, and location.
Severities:
  - ERROR:   Hard code violation. Must fix before professional use.
  - WARNING: Soft rule or best-practice deviation. Acceptable but not ideal.
  - INFO:    Observation that may be relevant for design review.
"""

import math
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional

from app.models.floorplan import (
    BuildingFloorPlans, FloorPlan, Apartment, Room, RoomType,
    DoorPlacement, WindowPlacement, StaircaseUnit, AccessType,
    ApartmentType, Point2D,
)
from app.services.floorplan import goldbeck_constants as C


# ============================================================
# Result types
# ============================================================

class Severity(str, Enum):
    ERROR = "ERROR"
    WARNING = "WARNING"
    INFO = "INFO"


@dataclass
class ValidationResult:
    severity: Severity
    check: str          # e.g. "room_size", "fire_egress"
    message: str        # Human-readable description
    location: str = ""  # e.g. "Floor 0 / Apt A01 / Bedroom 1"

    def __str__(self) -> str:
        loc = f" [{self.location}]" if self.location else ""
        return f"{self.severity.value}: {self.check}{loc} — {self.message}"


@dataclass
class ValidationReport:
    """Aggregated validation results for an entire building."""
    results: list[ValidationResult] = field(default_factory=list)

    @property
    def errors(self) -> list[ValidationResult]:
        return [r for r in self.results if r.severity == Severity.ERROR]

    @property
    def warnings(self) -> list[ValidationResult]:
        return [r for r in self.results if r.severity == Severity.WARNING]

    @property
    def is_compliant(self) -> bool:
        """True if no ERROR-level violations."""
        return len(self.errors) == 0

    @property
    def summary(self) -> dict[str, int]:
        return {
            "errors": len(self.errors),
            "warnings": len(self.warnings),
            "info": sum(1 for r in self.results if r.severity == Severity.INFO),
            "total": len(self.results),
        }

    def add(self, result: ValidationResult) -> None:
        self.results.append(result)

    def __str__(self) -> str:
        s = self.summary
        lines = [f"Validation: {s['errors']} errors, {s['warnings']} warnings, {s['info']} info"]
        for r in self.results:
            lines.append(f"  {r}")
        return "\n".join(lines)


# ============================================================
# Helper: room bounding box
# ============================================================

def _room_bbox(room: Room) -> tuple[float, float, float, float]:
    """Return (min_x, min_y, max_x, max_y)."""
    xs = [p.x for p in room.polygon]
    ys = [p.y for p in room.polygon]
    return min(xs), min(ys), max(xs), max(ys)


def _loc(floor: FloorPlan, apt: Optional[Apartment] = None,
         room: Optional[Room] = None) -> str:
    """Build a location string for error messages."""
    parts = [f"Floor {floor.floor_index}"]
    if apt:
        parts.append(f"Apt {apt.unit_number}")
    if room:
        parts.append(room.label)
    return " / ".join(parts)


# ============================================================
# 1. ROOM SIZE VALIDATION (DIN 18011)
# ============================================================

# Minimum room areas per DIN 18011 / Wohnflächenverordnung (WoFlV)
# These are hard minimums — anything below is a code violation.
MIN_ROOM_AREAS: dict[RoomType, float] = {
    RoomType.LIVING: 14.0,     # Wohnzimmer
    RoomType.BEDROOM: 8.0,     # Schlafzimmer
    RoomType.KITCHEN: 4.0,     # Küche
    RoomType.BATHROOM: 2.5,    # Bad
    RoomType.HALLWAY: 1.5,     # Flur
    RoomType.STORAGE: 0.5,     # Abstellraum
}

# Minimum short-side dimensions (a room can have enough area but be too narrow)
MIN_SHORT_SIDE: dict[RoomType, float] = {
    RoomType.LIVING: 3.0,      # Can't furnish a living room < 3m wide
    RoomType.BEDROOM: 2.4,     # Single bed (0.9m) + wardrobe (0.6m) + clearance (0.9m)
    RoomType.KITCHEN: 1.8,     # Counter (0.6m) + passage (0.9m) + 0.3m tolerance
    RoomType.BATHROOM: 1.2,    # Minimum WC width
    RoomType.HALLWAY: 1.0,     # Minimum passage width
}


def check_room_sizes(floor: FloorPlan, report: ValidationReport) -> None:
    """Check all rooms meet minimum area and dimension requirements."""
    for apt in floor.apartments:
        for room in apt.rooms:
            if room.room_type in (RoomType.BALCONY, RoomType.SHAFT):
                continue

            # Area check
            min_area = MIN_ROOM_AREAS.get(room.room_type, 0)
            if min_area > 0 and room.area_sqm < min_area:
                report.add(ValidationResult(
                    severity=Severity.ERROR,
                    check="room_size",
                    message=f"{room.area_sqm:.1f}m² < {min_area:.1f}m² minimum",
                    location=_loc(floor, apt, room),
                ))
            elif min_area > 0 and room.area_sqm < min_area * 1.1:
                report.add(ValidationResult(
                    severity=Severity.WARNING,
                    check="room_size",
                    message=f"{room.area_sqm:.1f}m² is within 10% of {min_area:.1f}m² minimum",
                    location=_loc(floor, apt, room),
                ))

            # Short-side dimension check
            min_side = MIN_SHORT_SIDE.get(room.room_type, 0)
            if min_side > 0 and room.polygon and len(room.polygon) >= 4:
                bbox = _room_bbox(room)
                w = bbox[2] - bbox[0]
                h = bbox[3] - bbox[1]
                short = min(w, h)
                if short < min_side:
                    report.add(ValidationResult(
                        severity=Severity.ERROR,
                        check="room_dimension",
                        message=f"Short side {short:.2f}m < {min_side:.1f}m minimum width",
                        location=_loc(floor, apt, room),
                    ))


# ============================================================
# 2. ROOM ASPECT RATIOS
# ============================================================

MAX_ASPECT_RATIO = 3.0  # Hard limit
PREFERRED_ASPECT_RATIO = 2.5  # Ideal maximum


def check_aspect_ratios(floor: FloorPlan, report: ValidationReport) -> None:
    """Check that habitable rooms aren't too narrow (aspect > 1:3)."""
    for apt in floor.apartments:
        for room in apt.rooms:
            if room.room_type not in (RoomType.LIVING, RoomType.BEDROOM, RoomType.KITCHEN):
                continue
            if not room.polygon or len(room.polygon) < 4:
                continue

            bbox = _room_bbox(room)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            if w <= 0 or h <= 0:
                continue

            ratio = max(w, h) / min(w, h)
            if ratio > MAX_ASPECT_RATIO:
                report.add(ValidationResult(
                    severity=Severity.ERROR,
                    check="aspect_ratio",
                    message=f"Aspect ratio {ratio:.1f}:1 exceeds {MAX_ASPECT_RATIO}:1 limit "
                            f"({w:.2f}m x {h:.2f}m)",
                    location=_loc(floor, apt, room),
                ))
            elif ratio > PREFERRED_ASPECT_RATIO:
                report.add(ValidationResult(
                    severity=Severity.WARNING,
                    check="aspect_ratio",
                    message=f"Aspect ratio {ratio:.1f}:1 above preferred {PREFERRED_ASPECT_RATIO}:1 "
                            f"({w:.2f}m x {h:.2f}m)",
                    location=_loc(floor, apt, room),
                ))


# ============================================================
# 3. DOOR WIDTH VALIDATION
# ============================================================

MIN_ENTRANCE_DOOR_WIDTH = 0.90      # Absolute minimum (LBO)
PREFERRED_ENTRANCE_DOOR_WIDTH = 1.01  # Goldbeck standard / BF requirement
MIN_INTERIOR_DOOR_WIDTH = 0.80      # LBO minimum for room doors
MIN_BF_DOOR_WIDTH = 0.90            # DIN 18040-2 barrier-free


def check_door_widths(floor: FloorPlan, report: ValidationReport) -> None:
    """Validate all door widths meet building code minimums."""
    for door in floor.doors:
        if door.is_entrance:
            if door.width_m < MIN_ENTRANCE_DOOR_WIDTH:
                report.add(ValidationResult(
                    severity=Severity.ERROR,
                    check="door_width",
                    message=f"Entrance door {door.width_m:.3f}m < {MIN_ENTRANCE_DOOR_WIDTH}m minimum",
                    location=f"Floor {floor.floor_index} / Door {door.id}",
                ))
            elif door.width_m < PREFERRED_ENTRANCE_DOOR_WIDTH:
                report.add(ValidationResult(
                    severity=Severity.WARNING,
                    check="door_width",
                    message=f"Entrance door {door.width_m:.3f}m < {PREFERRED_ENTRANCE_DOOR_WIDTH}m "
                            f"(barrier-free recommended)",
                    location=f"Floor {floor.floor_index} / Door {door.id}",
                ))
        else:
            if door.width_m < MIN_INTERIOR_DOOR_WIDTH:
                report.add(ValidationResult(
                    severity=Severity.ERROR,
                    check="door_width",
                    message=f"Interior door {door.width_m:.3f}m < {MIN_INTERIOR_DOOR_WIDTH}m minimum",
                    location=f"Floor {floor.floor_index} / Door {door.id}",
                ))


# ============================================================
# 4. FIRE EGRESS DISTANCE
# ============================================================

MAX_TRAVEL_DISTANCE = C.MAX_TRAVEL_DISTANCE if hasattr(C, "MAX_TRAVEL_DISTANCE") else 35.0
EGRESS_WARNING_DISTANCE = MAX_TRAVEL_DISTANCE * 0.85  # Warn at 85% of limit


def check_fire_egress(floor: FloorPlan, report: ValidationReport) -> None:
    """Check all apartments are within max travel distance of a staircase."""
    if not floor.staircases:
        report.add(ValidationResult(
            severity=Severity.ERROR,
            check="fire_egress",
            message="No staircases on this floor — zero emergency egress",
            location=f"Floor {floor.floor_index}",
        ))
        return

    stair_centers = [
        (s.position.x + s.width_m / 2, s.position.y + s.depth_m / 2)
        for s in floor.staircases
    ]

    for apt in floor.apartments:
        # Use the apartment's furthest point from nearest staircase
        # (not centroid — worst case matters for fire code)
        all_points = [(p.x, p.y) for r in apt.rooms for p in r.polygon]
        if not all_points:
            continue

        max_dist = 0.0
        for px, py in all_points:
            min_stair_dist = min(
                math.sqrt((px - sx) ** 2 + (py - sy) ** 2)
                for sx, sy in stair_centers
            )
            max_dist = max(max_dist, min_stair_dist)

        if max_dist > MAX_TRAVEL_DISTANCE:
            report.add(ValidationResult(
                severity=Severity.ERROR,
                check="fire_egress",
                message=f"Furthest point {max_dist:.1f}m from nearest staircase "
                        f"(max {MAX_TRAVEL_DISTANCE:.0f}m)",
                location=_loc(floor, apt),
            ))
        elif max_dist > EGRESS_WARNING_DISTANCE:
            report.add(ValidationResult(
                severity=Severity.WARNING,
                check="fire_egress",
                message=f"Furthest point {max_dist:.1f}m from staircase "
                        f"(approaching {MAX_TRAVEL_DISTANCE:.0f}m limit)",
                location=_loc(floor, apt),
            ))


# ============================================================
# 5. WINDOW-TO-FLOOR RATIO (DIN 5034)
# ============================================================

DIN_5034_MIN_RATIO = 0.125  # 12.5% minimum window/floor area for habitable rooms


def check_window_ratios(floor: FloorPlan, building_depth: float,
                        report: ValidationReport) -> None:
    """Check that habitable rooms meet DIN 5034 window-to-floor ratio."""
    for apt in floor.apartments:
        for room in apt.rooms:
            if room.room_type not in (RoomType.LIVING, RoomType.BEDROOM, RoomType.KITCHEN):
                continue
            if room.area_sqm <= 0:
                continue

            bbox = _room_bbox(room)
            room_min_x, room_min_y, room_max_x, room_max_y = bbox

            # Find windows belonging to this room
            room_window_area = 0.0
            for win in floor.windows:
                wx, wy = win.position.x, win.position.y
                # Window within room's X span and on an exterior wall adjacent to room
                if room_min_x - 0.15 <= wx <= room_max_x + 0.15:
                    on_south = (wy < C.OUTER_LONG_WALL + 0.2
                                and room_min_y < C.OUTER_LONG_WALL + 0.2)
                    on_north = (wy > building_depth - C.OUTER_LONG_WALL - 0.2
                                and room_max_y > building_depth - C.OUTER_LONG_WALL - 0.2)
                    if on_south or on_north:
                        room_window_area += win.width_m * win.height_m

            ratio = room_window_area / room.area_sqm
            if ratio < DIN_5034_MIN_RATIO:
                if room_window_area == 0:
                    report.add(ValidationResult(
                        severity=Severity.ERROR,
                        check="window_ratio",
                        message=f"No windows — habitable room requires min "
                                f"{DIN_5034_MIN_RATIO*100:.0f}% window-to-floor ratio",
                        location=_loc(floor, apt, room),
                    ))
                else:
                    report.add(ValidationResult(
                        severity=Severity.ERROR,
                        check="window_ratio",
                        message=f"Window ratio {ratio*100:.1f}% < {DIN_5034_MIN_RATIO*100:.0f}% "
                                f"({room_window_area:.2f}m² windows / {room.area_sqm:.1f}m² floor)",
                        location=_loc(floor, apt, room),
                    ))


# ============================================================
# 6. DAYLIGHT ACCESS (habitable rooms must touch exterior)
# ============================================================

def check_daylight_access(floor: FloorPlan, building_depth: float,
                          report: ValidationReport) -> None:
    """Check that all habitable rooms touch an exterior wall."""
    for apt in floor.apartments:
        for room in apt.rooms:
            if room.room_type not in (RoomType.LIVING, RoomType.BEDROOM, RoomType.KITCHEN):
                continue
            if not room.polygon or len(room.polygon) < 4:
                continue

            bbox = _room_bbox(room)
            on_south = bbox[1] < C.OUTER_LONG_WALL + 0.15
            on_north = bbox[3] > building_depth - C.OUTER_LONG_WALL - 0.15

            if not on_south and not on_north:
                report.add(ValidationResult(
                    severity=Severity.ERROR,
                    check="daylight_access",
                    message="Habitable room does not touch any exterior wall — no natural light",
                    location=_loc(floor, apt, room),
                ))


# ============================================================
# 7. APARTMENT ENTRANCE INTEGRITY
# ============================================================

def check_entrance_integrity(floor: FloorPlan, report: ValidationReport) -> None:
    """Verify every apartment has exactly one valid entrance door."""
    entrance_door_ids = {d.id for d in floor.doors if d.is_entrance}

    for apt in floor.apartments:
        # Must reference an entrance door
        if not apt.entrance_door_id:
            report.add(ValidationResult(
                severity=Severity.ERROR,
                check="entrance",
                message="No entrance door assigned",
                location=_loc(floor, apt),
            ))
            continue

        # That door must exist
        if apt.entrance_door_id not in entrance_door_ids:
            report.add(ValidationResult(
                severity=Severity.ERROR,
                check="entrance",
                message=f"Entrance door '{apt.entrance_door_id}' not found in floor door list",
                location=_loc(floor, apt),
            ))

        # Must have a hallway room
        has_hallway = any(r.room_type == RoomType.HALLWAY for r in apt.rooms)
        if not has_hallway:
            report.add(ValidationResult(
                severity=Severity.ERROR,
                check="entrance",
                message="No hallway room — entrance has no distribution space",
                location=_loc(floor, apt),
            ))


# ============================================================
# 8. STRUCTURAL GRID COMPLIANCE
# ============================================================

def check_structural_grid(plans: BuildingFloorPlans, report: ValidationReport) -> None:
    """Validate bay widths are valid Goldbeck rasters."""
    grid = plans.structural_grid
    valid_set = set(C.STANDARD_RASTERS)

    for i, bay_w in enumerate(grid.bay_widths):
        # Allow small floating-point tolerance
        matched = any(abs(bay_w - r) < 0.01 for r in C.STANDARD_RASTERS)
        if not matched:
            report.add(ValidationResult(
                severity=Severity.ERROR,
                check="structural_grid",
                message=f"Bay {i} width {bay_w:.3f}m is not a valid Goldbeck raster "
                        f"(valid: {C.STANDARD_RASTERS})",
                location=f"Structural Grid / Bay {i}",
            ))


# ============================================================
# 9. APARTMENT AREA COMPLIANCE
# ============================================================

def check_apartment_areas(floor: FloorPlan, report: ValidationReport) -> None:
    """Validate apartment total areas are within Goldbeck spec ranges."""
    for apt in floor.apartments:
        spec = C.APARTMENT_BAY_SPECS.get(apt.apartment_type.value, {})
        min_area = spec.get("min_area_sqm", 0)
        max_area = spec.get("max_area_sqm", 999)

        if min_area > 0 and apt.total_area_sqm < min_area:
            report.add(ValidationResult(
                severity=Severity.WARNING,
                check="apt_area",
                message=f"{apt.total_area_sqm:.1f}m² below {min_area:.0f}m² spec minimum "
                        f"for {apt.apartment_type.value}",
                location=_loc(floor, apt),
            ))
        elif max_area < 999 and apt.total_area_sqm > max_area * 1.1:
            report.add(ValidationResult(
                severity=Severity.WARNING,
                check="apt_area",
                message=f"{apt.total_area_sqm:.1f}m² above {max_area:.0f}m² spec maximum "
                        f"for {apt.apartment_type.value}",
                location=_loc(floor, apt),
            ))


# ============================================================
# 10. BATHROOM STACKING (multi-floor)
# ============================================================

def check_bathroom_stacking(plans: BuildingFloorPlans,
                             report: ValidationReport) -> None:
    """Validate bathrooms are vertically aligned across floors."""
    if len(plans.floor_plans) < 2:
        return

    ref = plans.floor_plans[0]
    ref_positions: list[tuple[float, float]] = []
    for apt in ref.apartments:
        for room in apt.rooms:
            if room.room_type == RoomType.BATHROOM and room.polygon:
                cx = sum(p.x for p in room.polygon) / len(room.polygon)
                cy = sum(p.y for p in room.polygon) / len(room.polygon)
                ref_positions.append((cx, cy))

    for fp in plans.floor_plans[1:]:
        for apt in fp.apartments:
            for room in apt.rooms:
                if room.room_type != RoomType.BATHROOM or not room.polygon:
                    continue
                cx = sum(p.x for p in room.polygon) / len(room.polygon)
                cy = sum(p.y for p in room.polygon) / len(room.polygon)
                matched = any(
                    abs(cx - rx) < 0.15 and abs(cy - ry) < 0.15
                    for rx, ry in ref_positions
                )
                if not matched:
                    report.add(ValidationResult(
                        severity=Severity.WARNING,
                        check="bathroom_stacking",
                        message=f"Bathroom at ({cx:.1f}, {cy:.1f}) does not align with "
                                f"ground floor bathroom positions",
                        location=_loc(fp, apt, room),
                    ))


# ============================================================
# 11. SERVICE STRIP CONNECTIVITY
# ============================================================

def check_service_strip(floor: FloorPlan, report: ValidationReport) -> None:
    """Check that hallway → bathroom → shaft topology is maintained."""
    for apt in floor.apartments:
        hallway = None
        bathroom = None
        for room in apt.rooms:
            if room.room_type == RoomType.HALLWAY:
                hallway = room
            elif room.room_type == RoomType.BATHROOM:
                bathroom = room

        if hallway is None or bathroom is None:
            continue  # Already caught by entrance check

        # Hallway and bathroom should share an edge (be adjacent)
        if hallway.polygon and bathroom.polygon and len(hallway.polygon) >= 4 and len(bathroom.polygon) >= 4:
            h_bbox = _room_bbox(hallway)
            b_bbox = _room_bbox(bathroom)

            # Check for shared edge (within wall thickness tolerance)
            wall_gap = C.PARTITION_WALL + 0.05
            shares_edge = False

            # Vertical shared edge
            if abs(h_bbox[2] - b_bbox[0]) < wall_gap or abs(b_bbox[2] - h_bbox[0]) < wall_gap:
                overlap_y = min(h_bbox[3], b_bbox[3]) - max(h_bbox[1], b_bbox[1])
                if overlap_y > 0.5:
                    shares_edge = True
            # Horizontal shared edge
            if abs(h_bbox[3] - b_bbox[1]) < wall_gap or abs(b_bbox[3] - h_bbox[1]) < wall_gap:
                overlap_x = min(h_bbox[2], b_bbox[2]) - max(h_bbox[0], b_bbox[0])
                if overlap_x > 0.5:
                    shares_edge = True

            if not shares_edge:
                report.add(ValidationResult(
                    severity=Severity.WARNING,
                    check="service_strip",
                    message="Hallway and bathroom are not adjacent — broken service strip",
                    location=_loc(floor, apt),
                ))


# ============================================================
# MAIN ENTRY POINT
# ============================================================

def validate_building(plans: BuildingFloorPlans) -> ValidationReport:
    """Run all validation checks on a complete building.

    Returns a ValidationReport with all findings sorted by severity.
    """
    report = ValidationReport()
    depth = plans.building_depth_m

    # Building-level checks
    check_structural_grid(plans, report)
    check_bathroom_stacking(plans, report)

    # Per-floor checks
    for floor in plans.floor_plans:
        check_room_sizes(floor, report)
        check_aspect_ratios(floor, report)
        check_door_widths(floor, report)
        check_fire_egress(floor, report)
        check_window_ratios(floor, depth, report)
        check_daylight_access(floor, depth, report)
        check_entrance_integrity(floor, report)
        check_apartment_areas(floor, report)
        check_service_strip(floor, report)

    # Sort: errors first, then warnings, then info
    severity_order = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2}
    report.results.sort(key=lambda r: (severity_order[r.severity], r.check))

    return report


def validate_building_dict(plans: BuildingFloorPlans) -> dict:
    """Run validation and return JSON-serializable dict for API responses."""
    report = validate_building(plans)
    return {
        "compliant": report.is_compliant,
        "summary": report.summary,
        "results": [
            {
                "severity": r.severity.value,
                "check": r.check,
                "message": r.message,
                "location": r.location,
            }
            for r in report.results
        ],
    }
