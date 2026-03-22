"""
Architectural knowledge base for residential floor plan generation.

Encodes building code requirements, Goldbeck system constraints, and
design best practices as callable validation functions and constants.

These rules are referenced by:
  - goldbeck_generator.py (hard constraints during generation)
  - optimizer.py (soft fitness penalties during optimization)
  - ifc_exporter.py (element sizing validation)

Organization:
  1. ACCESS & CIRCULATION — corridor/gallery/entrance rules
  2. APARTMENT LAYOUT — room sizing, adjacency, door placement
  3. FIRE SAFETY — egress distances, compartmentalization
  4. STRUCTURAL — wall types, load paths, slab spans
  5. COMFORT & LIVABILITY — daylight, acoustics, privacy
"""

from app.models.floorplan import (
    AccessType, RoomType, Apartment, FloorPlan,
    StaircaseUnit, DoorPlacement, Room, Point2D,
)
from app.services.floorplan import goldbeck_constants as C


# ============================================================
# 1. ACCESS & CIRCULATION RULES
# ============================================================

class AccessRules:
    """Rules governing apartment access, corridors, and entrance doors."""

    # --- Entrance Door Rules ---
    # Each apartment must have exactly ONE entrance door
    MAX_ENTRANCE_DOORS_PER_APT = 1

    # Upper floors: entrance must connect to corridor/gallery (shared access)
    # Ground floor: entrance may connect directly to exterior (outside access)
    GROUND_FLOOR_INDEX = 0

    @staticmethod
    def get_entrance_wall_side(access_type: AccessType, apt_side: str,
                                floor_index: int, gallery_side: str = "north") -> str:
        """Determine which wall the entrance door should face.

        Returns:
            "corridor" — internal corridor wall (Ganghaus upper floors)
            "gallery"  — gallery-side exterior wall (Laubengang upper floors)
            "exterior" — any exterior wall (ground floor, or Spaenner)
        """
        if floor_index == AccessRules.GROUND_FLOOR_INDEX:
            return "exterior"

        if access_type == AccessType.GANGHAUS:
            return "corridor"
        elif access_type == AccessType.LAUBENGANG:
            return "gallery"
        else:  # Spaenner
            return "exterior"

    @staticmethod
    def validate_entrance_doors(floor: FloorPlan) -> list[str]:
        """Check that every apartment has exactly one valid entrance door."""
        issues = []
        entrance_door_ids = {d.id for d in floor.doors if d.is_entrance}

        for apt in floor.apartments:
            # Must have an entrance door reference
            if not apt.entrance_door_id:
                issues.append(f"{apt.unit_number}: missing entrance door reference")
                continue

            # That door must exist in the floor's door list
            if apt.entrance_door_id not in entrance_door_ids:
                issues.append(f"{apt.unit_number}: entrance door '{apt.entrance_door_id}' not found")
                continue

            # Must have a hallway room connecting entrance to apartment interior
            has_hallway = any(r.room_type == RoomType.HALLWAY for r in apt.rooms)
            if not has_hallway:
                issues.append(f"{apt.unit_number}: no hallway room connecting entrance to interior")

        return issues

    # --- Corridor Rules ---
    MIN_CORRIDOR_WIDTH_M = 1.50      # Barrier-free minimum (DIN 18040-2)
    MIN_CORRIDOR_WIDTH_NON_BF = 1.20 # Non-barrier-free minimum

    # --- Gallery (Laubengang) Rules ---
    MIN_GALLERY_WIDTH_M = 1.50       # Barrier-free external walkway
    MAX_GALLERY_WIDTH_M = 2.50       # Practical maximum
    GALLERY_MUST_CONNECT_STAIRCASE = True  # Gallery must reach at least one staircase

    @staticmethod
    def get_gallery_entrance_y(building_depth: float, gallery_side: str = "north") -> float:
        """Y coordinate for entrance doors on gallery-side wall."""
        if gallery_side == "north":
            return building_depth - C.OUTER_LONG_WALL / 2
        return C.OUTER_LONG_WALL / 2


# ============================================================
# 2. APARTMENT LAYOUT RULES
# ============================================================

class ApartmentRules:
    """Rules governing apartment internal layout and room arrangement."""

    # --- Minimum Room Sizes (German building code / Wohnflächenverordnung) ---
    MIN_ROOM_AREAS = {
        RoomType.LIVING: 14.0,     # Wohnzimmer minimum
        RoomType.BEDROOM: 8.0,     # Schlafzimmer minimum
        RoomType.KITCHEN: 4.0,     # Küche minimum (may be kitchenette)
        RoomType.BATHROOM: 2.5,    # Bad minimum
        RoomType.HALLWAY: 1.5,     # Flur minimum
        RoomType.STORAGE: 0.5,     # Abstellraum
    }

    # --- Room Aspect Ratios ---
    # No habitable room should be narrower than 1:3 ratio
    MAX_ASPECT_RATIO = 3.0
    PREFERRED_ASPECT_RATIO = 2.0   # Ideal maximum

    # --- Room Adjacency ---
    # Service strip (hallway, bathroom, kitchen) should be near corridor side
    # Living/bedrooms should be near exterior wall (daylight)
    SERVICE_ROOMS = {RoomType.HALLWAY, RoomType.BATHROOM, RoomType.KITCHEN, RoomType.STORAGE}
    HABITABLE_ROOMS = {RoomType.LIVING, RoomType.BEDROOM, RoomType.KITCHEN}

    # --- Daylight Requirements ---
    # Every habitable room must have at least one window on an exterior wall
    # Bathrooms and hallways may be windowless (can use artificial light)
    ROOMS_REQUIRING_DAYLIGHT = {RoomType.LIVING, RoomType.BEDROOM, RoomType.KITCHEN}

    @staticmethod
    def validate_room_sizes(apartment: Apartment) -> list[str]:
        """Check all rooms meet minimum area requirements."""
        issues = []
        for room in apartment.rooms:
            min_area = ApartmentRules.MIN_ROOM_AREAS.get(room.room_type, 0)
            if room.area_sqm < min_area:
                issues.append(
                    f"{apartment.unit_number}/{room.label}: "
                    f"{room.area_sqm:.1f}m² < {min_area:.1f}m² minimum"
                )
        return issues

    @staticmethod
    def validate_storage(apartments: list, min_storage_m2: float = 1.5) -> list[str]:
        """Validate that each apartment has minimum in-unit storage."""
        warnings = []
        for apt in apartments:
            storage_rooms = [r for r in apt.rooms if r.room_type == "storage"]
            total_storage = sum(r.area_sqm for r in storage_rooms)
            if total_storage < min_storage_m2:
                warnings.append(
                    f"Apartment {apt.id}: storage area {total_storage:.1f}m² "
                    f"below minimum {min_storage_m2}m²"
                )
        return warnings


# ============================================================
# 3. FIRE SAFETY RULES
# ============================================================

class FireSafetyRules:
    """Fire code requirements for residential buildings."""

    # Maximum travel distance to nearest staircase (German building code)
    MAX_TRAVEL_DISTANCE_M = 35.0

    # Building class thresholds (Gebäudeklassen)
    BUILDING_CLASS_3_MAX_HEIGHT = 7.0   # 2-3 stories typical
    BUILDING_CLASS_4_MAX_HEIGHT = 13.0  # 4-5 stories typical
    BUILDING_CLASS_5_MAX_HEIGHT = 22.0  # High-rise limit (Hochhausgrenze)

    # Fire compartment rules
    # Apartments are separate fire compartments — walls between apartments
    # must be fire-rated (REI 90 for building class 4+)
    APT_SEPARATION_WALL_REQUIRED = True

    # Staircase must be an enclosed fire compartment
    STAIRCASE_ENCLOSURE_REQUIRED = True

    # Maximum distance between fire sections along building length
    MAX_FIRE_SECTION_LENGTH_M = 40.0

    @staticmethod
    def validate_egress(floor: FloorPlan) -> list[str]:
        """Check all apartments are within max travel distance of a staircase."""
        issues = []
        if not floor.staircases:
            issues.append("No staircases on this floor")
            return issues

        stair_centers = [
            (s.position.x + s.width_m / 2, s.position.y + s.depth_m / 2)
            for s in floor.staircases
        ]

        for apt in floor.apartments:
            all_xs = [p.x for r in apt.rooms for p in r.polygon]
            all_ys = [p.y for r in apt.rooms for p in r.polygon]
            if not all_xs:
                continue
            cx = (min(all_xs) + max(all_xs)) / 2
            cy = (min(all_ys) + max(all_ys)) / 2
            min_dist = min(
                ((cx - sx) ** 2 + (cy - sy) ** 2) ** 0.5
                for sx, sy in stair_centers
            )
            if min_dist > FireSafetyRules.MAX_TRAVEL_DISTANCE_M:
                issues.append(
                    f"{apt.unit_number}: {min_dist:.1f}m to nearest staircase "
                    f"(max {FireSafetyRules.MAX_TRAVEL_DISTANCE_M}m)"
                )
        return issues


# ============================================================
# 4. STRUCTURAL RULES
# ============================================================

class StructuralRules:
    """Goldbeck precast concrete structural system constraints."""

    # Valid bay widths (Achsraster) — multiples of 0.625m grid
    VALID_RASTERS = C.STANDARD_RASTERS  # [3.125, 3.75, 4.375, 5.00, 5.625, 6.25]
    GRID_UNIT = C.GRID_UNIT             # 0.625m base module

    # Slab spans
    MAX_SLAB_SPAN_M = C.MAX_SLAB_SPAN   # 6.04m clear span (6.25m on axis)
    SLAB_THICKNESS_M = C.SLAB_THICKNESS  # 0.24m hollow-core slab

    # Load-bearing walls: cross walls (Querwand) carry vertical loads
    # Outer long walls are NON-bearing (14cm) — hung facade
    # Corridor walls ARE bearing (21cm)
    BEARING_WALL_TYPES = {
        "bearing_cross", "corridor", "gable_end",
        "staircase", "elevator_shaft",
    }

    # Maximum stories
    MAX_STORIES = C.MAX_STORIES  # 8 (incl. basement)

    @staticmethod
    def validate_window_pier_alignment(windows_by_floor: dict[int, list]) -> list[str]:
        """Validate that window piers align vertically through all storeys.

        Goldbeck rule: Piers must be continuous and aligned vertically across all floors.
        This is a manufacturing constraint for precast wall elements.
        """
        warnings = []
        if len(windows_by_floor) < 2:
            return warnings

        # Get reference floor (first floor above ground)
        ref_floor = min(windows_by_floor.keys())
        ref_windows = windows_by_floor[ref_floor]

        for floor_idx, windows in windows_by_floor.items():
            if floor_idx == ref_floor:
                continue
            # Check that each window on this floor has a matching position on reference
            for win in windows:
                matched = any(
                    abs(win.position.x - ref_win.position.x) < 0.05 and
                    abs(win.width_m - ref_win.width_m) < 0.01
                    for ref_win in ref_windows
                )
                if not matched:
                    warnings.append(
                        f"Window at x={win.position.x:.2f}m on floor {floor_idx} "
                        f"does not align with reference floor {ref_floor}"
                    )
        return warnings


# ============================================================
# 5. COMFORT & LIVABILITY RULES
# ============================================================

class ComfortRules:
    """Design quality and livability requirements."""

    # --- Natural Light ---
    # All habitable rooms should touch an exterior wall (window access)
    # Rooms deeper than 6m from exterior may have poor daylight
    MAX_ROOM_DEPTH_FROM_EXTERIOR_M = 6.0

    # --- Acoustic Privacy ---
    # Bedrooms should not be directly adjacent to staircase/elevator
    MIN_BEDROOM_STAIRCASE_DISTANCE_M = 3.0

    # --- Barrier-Free (DIN 18040-2) ---
    # At least 50% of apartments should be barrier-free accessible
    # (common requirement for publicly funded housing)
    TARGET_BARRIER_FREE_RATIO = 0.50

    # Door widths for barrier-free
    MIN_BF_DOOR_WIDTH_M = 0.90
    PREFERRED_BF_DOOR_WIDTH_M = 1.01

    # --- Outdoor Space ---
    # Each apartment should ideally have a balcony or loggia
    TARGET_BALCONY_RATIO = 1.0  # 100% of apartments

    # --- Privacy ---
    # Laubengang: gallery passes by apartment windows — affected rooms
    # on gallery side should be service rooms (bathroom, kitchen), not bedrooms
    GALLERY_SIDE_PREFERRED_ROOMS = {
        RoomType.KITCHEN, RoomType.BATHROOM, RoomType.HALLWAY, RoomType.STORAGE,
    }
    GALLERY_SIDE_AVOID_ROOMS = {
        RoomType.BEDROOM, RoomType.LIVING,
    }


# ============================================================
# 6. BATHROOM RULES
# ============================================================

class BathroomRules:
    """Goldbeck prefab bathroom placement rules."""

    # Bathroom types mapping
    BARRIER_FREE_TYPES = ["type_i", "type_ii", "type_iv"]
    NON_BARRIER_FREE_TYPES = ["type_iii"]

    @staticmethod
    def validate_bathroom_stacking(floor_plans: list) -> list[str]:
        """Validate that bathrooms are placed exactly above each other across floors.

        Goldbeck rule: Bathrooms must stack vertically. The prefab shaft module requires
        identical bathroom placement in all floors; shaft offsets must be avoided.
        """
        warnings = []
        if len(floor_plans) < 2:
            return warnings

        ref_fp = floor_plans[0]
        ref_bath_positions = []
        for apt in ref_fp.apartments:
            for room in apt.rooms:
                if room.room_type == "bathroom":
                    cx = sum(p.x for p in room.polygon) / len(room.polygon)
                    cy = sum(p.y for p in room.polygon) / len(room.polygon)
                    ref_bath_positions.append((cx, cy, room.area_sqm))

        for fp in floor_plans[1:]:
            floor_baths = []
            for apt in fp.apartments:
                for room in apt.rooms:
                    if room.room_type == "bathroom":
                        cx = sum(p.x for p in room.polygon) / len(room.polygon)
                        cy = sum(p.y for p in room.polygon) / len(room.polygon)
                        floor_baths.append((cx, cy, room.area_sqm))

            for ref_pos in ref_bath_positions:
                matched = any(
                    abs(fb[0] - ref_pos[0]) < 0.1 and abs(fb[1] - ref_pos[1]) < 0.1
                    for fb in floor_baths
                )
                if not matched:
                    warnings.append(
                        f"Floor {fp.floor_index}: bathroom at ({ref_pos[0]:.1f}, {ref_pos[1]:.1f}) "
                        f"does not stack with ground floor"
                    )

        return warnings

    @staticmethod
    def get_bathroom_type_for_apartment(apt_type: str, is_primary: bool, barrier_free: bool) -> str:
        """Get recommended bathroom type per Goldbeck specifications."""
        if not is_primary:
            return "type_iii"  # Secondary bath is always Type III (guest WC)
        if apt_type == "1_room":
            return "type_iv" if barrier_free else "type_iii"
        return "type_i" if barrier_free else "type_iv"


# ============================================================
# Comprehensive Validation
# ============================================================

def validate_floor_plan(floor: FloorPlan) -> dict[str, list[str]]:
    """Run all architectural validations on a floor plan.

    Returns dict of category -> list of issue strings.
    Empty lists = compliant.
    """
    results = {}

    # Access & circulation
    results["access"] = AccessRules.validate_entrance_doors(floor)

    # Fire safety
    results["fire_safety"] = FireSafetyRules.validate_egress(floor)

    # Apartment layout
    apt_issues = []
    for apt in floor.apartments:
        apt_issues.extend(ApartmentRules.validate_room_sizes(apt))
    results["room_sizes"] = apt_issues

    # Storage validation
    storage_issues = ApartmentRules.validate_storage(floor.apartments)
    results["storage"] = storage_issues

    return results
