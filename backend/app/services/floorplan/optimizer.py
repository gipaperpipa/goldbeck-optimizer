"""
Evolutionary floor plan optimizer with 10-criterion fitness evaluation.

Generates diverse Goldbeck floor plan variants by evolving variation_params
that control bay raster preferences, allocation order, room proportions,
service strip layout, depth configuration, and staircase placement.

Uses per-bay raster preferences (list of floats 0.0-1.0) to create hundreds
of unique bay combinations instead of just 4 named strategies.

Uses niching (fitness sharing) to maintain population diversity and prevent
premature convergence to a single layout type.
"""

import math
import random
from typing import Callable, Optional

from app.models.floorplan import (
    FloorPlanRequest, BuildingFloorPlans, FloorPlanVariant,
    FloorPlanWeights, AccessType, RoomType,
)
from app.services.floorplan.registry import get_system
from app.services.floorplan import goldbeck_constants as C
from app.services.floorplan.quality_scoring import evaluate_quality


# ============================================================
# Chromosome — encodes ALL variation parameters
# ============================================================

ALLOCATION_ORDERS = ["large_first", "small_first", "mixed"]
SERVICE_ORDERS = ["hall_bath_kitchen", "kitchen_bath_hall", "hall_kitchen_bath"]

# Number of raster preference values (enough for ~20 bays in longest buildings)
NUM_RASTER_PREFS = 24


class FloorPlanChromosome:
    """Encodes variation parameters for the Goldbeck generator.

    Key gene: raster_preferences — a list of floats (0.0-1.0) that control
    which raster width is selected for each bay position:
      0.0 = smallest valid raster (3.125m)
      1.0 = largest valid raster (6.25m)

    This creates a combinatorial explosion of possible bay layouts instead
    of just 4 named strategies.
    """

    def __init__(self):
        # PRIMARY: per-bay raster selection (highest structural impact)
        self.raster_preferences: list[float] = [
            random.random() for _ in range(NUM_RASTER_PREFS)
        ]
        # Depth config: UNIFORM across all valid configs (no bias to index 0)
        self.depth_config_index: int = random.randint(0, len(C.GANGHAUS_DEPTH_CONFIGS) - 1)
        # Access type bias: 0.0=spaenner, 1.0=ganghaus (only matters at borderline depths)
        self.access_type_bias: float = random.random()
        # Allocation order for apartment assignment
        self.allocation_order: str = random.choice(ALLOCATION_ORDERS)
        # Service strip room arrangement
        self.service_layout_order: str = random.choice(SERVICE_ORDERS)
        # Per-apartment room width proportions
        self.room_proportions: list[float] = [
            0.25 + random.random() * 0.40 for _ in range(12)
        ]
        # Staircase variation
        self.staircase_count_delta: int = random.choice([-1, 0, 0, 0, 1])
        self.staircase_position_offset: float = random.uniform(-0.4, 0.4)
        # Bathroom/barrier-free preference
        self.bathroom_preference: float = random.random()
        # Dimension offsets: allow ±3 grid units for meaningful width/depth variation
        self.dim_offset: float = random.uniform(-3.0, 3.0)
        self.depth_offset: float = random.uniform(-3.0, 3.0)
        # Evaluation results
        self.fitness: float = 0.0
        self.raw_fitness: float = 0.0
        self.fitness_breakdown: dict[str, float] = {}
        self._plan_sig: Optional[tuple] = None

    def clone(self) -> "FloorPlanChromosome":
        c = FloorPlanChromosome.__new__(FloorPlanChromosome)
        c.raster_preferences = list(self.raster_preferences)
        c.depth_config_index = self.depth_config_index
        c.access_type_bias = self.access_type_bias
        c.allocation_order = self.allocation_order
        c.service_layout_order = self.service_layout_order
        c.room_proportions = list(self.room_proportions)
        c.staircase_count_delta = self.staircase_count_delta
        c.staircase_position_offset = self.staircase_position_offset
        c.bathroom_preference = self.bathroom_preference
        c.dim_offset = self.dim_offset
        c.depth_offset = self.depth_offset
        c.fitness = self.fitness
        c.raw_fitness = self.raw_fitness
        c.fitness_breakdown = dict(self.fitness_breakdown)
        c._plan_sig = self._plan_sig
        return c

    def to_variation_params(self) -> dict:
        """Convert chromosome to variation_params dict for the generator."""
        return {
            "raster_preferences": self.raster_preferences,
            "depth_config_index": self.depth_config_index,
            "allocation_order": self.allocation_order,
            "service_layout_order": self.service_layout_order,
            "room_proportions": self.room_proportions,
            "staircase_count_delta": self.staircase_count_delta,
            "staircase_position_offset": self.staircase_position_offset,
        }

    @staticmethod
    def make_seeded(
        pref_bias: float,
        depth_idx: int = 0,
        access_bias: float = 0.5,
    ) -> "FloorPlanChromosome":
        """Create a chromosome with a specific raster preference bias.

        pref_bias: 0.0=all small rasters, 0.5=median, 1.0=all large rasters.
        Adds per-bay jitter so each seeded chromosome is unique.
        """
        c = FloorPlanChromosome()
        jitter = 0.15
        c.raster_preferences = [
            max(0.0, min(1.0, pref_bias + random.uniform(-jitter, jitter)))
            for _ in range(NUM_RASTER_PREFS)
        ]
        c.depth_config_index = depth_idx
        c.access_type_bias = access_bias
        return c


def _plan_signature(plans: BuildingFloorPlans) -> tuple:
    """Structural signature for deduplication and niching.

    Captures bay widths, access type, and apartment type distribution —
    the things that make a floor plan look visually different.
    """
    floor = plans.floor_plans[0] if plans.floor_plans else None
    apt_types = ""
    if floor:
        type_counts: dict[str, int] = {}
        for a in floor.apartments:
            type_counts[a.apartment_type.value] = type_counts.get(a.apartment_type.value, 0) + 1
        apt_types = str(sorted(type_counts.items()))
    return (
        tuple(round(w, 2) for w in plans.structural_grid.bay_widths),
        plans.access_type.value,
        plans.total_apartments,
        apt_types,
    )


# ============================================================
# Genetic Operators
# ============================================================

def _adaptive_mutation_rate(base_rate: float, generation: int, total_generations: int) -> float:
    """Decay mutation rate over generations.

    Starts at base_rate, decays exponentially to ~20% of base_rate by the final
    generation. This allows aggressive exploration early on and fine refinement
    later — preventing the population average from degrading after the best
    individual has been found.
    """
    if total_generations <= 1:
        return base_rate
    progress = generation / total_generations  # 0.0 → 1.0
    # Exponential decay: base_rate → base_rate * 0.20
    min_rate = base_rate * 0.20
    return min_rate + (base_rate - min_rate) * math.exp(-3.5 * progress)


def _mutate(
    chrom: FloorPlanChromosome,
    rate: float = 0.25,
    generation: int = 0,
    total_generations: int = 1,
) -> FloorPlanChromosome:
    """Apply mutations to chromosome fields with adaptive rate decay."""
    # Apply adaptive decay — early generations explore, later ones refine
    effective_rate = _adaptive_mutation_rate(rate, generation, total_generations)

    c = chrom.clone()
    c._plan_sig = None  # invalidate cache

    # Gaussian sigma also decays: less disruptive perturbations in later generations
    sigma_scale = 0.4 + 0.6 * (1.0 - generation / max(1, total_generations))

    # Mutate raster preferences (most important gene)
    for i in range(len(c.raster_preferences)):
        if random.random() < effective_rate:
            c.raster_preferences[i] = max(0.0, min(1.0,
                c.raster_preferences[i] + random.gauss(0, 0.2 * sigma_scale)))

    # Big raster jump — reduced probability, further reduced in later generations
    big_jump_prob = effective_rate * 0.20  # was 0.50, now 0.20
    if random.random() < big_jump_prob:
        idx = random.randint(0, len(c.raster_preferences) - 1)
        c.raster_preferences[idx] = random.random()

    if random.random() < effective_rate:
        c.depth_config_index = random.randint(0, len(C.GANGHAUS_DEPTH_CONFIGS) - 1)
    if random.random() < effective_rate:
        c.access_type_bias = max(0.0, min(1.0,
            c.access_type_bias + random.gauss(0, 0.2 * sigma_scale)))
    if random.random() < effective_rate:
        c.allocation_order = random.choice(ALLOCATION_ORDERS)
    if random.random() < effective_rate:
        c.service_layout_order = random.choice(SERVICE_ORDERS)
    if random.random() < effective_rate:
        c.staircase_count_delta = random.choice([-1, 0, 0, 0, 1])
    if random.random() < effective_rate:
        c.staircase_position_offset = max(-0.4, min(0.4,
            c.staircase_position_offset + random.gauss(0, 0.15 * sigma_scale)))
    if random.random() < effective_rate:
        c.bathroom_preference = max(0.0, min(1.0,
            c.bathroom_preference + random.gauss(0, 0.15 * sigma_scale)))
    if random.random() < effective_rate:
        c.dim_offset = max(-3.0, min(3.0, c.dim_offset + random.gauss(0, 0.8 * sigma_scale)))
    if random.random() < effective_rate:
        c.depth_offset = max(-3.0, min(3.0, c.depth_offset + random.gauss(0, 0.8 * sigma_scale)))

    for i in range(len(c.room_proportions)):
        if random.random() < effective_rate:
            c.room_proportions[i] = max(0.20, min(0.65,
                c.room_proportions[i] + random.gauss(0, 0.08 * sigma_scale)))

    return c


def _crossover(a: FloorPlanChromosome, b: FloorPlanChromosome) -> FloorPlanChromosome:
    """Uniform crossover with per-gene random parent selection."""
    c = FloorPlanChromosome.__new__(FloorPlanChromosome)
    pick = lambda x, y: x if random.random() < 0.5 else y

    # Crossover raster preferences (can mix-and-match per bay)
    c.raster_preferences = [
        pick(a.raster_preferences[i], b.raster_preferences[i])
        for i in range(min(len(a.raster_preferences), len(b.raster_preferences)))
    ]
    c.depth_config_index = pick(a.depth_config_index, b.depth_config_index)
    c.access_type_bias = pick(a.access_type_bias, b.access_type_bias)
    c.allocation_order = pick(a.allocation_order, b.allocation_order)
    c.service_layout_order = pick(a.service_layout_order, b.service_layout_order)
    c.staircase_count_delta = pick(a.staircase_count_delta, b.staircase_count_delta)
    c.staircase_position_offset = pick(a.staircase_position_offset, b.staircase_position_offset)
    c.bathroom_preference = pick(a.bathroom_preference, b.bathroom_preference)
    c.dim_offset = pick(a.dim_offset, b.dim_offset)
    c.depth_offset = pick(a.depth_offset, b.depth_offset)
    c.room_proportions = [
        pick(a.room_proportions[i], b.room_proportions[i])
        for i in range(min(len(a.room_proportions), len(b.room_proportions)))
    ]
    c.fitness = 0.0
    c.raw_fitness = 0.0
    c.fitness_breakdown = {}
    c._plan_sig = None
    return c


def _tournament_select(population: list[FloorPlanChromosome], k: int = 3) -> FloorPlanChromosome:
    candidates = random.sample(population, min(k, len(population)))
    return max(candidates, key=lambda c: c.fitness)


# ============================================================
# 10-Criterion Fitness Function
# ============================================================

def _evaluate_floor_plan(
    plans: BuildingFloorPlans,
    request: FloorPlanRequest,
    weights: FloorPlanWeights,
) -> tuple[float, dict[str, float]]:
    """
    Multi-criteria fitness evaluation. Returns (total_score, breakdown_dict).
    Each criterion scores 0.0 to 10.0.

    Efficiency group:
      1. net_to_gross     - net usable area / gross area
      2. construction_regularity - uniformity of bay widths

    Livability group:
      3. room_aspect_ratios - penalize rooms narrower than 1:3
      4. natural_light      - % habitable rooms touching exterior wall
      5. noise_separation   - bedrooms far from staircases

    Revenue group:
      6. unit_mix_match    - closeness to requested unit mix
      7. room_size_compliance - rooms within Goldbeck spec areas
      8. area_balance      - same-type apartments have similar areas

    Compliance group:
      9.  fire_egress      - all apartments within 35m of staircase
      10. barrier_free     - adequate barrier-free bathroom coverage
    """
    breakdown: dict[str, float] = {}

    if not plans.floor_plans:
        return 0.0, {}

    floor = plans.floor_plans[0]
    grid = plans.structural_grid
    depth = grid.building_depth_m

    # --- 1. Net-to-gross ratio ---
    if floor.gross_area_sqm > 0:
        ratio = floor.net_area_sqm / floor.gross_area_sqm
        breakdown["net_to_gross"] = max(0.0, min(10.0, (ratio - 0.40) / 0.45 * 10.0))
    else:
        breakdown["net_to_gross"] = 0.0

    # --- 2. Construction regularity ---
    # NOTE: Reduced impact — uniform bays (6.25+6.25) are not inherently better
    # than mixed bays (5.00+6.25). All Goldbeck rasters are valid.
    bays = grid.bay_widths
    if len(bays) >= 2:
        mean_bay = sum(bays) / len(bays)
        std_dev = (sum((b - mean_bay) ** 2 for b in bays) / len(bays)) ** 0.5
        cv = std_dev / mean_bay if mean_bay > 0 else 0
        # All valid Goldbeck rasters score well; only penalize extreme variation
        breakdown["construction_regularity"] = max(3.0, min(10.0, 7.5 - cv * 5.0))
    else:
        breakdown["construction_regularity"] = 7.0

    # --- 2b. Circulation efficiency ---
    # Penalize excessive hallway/corridor area. Hallways, corridors, staircases,
    # and elevator shafts are non-sellable/non-rentable "dead" area. The target
    # is <15% of gross floor area; anything above 25% is heavily penalized.
    circulation_area = 0.0
    for apt in floor.apartments:
        for room in apt.rooms:
            if room.room_type in (RoomType.HALLWAY, RoomType.CORRIDOR):
                circulation_area += room.area_sqm
    # Add corridor/staircase common areas (not inside apartments)
    for room in floor.rooms:
        if room.room_type in (RoomType.CORRIDOR, RoomType.STAIRCASE, RoomType.ELEVATOR, RoomType.SHAFT):
            if room.apartment_id is None or room.apartment_id == "":
                circulation_area += room.area_sqm

    if floor.gross_area_sqm > 0:
        circ_pct = circulation_area / floor.gross_area_sqm
        # 0-12% → score 10, 12-18% → 6-10, 18-30% → 0-6
        if circ_pct <= 0.12:
            breakdown["circulation_efficiency"] = 10.0
        elif circ_pct <= 0.18:
            breakdown["circulation_efficiency"] = 6.0 + (0.18 - circ_pct) / 0.06 * 4.0
        elif circ_pct <= 0.30:
            breakdown["circulation_efficiency"] = max(0.0, 6.0 - (circ_pct - 0.18) / 0.12 * 6.0)
        else:
            breakdown["circulation_efficiency"] = 0.0
    else:
        breakdown["circulation_efficiency"] = 5.0

    # --- 3. Room aspect ratios ---
    aspect_scores = []
    for apt in floor.apartments:
        for room in apt.rooms:
            if room.room_type in (RoomType.LIVING, RoomType.BEDROOM, RoomType.KITCHEN):
                poly = room.polygon
                if len(poly) >= 4:
                    xs = [p.x for p in poly]
                    ys = [p.y for p in poly]
                    w = max(xs) - min(xs)
                    h = max(ys) - min(ys)
                    if h > 0 and w > 0:
                        ratio = min(w, h) / max(w, h)
                        if ratio >= 0.5:
                            aspect_scores.append(10.0)
                        elif ratio >= 0.33:
                            aspect_scores.append(5.0 + (ratio - 0.33) / 0.17 * 5.0)
                        else:
                            aspect_scores.append(max(0.0, ratio / 0.33 * 5.0))
    breakdown["room_aspect_ratios"] = (
        sum(aspect_scores) / len(aspect_scores) if aspect_scores else 5.0
    )

    # --- 4. Natural light ---
    habitable_count = 0
    lit_count = 0
    for apt in floor.apartments:
        for room in apt.rooms:
            if room.room_type in (RoomType.LIVING, RoomType.BEDROOM, RoomType.KITCHEN):
                habitable_count += 1
                poly = room.polygon
                if len(poly) >= 4:
                    min_y = min(p.y for p in poly)
                    max_y = max(p.y for p in poly)
                    on_exterior = (
                        min_y <= C.OUTER_LONG_WALL + 0.15 or
                        max_y >= depth - C.OUTER_LONG_WALL - 0.15
                    )
                    if on_exterior:
                        lit_count += 1
    breakdown["natural_light"] = (
        (lit_count / habitable_count * 10.0) if habitable_count > 0 else 5.0
    )

    # --- 5. Noise separation ---
    if floor.apartments and floor.staircases:
        stair_centers = []
        for s in floor.staircases:
            sx = s.position.x + s.width_m / 2
            sy = s.position.y + s.depth_m / 2
            stair_centers.append((sx, sy))

        bedroom_distances = []
        for apt in floor.apartments:
            for room in apt.rooms:
                if room.room_type == RoomType.BEDROOM and len(room.polygon) >= 4:
                    rx = sum(p.x for p in room.polygon) / len(room.polygon)
                    ry = sum(p.y for p in room.polygon) / len(room.polygon)
                    min_dist = min(
                        math.sqrt((rx - sx) ** 2 + (ry - sy) ** 2)
                        for sx, sy in stair_centers
                    )
                    bedroom_distances.append(min_dist)

        if bedroom_distances:
            avg_dist = sum(bedroom_distances) / len(bedroom_distances)
            breakdown["noise_separation"] = min(10.0, avg_dist / 6.0 * 10.0)
        else:
            breakdown["noise_separation"] = 5.0
    else:
        breakdown["noise_separation"] = 5.0

    # --- 6. Unit mix match ---
    if request.unit_mix and "entries" in request.unit_mix:
        target_counts: dict[str, int] = {}
        for entry in request.unit_mix["entries"]:
            apt_type = C.UNIT_TYPE_TO_APARTMENT.get(entry.get("unit_type", ""), "")
            if apt_type:
                target_counts[apt_type] = entry.get("count", 0)

        if target_counts:
            actual_counts: dict[str, int] = {}
            for apt in floor.apartments:
                key = apt.apartment_type.value
                actual_counts[key] = actual_counts.get(key, 0) + 1

            match_scores = []
            for apt_type, target in target_counts.items():
                actual = actual_counts.get(apt_type, 0)
                if target > 0:
                    match_scores.append(max(0, 1.0 - abs(actual - target) / target))
                else:
                    match_scores.append(1.0 if actual == 0 else 0.5)
            breakdown["unit_mix_match"] = (
                sum(match_scores) / len(match_scores) * 10.0 if match_scores else 7.0
            )
        else:
            breakdown["unit_mix_match"] = 7.0
    else:
        breakdown["unit_mix_match"] = 7.0

    # --- 7. Room size compliance ---
    compliant = 0.0
    total_apts = 0
    for apt in floor.apartments:
        spec = C.APARTMENT_BAY_SPECS.get(apt.apartment_type.value, {})
        min_area = spec.get("min_area_sqm", 15.0)
        max_area = spec.get("max_area_sqm", 120.0)
        target_area = spec.get("target_area_sqm", (min_area + max_area) / 2)
        total_apts += 1
        area = apt.total_area_sqm
        if area <= 0:
            continue
        if min_area <= area <= max_area:
            deviation = abs(area - target_area) / target_area
            compliant += max(0.6, 1.0 - deviation * 0.5)
        else:
            if area < min_area:
                ratio = area / min_area
            else:
                ratio = max_area / area
            compliant += max(0.1, ratio * 0.5)
    breakdown["room_size_compliance"] = (
        (compliant / total_apts * 10.0) if total_apts > 0 else 5.0
    )

    # --- 8. Area balance ---
    type_areas: dict[str, list[float]] = {}
    for apt in floor.apartments:
        key = apt.apartment_type.value
        type_areas.setdefault(key, []).append(apt.total_area_sqm)

    balance_scores = []
    for areas in type_areas.values():
        if len(areas) >= 2:
            mean = sum(areas) / len(areas)
            if mean > 0:
                cv = (sum((a - mean) ** 2 for a in areas) / len(areas)) ** 0.5 / mean
                balance_scores.append(max(0.0, 10.0 - cv * 15.0))
            else:
                balance_scores.append(5.0)
        else:
            balance_scores.append(8.0)
    breakdown["area_balance"] = (
        sum(balance_scores) / len(balance_scores) if balance_scores else 5.0
    )

    # --- 9. Fire egress distance ---
    if floor.apartments and floor.staircases:
        violations = 0
        for apt in floor.apartments:
            all_xs = []
            all_ys = []
            for room in apt.rooms:
                for p in room.polygon:
                    all_xs.append(p.x)
                    all_ys.append(p.y)
            if all_xs and all_ys:
                cx = (min(all_xs) + max(all_xs)) / 2
                cy = (min(all_ys) + max(all_ys)) / 2
                min_dist = min(
                    math.sqrt((cx - (s.position.x + s.width_m / 2)) ** 2 +
                              (cy - (s.position.y + s.depth_m / 2)) ** 2)
                    for s in floor.staircases
                )
                if min_dist > C.MAX_TRAVEL_DISTANCE:
                    violations += 1

        breakdown["fire_egress"] = (
            max(0.0, 10.0 - violations * 3.0) if total_apts > 0 else 10.0
        )
    else:
        breakdown["fire_egress"] = 5.0

    # --- 10. Barrier-free compliance ---
    barrier_free_count = 0
    total_bath_count = 0
    for apt in floor.apartments:
        total_bath_count += 1
        bath_type = apt.bathroom.bathroom_type.value
        bath_info = C.BATHROOM_DIMENSIONS.get(bath_type, {})
        if bath_info.get("barrier_free", False):
            barrier_free_count += 1

    if total_bath_count > 0:
        bf_ratio = barrier_free_count / total_bath_count
        breakdown["barrier_free"] = min(10.0, bf_ratio * 12.5)
    else:
        breakdown["barrier_free"] = 5.0

    # --- 11. Dimension conformance ---
    # Penalize floor plans whose dimensions don't match the requested footprint
    actual_width = plans.building_width_m
    actual_depth = plans.building_depth_m
    requested_width = request.building_width_m
    requested_depth = request.building_depth_m
    width_deviation = abs(actual_width - requested_width) / max(requested_width, 1.0)
    depth_deviation = abs(actual_depth - requested_depth) / max(requested_depth, 1.0)
    avg_deviation = (width_deviation + depth_deviation) / 2
    # Score: 10.0 if exact match, drops with deviation
    breakdown["dimension_conformance"] = max(0.0, 10.0 - avg_deviation * 40.0)

    # --- 12. Apartment access compliance ---
    # Validates architectural rules:
    #   - Each apartment has exactly one entrance door
    #   - Entrance door connects to hallway room
    #   - Upper floors: entrance faces corridor/gallery (not exterior)
    #   - Ground floor: entrance can face exterior (direct outside access)
    access_violations = 0
    for apt in floor.apartments:
        has_hallway = any(r.room_type == RoomType.HALLWAY for r in apt.rooms)
        has_entrance = apt.entrance_door_id is not None and apt.entrance_door_id != ""
        if not has_hallway:
            access_violations += 1
        if not has_entrance:
            access_violations += 1

    # Check that entrance doors exist in the door list
    entrance_door_ids = {d.id for d in floor.doors if d.is_entrance}
    for apt in floor.apartments:
        if apt.entrance_door_id and apt.entrance_door_id not in entrance_door_ids:
            access_violations += 1

    if total_apts > 0:
        violation_ratio = access_violations / (total_apts * 3)  # 3 checks per apt
        breakdown["access_compliance"] = max(0.0, 10.0 - violation_ratio * 30.0)
    else:
        breakdown["access_compliance"] = 5.0

    # === Advanced quality criteria (5 new architectural quality scores) ===
    # These evaluate deeper architectural quality: room connectivity,
    # furniture fit, daylight, kitchen-living relationship, orientation.
    quality = evaluate_quality(plans, building_rotation_deg=request.rotation_deg)
    breakdown["connectivity"] = quality["connectivity"]
    breakdown["furniture"] = quality["furniture"]
    breakdown["daylight_quality"] = quality["daylight"]
    breakdown["kitchen_living"] = quality["kitchen_living"]
    breakdown["orientation"] = quality["orientation"]

    # === Weighted combination ===
    # Efficiency now includes circulation penalty — hallways are dead area
    efficiency_score = (
        breakdown["net_to_gross"] * 1.0 +
        breakdown["construction_regularity"] * 0.5 +
        breakdown["circulation_efficiency"] * 1.5  # heavy weight: minimize hallways
    ) / 3.0

    # Enhanced livability: add connectivity, furniture, daylight quality,
    # kitchen-living, and orientation to the livability group.
    # The new criteria are weighted more heavily since they represent
    # the architectural improvements that matter most.
    livability_score = (
        breakdown["room_aspect_ratios"] * 0.8 +
        breakdown["natural_light"] * 0.5 +
        breakdown["noise_separation"] * 0.7 +
        breakdown["connectivity"] * 1.2 +
        breakdown["furniture"] * 1.0 +
        breakdown["daylight_quality"] * 1.0 +
        breakdown["kitchen_living"] * 1.0 +
        breakdown["orientation"] * 0.8
    ) / 7.0  # Normalize to 0-10 range

    revenue_score = (
        breakdown["unit_mix_match"] + breakdown["room_size_compliance"] +
        breakdown["area_balance"]
    ) / 3.0

    compliance_score = (
        breakdown["fire_egress"] + breakdown["barrier_free"] +
        breakdown["access_compliance"] + breakdown["dimension_conformance"]
    ) / 4.0

    total = (
        weights.efficiency * efficiency_score +
        weights.livability * livability_score +
        weights.revenue * revenue_score +
        weights.compliance * compliance_score
    ) * 10.0  # Scale to 0-100

    return round(total, 3), breakdown


# ============================================================
# Variant Generation
# ============================================================

def generate_variant(
    request: FloorPlanRequest,
    chromosome: FloorPlanChromosome,
) -> Optional[BuildingFloorPlans]:
    """Generate a floor plan variant using chromosome's variation_params."""
    system = get_system(request.construction_system)

    modified = request.model_copy(deep=True)

    # Vary story height
    if chromosome.bathroom_preference > 0.7:
        modified.story_height_m = C.STORY_HEIGHT_STANDARD_B
    else:
        modified.story_height_m = C.STORY_HEIGHT_STANDARD_A

    # Vary internal dimensions within grid tolerance for apartment layout diversity,
    # but NEVER exceed the original building footprint from layout optimization.
    # Offsets can only shrink the building inward (negative only), not grow it.
    dim_offset_m = min(0.0, chromosome.dim_offset * C.GRID_UNIT)
    modified.building_width_m = max(9.0, request.building_width_m + dim_offset_m)
    depth_offset_m = min(0.0, chromosome.depth_offset * C.GRID_UNIT)
    modified.building_depth_m = max(8.0, request.building_depth_m + depth_offset_m)

    # Vary access type for borderline depths
    w_m = modified.building_width_m
    d_m = modified.building_depth_m
    short_side = min(w_m, d_m)
    if request.access_type_override is None:
        # Use access_type_bias to explore all three access types for borderline depths
        # bias: 0.0-0.33 = Spaenner, 0.33-0.66 = Laubengang, 0.66-1.0 = Ganghaus
        if 6.0 < short_side < 14.0:
            if chromosome.access_type_bias > 0.66:
                modified.access_type_override = AccessType.GANGHAUS
            elif chromosome.access_type_bias > 0.33:
                modified.access_type_override = AccessType.LAUBENGANG
            else:
                modified.access_type_override = AccessType.SPAENNER

    # Vary barrier-free preference
    modified.prefer_barrier_free = chromosome.bathroom_preference > 0.4

    # Build variation params from chromosome
    variation_params = chromosome.to_variation_params()

    try:
        result = system.generate_floor_plans(modified, variation_params=variation_params)
        return result
    except Exception:
        return None


# ============================================================
# Optimizer with Diversity Preservation
# ============================================================

def _apply_fitness_sharing(population: list[FloorPlanChromosome], sigma: float = 0.3):
    """
    Fitness sharing: reduce fitness of individuals with the same plan signature.
    Prevents any one layout type from dominating the population.
    """
    groups: dict[Optional[tuple], list[FloorPlanChromosome]] = {}
    for c in population:
        groups.setdefault(c._plan_sig, []).append(c)

    for group in groups.values():
        niche_size = len(group)
        if niche_size > 1:
            for c in group:
                c.fitness = c.fitness / (niche_size ** sigma)


class FloorPlanOptimizer:
    """Evolutionary optimizer for floor plan layouts with diversity preservation."""

    def optimize(
        self,
        request: FloorPlanRequest,
        progress_callback: Optional[Callable[[int, int, float, float], None]] = None,
    ) -> list[FloorPlanVariant]:
        pop_size = max(6, request.population_size)
        generations = max(1, request.generations)
        mutation_rate = 0.25  # Default mutation rate

        # Apply AI-assisted generation enhancements if enabled
        if request.use_ai_generation:
            generations = max(100, generations * 2)  # Double generations with minimum of 100
            pop_size = max(6, int(pop_size * 1.5))   # Increase population by 50%
            mutation_rate = 0.40  # Increase mutation rate for more aggressive exploration

        elite_count = max(2, pop_size // 5)
        top_k = min(8, pop_size)
        weights = request.weights or FloorPlanWeights()

        # ---- Seed initial population with diverse bay preferences ----
        population: list[FloorPlanChromosome] = []

        # Spread across raster preference spectrum: small, medium-small, medium, medium-large, large
        for bias in [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]:
            population.append(FloorPlanChromosome.make_seeded(bias))

        # Add seeds with alternating patterns (large/small)
        c_alt = FloorPlanChromosome()
        c_alt.raster_preferences = [
            (1.0 if i % 2 == 0 else 0.0) for i in range(NUM_RASTER_PREFS)
        ]
        population.append(c_alt)

        # Add seeds with ALL different depth configs for maximum diversity
        for depth_idx in range(min(len(C.GANGHAUS_DEPTH_CONFIGS), 10)):
            c = FloorPlanChromosome.make_seeded(
                random.uniform(0.2, 0.8), depth_idx=depth_idx
            )
            population.append(c)

        # Add seeds with all three access types (Spaenner, Laubengang, Ganghaus)
        population.append(FloorPlanChromosome.make_seeded(0.5, access_bias=0.15))  # Spaenner
        population.append(FloorPlanChromosome.make_seeded(0.5, access_bias=0.50))  # Laubengang
        population.append(FloorPlanChromosome.make_seeded(0.5, access_bias=0.85))  # Ganghaus

        # Fill remaining with fully random chromosomes
        while len(population) < pop_size:
            population.append(FloorPlanChromosome())

        # Trim to exact pop size if over-seeded
        population = population[:pop_size]

        # ---- Evaluate initial population ----
        best_raw_fitness = 0.0
        best_ever_chrom: Optional[FloorPlanChromosome] = None
        for chrom in population:
            plans = generate_variant(request, chrom)
            if plans:
                chrom.raw_fitness, chrom.fitness_breakdown = _evaluate_floor_plan(
                    plans, request, weights
                )
                chrom.fitness = chrom.raw_fitness
                chrom._plan_sig = _plan_signature(plans)
                if chrom.raw_fitness > best_raw_fitness:
                    best_raw_fitness = chrom.raw_fitness
                    best_ever_chrom = chrom.clone()
            else:
                chrom.fitness = 0.0
                chrom.raw_fitness = 0.0

        _apply_fitness_sharing(population)

        # Build live preview of best variant
        def _build_live_preview(chrom: FloorPlanChromosome) -> Optional[FloorPlanVariant]:
            if chrom is None or chrom.raw_fitness <= 0:
                return None
            plans = generate_variant(request, chrom)
            if not plans:
                return None
            _, breakdown = _evaluate_floor_plan(plans, request, weights)
            return FloorPlanVariant(
                rank=1,
                fitness_score=round(chrom.raw_fitness, 2),
                fitness_breakdown={k: round(v, 2) for k, v in breakdown.items()},
                building_floor_plans=plans,
            )

        if progress_callback:
            nonzero = [c.raw_fitness for c in population if c.raw_fitness > 0]
            avg_fit = sum(nonzero) / len(nonzero) if nonzero else 0.0
            preview = _build_live_preview(best_ever_chrom) if best_ever_chrom else None
            progress_callback(0, generations, best_raw_fitness, avg_fit, preview)

        # ---- Evolution loop ----
        for gen in range(1, generations + 1):
            population.sort(key=lambda c: c.fitness, reverse=True)

            # Elitism: keep top individuals, preferring diverse signatures
            new_pop: list[FloorPlanChromosome] = []
            seen_sigs: set[Optional[tuple]] = set()
            for c in population:
                if len(new_pop) >= elite_count:
                    break
                if c._plan_sig not in seen_sigs or len(new_pop) < 2:
                    new_pop.append(c.clone())
                    seen_sigs.add(c._plan_sig)

            # Random immigrants for diversity — adaptive: more early, fewer later
            # Early: ~10% of population; Late: ~3% (was fixed 15%)
            progress = gen / generations
            immigrant_frac = 0.10 * (1.0 - progress) + 0.03 * progress
            num_immigrants = max(1, int(pop_size * immigrant_frac))
            for _ in range(num_immigrants):
                new_pop.append(FloorPlanChromosome())

            # Fill rest via crossover + mutation (with generation-aware adaptive rate)
            while len(new_pop) < pop_size:
                parent_a = _tournament_select(population)
                parent_b = _tournament_select(population)
                child = _crossover(parent_a, parent_b)
                child = _mutate(child, rate=mutation_rate,
                                generation=gen, total_generations=generations)
                new_pop.append(child)

            # Evaluate new individuals
            best_raw_fitness = 0.0
            for chrom in new_pop:
                if chrom._plan_sig is not None and chrom.raw_fitness > 0:
                    # Already evaluated elite — keep raw fitness
                    best_raw_fitness = max(best_raw_fitness, chrom.raw_fitness)
                    chrom.fitness = chrom.raw_fitness
                    continue
                plans = generate_variant(request, chrom)
                if plans:
                    raw_fitness, breakdown = _evaluate_floor_plan(plans, request, weights)
                    chrom.raw_fitness = raw_fitness
                    chrom.fitness = raw_fitness
                    chrom.fitness_breakdown = breakdown
                    chrom._plan_sig = _plan_signature(plans)
                    if raw_fitness > best_raw_fitness:
                        best_raw_fitness = raw_fitness
                else:
                    chrom.fitness = 0.0
                    chrom.raw_fitness = 0.0

            # Track overall best chromosome
            for chrom in new_pop:
                if chrom.raw_fitness > (best_ever_chrom.raw_fitness if best_ever_chrom else 0):
                    best_ever_chrom = chrom.clone()

            _apply_fitness_sharing(new_pop)
            population = new_pop

            if progress_callback:
                nonzero = [c.raw_fitness for c in population if c.raw_fitness > 0]
                avg_fit = sum(nonzero) / len(nonzero) if nonzero else 0.0
                # Send live preview every 10 generations (expensive to rebuild)
                preview = None
                if gen % 10 == 0 or gen == generations:
                    preview = _build_live_preview(best_ever_chrom) if best_ever_chrom else None
                progress_callback(gen, generations, best_raw_fitness, avg_fit, preview)

        # ---- Extract top diverse variants ----
        # Re-evaluate with raw fitness for final ranking
        for chrom in population:
            plans = generate_variant(request, chrom)
            if plans:
                raw_fitness, breakdown = _evaluate_floor_plan(plans, request, weights)
                chrom.raw_fitness = raw_fitness
                chrom.fitness = raw_fitness
                chrom.fitness_breakdown = breakdown
                chrom._plan_sig = _plan_signature(plans)

        population.sort(key=lambda c: c.raw_fitness, reverse=True)

        variants: list[FloorPlanVariant] = []
        seen_signatures: set[tuple] = set()
        for chrom in population:
            if chrom.raw_fitness <= 0 or chrom._plan_sig is None:
                continue

            if chrom._plan_sig in seen_signatures:
                continue
            seen_signatures.add(chrom._plan_sig)

            plans = generate_variant(request, chrom)
            if not plans:
                continue

            _, breakdown = _evaluate_floor_plan(plans, request, weights)

            variants.append(FloorPlanVariant(
                rank=len(variants) + 1,
                fitness_score=round(chrom.raw_fitness, 2),
                fitness_breakdown={k: round(v, 2) for k, v in breakdown.items()},
                building_floor_plans=plans,
            ))

            if len(variants) >= top_k:
                break

        # Fallback: at least one variant
        if not variants:
            system = get_system(request.construction_system)
            try:
                plans = system.generate_floor_plans(request)
                _, breakdown = _evaluate_floor_plan(plans, request, weights)
                variants.append(FloorPlanVariant(
                    rank=1,
                    fitness_score=50.0,
                    fitness_breakdown={k: round(v, 2) for k, v in breakdown.items()},
                    building_floor_plans=plans,
                ))
            except Exception:
                pass

        return variants
