"""
Advanced floor plan quality scoring for the evolutionary optimizer.

Implements 5 architectural quality criteria that directly improve layout results:
  1. Room connectivity — hallway-as-hub topology (every room reachable from hallway)
  2. Furniture feasibility — rooms can physically fit standard furniture
  3. Daylight quality — window-to-floor ratio + room depth from exterior
  4. Kitchen-living relationship — spatial adjacency and Wohnküche quality
  5. Orientation-aware scoring — room types matched to compass directions

These supplement the base 12-criterion fitness function in optimizer.py.
"""

import math
from typing import Optional

from app.models.floorplan import (
    RoomType, Room, Apartment, FloorPlan, BuildingFloorPlans,
    DoorPlacement, WindowPlacement, Point2D,
)
from app.services.floorplan import goldbeck_constants as C


# ============================================================
# 1. ROOM CONNECTIVITY — Hallway as Distribution Hub
# ============================================================

# Minimum overlap (meters) between two room edges to consider them "adjacent"
_ADJACENCY_TOLERANCE = 0.08  # ~8cm — accounts for partition walls


def _room_bbox(room: Room) -> tuple[float, float, float, float]:
    """Return (min_x, min_y, max_x, max_y) for a room."""
    xs = [p.x for p in room.polygon]
    ys = [p.y for p in room.polygon]
    return min(xs), min(ys), max(xs), max(ys)


def _rooms_share_edge(a: Room, b: Room, tolerance: float = _ADJACENCY_TOLERANCE) -> bool:
    """Check if two rooms share an edge (are physically adjacent).

    Two rooms share an edge if they have a shared boundary segment
    of at least `tolerance` meters, accounting for the partition wall
    between them.
    """
    ax0, ay0, ax1, ay1 = _room_bbox(a)
    bx0, by0, bx1, by1 = _room_bbox(b)

    # Check for vertical shared edge (rooms side by side in X)
    # Allow gap up to partition wall thickness (10cm)
    wall_gap = C.PARTITION_WALL + 0.02
    if abs(ax1 - bx0) < wall_gap or abs(bx1 - ax0) < wall_gap:
        # Y ranges must overlap
        overlap_y = min(ay1, by1) - max(ay0, by0)
        if overlap_y >= tolerance:
            return True

    # Check for horizontal shared edge (rooms stacked in Y)
    if abs(ay1 - by0) < wall_gap or abs(by1 - ay0) < wall_gap:
        # X ranges must overlap
        overlap_x = min(ax1, bx1) - max(ax0, bx0)
        if overlap_x >= tolerance:
            return True

    return False


def _build_adjacency_graph(rooms: list[Room]) -> dict[str, set[str]]:
    """Build a room adjacency graph based on shared edges."""
    graph: dict[str, set[str]] = {r.id: set() for r in rooms}
    for i, a in enumerate(rooms):
        for b in rooms[i + 1:]:
            if _rooms_share_edge(a, b):
                graph[a.id].add(b.id)
                graph[b.id].add(a.id)
    return graph


def score_room_connectivity(apartment: Apartment) -> float:
    """Score how well the hallway serves as a distribution hub (0-10).

    Perfect score (10): hallway is directly adjacent to every other room.
    Good score (7+): hallway reaches all rooms within 1 hop.
    Poor score (<5): rooms only reachable by walking through other rooms.
    Zero: no hallway, or rooms completely disconnected.
    """
    rooms = apartment.rooms
    if not rooms:
        return 0.0

    hallway = None
    for r in rooms:
        if r.room_type == RoomType.HALLWAY:
            hallway = r
            break

    if hallway is None:
        return 0.0

    # Exclude balcony from connectivity check (it's exterior, accessed from living room)
    interior_rooms = [r for r in rooms if r.room_type not in (
        RoomType.HALLWAY, RoomType.BALCONY, RoomType.SHAFT,
    )]

    if not interior_rooms:
        return 10.0

    graph = _build_adjacency_graph(rooms)

    # Count rooms directly adjacent to hallway
    hallway_neighbors = graph.get(hallway.id, set())
    directly_connected = 0
    indirectly_connected = 0
    unreachable = 0

    for room in interior_rooms:
        if room.id in hallway_neighbors:
            directly_connected += 1
        else:
            # Check if reachable through exactly one intermediate room
            # (e.g., living room reached through kitchen zone)
            found_path = False
            for neighbor_id in hallway_neighbors:
                neighbor_neighbors = graph.get(neighbor_id, set())
                if room.id in neighbor_neighbors:
                    found_path = True
                    break
            if found_path:
                indirectly_connected += 1
            else:
                unreachable += 1

    total = len(interior_rooms)
    if total == 0:
        return 10.0

    # Scoring: direct connection = full credit, indirect = half, unreachable = 0
    score = (directly_connected * 1.0 + indirectly_connected * 0.5) / total * 10.0

    # Penalty for completely unreachable rooms (architectural failure)
    if unreachable > 0:
        score *= max(0.2, 1.0 - unreachable / total)

    return round(min(10.0, max(0.0, score)), 2)


# ============================================================
# 2. FURNITURE FEASIBILITY — Can Rooms Be Furnished?
# ============================================================

# Minimum dimensions for standard furniture layouts (meters)
# These represent the smallest dimension a room must have to fit furniture
FURNITURE_REQUIREMENTS = {
    RoomType.BEDROOM: {
        "min_short_side": 2.70,    # Double bed (2.0m) + circulation (0.7m)
        "min_long_side": 3.50,     # Bed length (2.1m) + wardrobe (0.6m) + clearance (0.8m)
        "min_area": 9.0,           # Practical furnished minimum
        "description": "double bed + wardrobe + circulation",
    },
    RoomType.LIVING: {
        "min_short_side": 3.00,    # Sofa (2.2m) + coffee table clearance (0.8m)
        "min_long_side": 4.00,     # Seating zone + kitchen counter (Wohnküche)
        "min_area": 16.0,          # Practical furnished Wohnküche minimum
        "description": "sofa + dining + kitchen counter",
    },
    RoomType.KITCHEN: {
        "min_short_side": 2.10,    # Counter depth (0.6m) + circulation (0.9m) + counter (0.6m)
        "min_long_side": 2.40,     # Minimum counter run length
        "min_area": 5.0,
        "description": "L-shaped counter + appliances",
    },
    RoomType.BATHROOM: {
        "min_short_side": 1.30,    # Minimum bathroom width
        "min_long_side": 1.80,     # WC + shower minimum
        "min_area": 2.5,
        "description": "WC + shower/tub",
    },
    RoomType.HALLWAY: {
        "min_short_side": 1.10,    # Barrier-free minimum passage
        "min_long_side": 1.50,     # Coat hook + shoe storage
        "min_area": 1.5,
        "description": "passage + coat storage",
    },
}


def score_furniture_feasibility(apartment: Apartment) -> float:
    """Score whether rooms can physically fit standard furniture (0-10).

    Checks minimum dimensions (not just area) against furniture requirements.
    A room might have enough area but be too narrow for a bed.
    """
    scores = []

    for room in apartment.rooms:
        if room.room_type in (RoomType.BALCONY, RoomType.SHAFT, RoomType.STORAGE):
            continue

        reqs = FURNITURE_REQUIREMENTS.get(room.room_type)
        if not reqs:
            continue

        bbox = _room_bbox(room)
        room_w = bbox[2] - bbox[0]
        room_h = bbox[3] - bbox[1]
        short_side = min(room_w, room_h)
        long_side = max(room_w, room_h)
        area = room.area_sqm

        min_short = reqs["min_short_side"]
        min_long = reqs["min_long_side"]
        min_area = reqs["min_area"]

        # Score each dimension independently, then combine
        short_score = min(1.0, short_side / min_short) if min_short > 0 else 1.0
        long_score = min(1.0, long_side / min_long) if min_long > 0 else 1.0
        area_score = min(1.0, area / min_area) if min_area > 0 else 1.0

        # Worst dimension is the bottleneck (a 2m wide bedroom can't fit a bed
        # regardless of length)
        room_score = min(short_score, long_score, area_score) * 10.0

        # Bonus for generous dimensions (up to 10% extra above minimum)
        if short_score >= 1.0 and long_score >= 1.0:
            generosity = (short_side / min_short - 1.0) * 2.0  # Extra credit
            room_score = min(10.0, room_score + generosity)

        scores.append(room_score)

    if not scores:
        return 5.0

    return round(sum(scores) / len(scores), 2)


# ============================================================
# 3. DAYLIGHT QUALITY — Window Ratio + Room Depth
# ============================================================

# DIN 5034: minimum window area = 1/8 of floor area for habitable rooms
DIN_5034_WINDOW_RATIO = 0.125  # 12.5%
TARGET_WINDOW_RATIO = 0.20     # Good practice target: 20%
MAX_ROOM_DEPTH = 6.0           # Meters from window wall — beyond this, daylight degrades


def score_daylight_quality(
    apartment: Apartment,
    windows: list[WindowPlacement],
    building_depth: float,
) -> float:
    """Score actual daylight quality using window-to-floor ratio and room depth (0-10).

    Goes beyond binary "touches exterior wall" to measure:
    1. Window area / floor area ratio per room (DIN 5034 minimum = 12.5%)
    2. Room depth from window wall (>6m = poor daylight penetration)
    """
    scores = []

    for room in apartment.rooms:
        if room.room_type not in (RoomType.LIVING, RoomType.BEDROOM, RoomType.KITCHEN):
            continue

        bbox = _room_bbox(room)
        room_min_x, room_min_y, room_max_x, room_max_y = bbox
        room_w = room_max_x - room_min_x
        room_h = room_max_y - room_min_y
        room_area = room.area_sqm

        if room_area <= 0:
            continue

        # Find windows belonging to this room (window center within room x-range,
        # on an exterior wall adjacent to this room)
        room_windows = []
        for win in windows:
            wx = win.position.x
            wy = win.position.y
            # Window must be within room's X span
            if room_min_x - 0.1 <= wx <= room_max_x + 0.1:
                # Window on south exterior wall and room touches south
                if wy < C.OUTER_LONG_WALL + 0.2 and room_min_y < C.OUTER_LONG_WALL + 0.2:
                    room_windows.append(win)
                # Window on north exterior wall and room touches north
                elif wy > building_depth - C.OUTER_LONG_WALL - 0.2 and room_max_y > building_depth - C.OUTER_LONG_WALL - 0.2:
                    room_windows.append(win)

        # === Window-to-floor ratio ===
        total_window_area = sum(w.width_m * w.height_m for w in room_windows)
        window_ratio = total_window_area / room_area if room_area > 0 else 0

        if window_ratio >= TARGET_WINDOW_RATIO:
            ratio_score = 10.0
        elif window_ratio >= DIN_5034_WINDOW_RATIO:
            # Linear interpolation between minimum and target
            ratio_score = 5.0 + (window_ratio - DIN_5034_WINDOW_RATIO) / (TARGET_WINDOW_RATIO - DIN_5034_WINDOW_RATIO) * 5.0
        elif window_ratio > 0:
            ratio_score = window_ratio / DIN_5034_WINDOW_RATIO * 5.0
        else:
            ratio_score = 0.0  # No windows = no daylight

        # === Room depth from window wall ===
        # Determine which wall has windows
        on_south = room_min_y < C.OUTER_LONG_WALL + 0.2
        on_north = room_max_y > building_depth - C.OUTER_LONG_WALL - 0.2

        if on_south or on_north:
            depth_from_window = room_h  # perpendicular distance into room
        else:
            depth_from_window = min(room_w, room_h)  # interior room, use shorter dimension

        if depth_from_window <= 4.5:
            depth_score = 10.0  # Excellent daylight penetration
        elif depth_from_window <= MAX_ROOM_DEPTH:
            depth_score = 10.0 - (depth_from_window - 4.5) / (MAX_ROOM_DEPTH - 4.5) * 5.0
        else:
            depth_score = max(0.0, 5.0 - (depth_from_window - MAX_ROOM_DEPTH) * 2.0)

        # Combined: window ratio is 60% of score, depth 40%
        combined = ratio_score * 0.6 + depth_score * 0.4
        scores.append(combined)

    if not scores:
        return 5.0

    return round(sum(scores) / len(scores), 2)


# ============================================================
# 4. KITCHEN-LIVING RELATIONSHIP
# ============================================================

def score_kitchen_living_relationship(apartment: Apartment) -> float:
    """Score the spatial quality of kitchen-living arrangement (0-10).

    In the Goldbeck system, the kitchen is merged into the living room
    as a Wohnküche (combined living/kitchen). This criterion evaluates:
    1. Whether the living room is large enough for both functions
    2. Whether the living room has good proportions for furniture + cooking zone
    3. Kitchen zone accessibility from the hallway (without crossing living area)
    """
    living = None
    hallway = None
    for room in apartment.rooms:
        if room.room_type == RoomType.LIVING:
            living = room
        elif room.room_type == RoomType.HALLWAY:
            hallway = room

    if living is None:
        return 0.0

    bbox = _room_bbox(living)
    liv_w = bbox[2] - bbox[0]
    liv_h = bbox[3] - bbox[1]
    short_side = min(liv_w, liv_h)
    long_side = max(liv_w, liv_h)
    area = living.area_sqm

    # === Size adequacy for Wohnküche ===
    # A combined living/kitchen needs ~20m² for comfortable use
    # Below 16m² it's cramped, below 12m² it's barely functional
    if area >= 22.0:
        size_score = 10.0
    elif area >= 18.0:
        size_score = 7.0 + (area - 18.0) / 4.0 * 3.0
    elif area >= 14.0:
        size_score = 4.0 + (area - 14.0) / 4.0 * 3.0
    else:
        size_score = max(0.0, area / 14.0 * 4.0)

    # === Proportion quality ===
    # Wohnküche works best when proportions are between 1:1 and 1:2
    # Too narrow (>1:2.5) means kitchen zone crowds the living zone
    aspect = short_side / long_side if long_side > 0 else 0
    if aspect >= 0.5:       # 1:2 or better
        proportion_score = 10.0
    elif aspect >= 0.4:     # 1:2.5
        proportion_score = 7.0
    elif aspect >= 0.33:    # 1:3
        proportion_score = 4.0
    else:
        proportion_score = max(0.0, aspect / 0.33 * 4.0)

    # === Hallway adjacency ===
    # Living room should be directly reachable from hallway
    adjacency_score = 5.0  # Default: neutral
    if hallway is not None:
        if _rooms_share_edge(living, hallway):
            adjacency_score = 10.0
        else:
            # Check if any intermediate room connects them
            other_rooms = [r for r in apartment.rooms
                          if r.id not in (living.id, hallway.id)]
            for intermediate in other_rooms:
                if (_rooms_share_edge(hallway, intermediate) and
                        _rooms_share_edge(intermediate, living)):
                    adjacency_score = 6.0
                    break
            else:
                adjacency_score = 2.0  # Poor: no clear path

    # Weight: size 40%, proportions 30%, adjacency 30%
    total = size_score * 0.4 + proportion_score * 0.3 + adjacency_score * 0.3
    return round(min(10.0, max(0.0, total)), 2)


# ============================================================
# 5. ORIENTATION-AWARE LAYOUT SCORING
# ============================================================

# Preferred compass directions for room types (degrees from north, clockwise)
# 0=North, 90=East, 180=South, 270=West
ORIENTATION_PREFERENCES = {
    RoomType.BEDROOM: {
        "ideal_range": (45, 135),    # East to Southeast — morning sun
        "acceptable_range": (0, 180), # North to South
        "avoid": (225, 315),          # Southwest to Northwest — hot afternoon sun
    },
    RoomType.LIVING: {
        "ideal_range": (180, 270),   # South to West — afternoon/evening sun
        "acceptable_range": (135, 315),
        "avoid": (315, 45),           # North — no direct sun
    },
    RoomType.KITCHEN: {
        "ideal_range": (45, 135),    # East — morning light for cooking
        "acceptable_range": (0, 180),
        "avoid": (225, 315),          # West — hot afternoon sun on food prep
    },
}


def _get_room_facade_direction(
    room: Room,
    building_depth: float,
    building_rotation_deg: float = 0.0,
) -> Optional[float]:
    """Determine which compass direction a room's windows face.

    Returns compass bearing in degrees (0=N, 90=E, 180=S, 270=W),
    or None if the room has no exterior wall.

    building_rotation_deg: rotation of building's long axis from East-West.
    0 means the long facade faces North and South.
    """
    bbox = _room_bbox(room)
    room_min_y = bbox[1]
    room_max_y = bbox[3]

    on_south = room_min_y < C.OUTER_LONG_WALL + 0.2
    on_north = room_max_y > building_depth - C.OUTER_LONG_WALL - 0.2

    if not on_south and not on_north:
        return None  # Interior room, no facade

    # Base direction: south facade = 180°, north facade = 0°
    if on_south:
        base_bearing = 180.0
    else:
        base_bearing = 0.0

    # Apply building rotation
    bearing = (base_bearing + building_rotation_deg) % 360
    return bearing


def _bearing_in_range(bearing: float, range_tuple: tuple[float, float]) -> bool:
    """Check if a bearing falls within a range (handles wrap-around)."""
    low, high = range_tuple
    if low <= high:
        return low <= bearing <= high
    else:
        # Wrap-around (e.g., 315 to 45)
        return bearing >= low or bearing <= high


def score_orientation(
    apartment: Apartment,
    building_depth: float,
    building_rotation_deg: float = 0.0,
) -> float:
    """Score how well room types are matched to compass orientation (0-10).

    building_rotation_deg: clockwise rotation of building's long axis
    from East-West. Default 0 means south facade faces true south.
    """
    scores = []

    for room in apartment.rooms:
        prefs = ORIENTATION_PREFERENCES.get(room.room_type)
        if not prefs:
            continue

        bearing = _get_room_facade_direction(room, building_depth, building_rotation_deg)
        if bearing is None:
            # Interior room — penalize habitable rooms without exterior exposure
            if room.room_type in (RoomType.LIVING, RoomType.BEDROOM):
                scores.append(2.0)
            continue

        if _bearing_in_range(bearing, prefs["ideal_range"]):
            scores.append(10.0)
        elif _bearing_in_range(bearing, prefs["acceptable_range"]):
            scores.append(7.0)
        elif _bearing_in_range(bearing, prefs["avoid"]):
            scores.append(2.0)
        else:
            scores.append(5.0)

    if not scores:
        return 5.0  # No rooms with orientation preferences

    return round(sum(scores) / len(scores), 2)


# ============================================================
# 6. ACOUSTIC ZONING — Bedroom isolation from wet/noisy rooms
# ============================================================

def _room_centroid(room: Room) -> tuple[float, float]:
    xs = [p.x for p in room.polygon]
    ys = [p.y for p in room.polygon]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def score_acoustic_zoning(
    floor: FloorPlan,
) -> float:
    """Score how well bedrooms are isolated from acoustic nuisances (0-10).

    Two sub-criteria, equally weighted:
      A. Intra-apartment isolation: bedroom centroid distance to bathroom
         centroid in the same apartment. Closer = bad (plumbing noise +
         door slams). Distance ≥3.5m gets full marks; 0m gets zero.
      B. Bedroom-to-staircase wall sharing: bedrooms whose centroid sits
         within 2.5m of any staircase center are penalized (corridor traffic
         and impact noise from stair use).
    """
    if not floor.apartments:
        return 5.0

    intra_scores: list[float] = []
    for apt in floor.apartments:
        bedrooms = [r for r in apt.rooms if r.room_type == RoomType.BEDROOM and len(r.polygon) >= 4]
        baths = [r for r in apt.rooms if r.room_type == RoomType.BATHROOM and len(r.polygon) >= 4]
        if not bedrooms or not baths:
            continue
        bath_cs = [_room_centroid(b) for b in baths]
        for bed in bedrooms:
            bcx, bcy = _room_centroid(bed)
            min_d = min(
                math.sqrt((bcx - bx) ** 2 + (bcy - by) ** 2)
                for bx, by in bath_cs
            )
            # 0m → 0; 3.5m+ → 10
            score = max(0.0, min(10.0, (min_d / 3.5) * 10.0))
            intra_scores.append(score)

    intra_avg = sum(intra_scores) / len(intra_scores) if intra_scores else 7.0

    # Sub-criterion B: bedroom-to-staircase distance
    stair_scores: list[float] = []
    if floor.staircases:
        stair_centers = [
            (s.position.x + s.width_m / 2, s.position.y + s.depth_m / 2)
            for s in floor.staircases
        ]
        for apt in floor.apartments:
            for room in apt.rooms:
                if room.room_type != RoomType.BEDROOM or len(room.polygon) < 4:
                    continue
                bcx, bcy = _room_centroid(room)
                min_d = min(
                    math.sqrt((bcx - sx) ** 2 + (bcy - sy) ** 2)
                    for sx, sy in stair_centers
                )
                # <2.5m → 0; ≥6m → 10; linear in between
                if min_d <= 2.5:
                    stair_scores.append(0.0)
                elif min_d >= 6.0:
                    stair_scores.append(10.0)
                else:
                    stair_scores.append((min_d - 2.5) / 3.5 * 10.0)

    stair_avg = sum(stair_scores) / len(stair_scores) if stair_scores else 7.0

    return round((intra_avg + stair_avg) / 2.0, 2)


# ============================================================
# AGGREGATE SCORER
# ============================================================

def evaluate_quality(
    floor: FloorPlan,
    building_depth_m: float,
    building_rotation_deg: float = 0.0,
) -> dict[str, float]:
    """Run all 5 quality criteria on a single floor plan. Returns breakdown dict.

    Each criterion scores 0.0 to 10.0.

    Note: takes a single FloorPlan (not BuildingFloorPlans) because Phase 1's
    per-floor optimizer evaluates each floor independently. Pass the parent
    building's depth_m as `building_depth_m` since FloorPlan doesn't carry it.
    """
    breakdown: dict[str, float] = {}

    depth = building_depth_m

    # Collect per-apartment scores
    connectivity_scores = []
    furniture_scores = []
    daylight_scores = []
    kitchen_living_scores = []
    orientation_scores = []

    for apt in floor.apartments:
        connectivity_scores.append(score_room_connectivity(apt))
        furniture_scores.append(score_furniture_feasibility(apt))
        daylight_scores.append(score_daylight_quality(apt, floor.windows, depth))
        kitchen_living_scores.append(score_kitchen_living_relationship(apt))
        orientation_scores.append(score_orientation(apt, depth, building_rotation_deg))

    def avg(lst: list[float]) -> float:
        return round(sum(lst) / len(lst), 3) if lst else 5.0

    breakdown["connectivity"] = avg(connectivity_scores)
    breakdown["furniture"] = avg(furniture_scores)
    breakdown["daylight"] = avg(daylight_scores)
    breakdown["kitchen_living"] = avg(kitchen_living_scores)
    breakdown["orientation"] = avg(orientation_scores)
    breakdown["acoustic"] = score_acoustic_zoning(floor)

    return breakdown
