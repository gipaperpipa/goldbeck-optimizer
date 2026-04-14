"""
Goldbeck Wohngebäude floor plan generator.
Deterministic, rule-based layout engine implementing the Goldbeck
precast concrete modular construction system (Produktleitfaden Mai 2024).

Generates internal floor plans with structural grid, apartments, rooms,
walls, doors, and windows from a BuildingFootprint.

Supports variation_params for optimizer-driven layout diversity:
  bay_strategy: "greedy_large" | "greedy_small" | "balanced" | "alternating"
  allocation_order: "large_first" | "small_first" | "mixed"
  room_proportions: list[float] — per-apartment bedroom/living width ratios
  service_layout_order: "hall_bath_kitchen" | "kitchen_bath_hall" | "hall_kitchen_bath"
  staircase_count_delta: int (-1, 0, +1)
  staircase_position_offset: float (-0.5 to 0.5)
"""

import math
import uuid
import logging
from typing import Optional

logger = logging.getLogger(__name__)

from app.models.floorplan import (
    AccessType, ApartmentType, BathroomType, StaircaseType,
    WallType, RoomType, FloorType, FloorConfig,
    Point2D, WallSegment, DoorPlacement, WindowPlacement,
    Room, BathroomUnit, Apartment, StaircaseUnit,
    StructuralGrid, FloorPlan, BuildingFloorPlans,
    FloorPlanRequest,
)
from app.services.floorplan.base import ConstructionSystem
from app.services.floorplan import goldbeck_constants as C


def _uid() -> str:
    return str(uuid.uuid4())[:8]


def _snap_to_grid(value: float, grid: float = C.GRID_UNIT) -> float:
    """Snap a value to the nearest multiple of the grid unit."""
    return round(value / grid) * grid


def _rect_polygon(x: float, y: float, w: float, h: float) -> list[Point2D]:
    """Create a rectangular polygon from bottom-left corner."""
    return [
        Point2D(x=x, y=y),
        Point2D(x=x + w, y=y),
        Point2D(x=x + w, y=y + h),
        Point2D(x=x, y=y + h),
    ]


def _rect_area(w: float, h: float) -> float:
    return round(w * h, 2)


def _pick_best_raster(target_width: float) -> float:
    """Pick the standard raster closest to target_width."""
    best = min(C.STANDARD_RASTERS, key=lambda r: abs(r - target_width))
    return best


class GoldbeckGenerator(ConstructionSystem):
    """Goldbeck Wohngebäude construction system floor plan generator."""

    @property
    def system_name(self) -> str:
        return "goldbeck"

    def validate_building(self, width_m: float, depth_m: float, stories: int) -> list[str]:
        """Check if a building can be realized with the Goldbeck system."""
        warnings = []
        w_m = width_m
        d_m = depth_m
        long_side = max(w_m, d_m)
        short_side = min(w_m, d_m)

        if short_side < 5.0:
            warnings.append(f"Building depth {short_side:.1f}m is very narrow for Goldbeck system (min ~6m recommended)")
        if long_side < 6.25:
            warnings.append(f"Building length {long_side:.1f}m is too short (min 2 bays = 6.25m)")
        if stories > C.MAX_STORIES:
            warnings.append(f"{stories} stories exceeds Goldbeck max of {C.MAX_STORIES}")
        if long_side > 80:
            warnings.append(f"Building length {long_side:.1f}m is very long; multiple fire sections needed")
        return warnings

    def generate_floor_plans(
        self,
        request: FloorPlanRequest,
        variation_params: Optional[dict] = None,
    ) -> BuildingFloorPlans:
        """Generate complete floor plans for a building via the 7-phase pipeline.

        Phases 1-4 (structural) are shared across all regular floors to ensure
        Schottwand continuity (bearing walls, staircases, TGA shafts stack
        vertically).  Phases 5-7 (apartment allocation, rooms, elements) run
        independently per floor when ``enable_per_floor`` is True, giving each
        story its own unit mix, room proportions, and door placement.

        Ground floor (index 0) forces barrier-free units and exterior entrance
        doors.  Staffelgeschoss gets its own reduced structural grid.

        Args:
            request: Building dimensions, stories, unit mix, and overrides.
            variation_params: Optimizer knobs — bay strategy, allocation order,
                room proportions, staircase tweaks, etc.  Per-floor overrides
                via ``floor_variation_params`` dict keyed by floor index.

        Returns:
            BuildingFloorPlans with one FloorPlan per storey, plus summary.
        """
        vp = variation_params or {}
        bay_strategy = vp.get("bay_strategy", "greedy_large")
        raster_preferences = vp.get("raster_preferences", None)
        allocation_order = vp.get("allocation_order", "large_first")
        room_proportions = vp.get("room_proportions", None)
        service_layout_order = vp.get("service_layout_order", "hall_bath_kitchen")
        staircase_count_delta = vp.get("staircase_count_delta", 0)
        staircase_position_offset = vp.get("staircase_position_offset", 0.0)
        depth_config_index = vp.get("depth_config_index", -1)
        distribution_arm_depth = float(vp.get("distribution_arm_depth", 1.10))

        # Per-floor variation overrides from optimizer chromosome
        floor_vp: dict[int, dict] = vp.get("floor_variation_params", {})

        # Build FloorConfig lookup from request (or defaults)
        floor_configs: dict[int, FloorConfig] = {}
        if request.floor_configs:
            for fc in request.floor_configs:
                floor_configs[fc.floor_index] = fc

        # ── Shared structural phases (1-4) ─────────────────────

        # Phase 1: Convert and snap to grid
        dims = self._phase1_snap_to_grid(request)

        # Phase 2: Select access type
        access_type = self._phase2_select_access(dims, request.access_type_override)

        # Phase 3: Build structural grid
        grid = self._phase3_build_grid(
            dims, access_type, request.story_height_m,
            bay_strategy, raster_preferences, depth_config_index,
        )

        # Phase 4: Place staircases (shared — must stack vertically)
        staircases = self._phase4_place_staircases(
            grid, access_type, staircase_count_delta, staircase_position_offset
        )

        # ── Determine floor count and types ────────────────────

        num_regular = request.stories
        staffelgeschoss_enabled = getattr(request, "enable_staffelgeschoss", False)
        staffelgeschoss_setback = getattr(request, "staffelgeschoss_setback_m", 2.0)
        has_staffel = staffelgeschoss_enabled and request.stories >= 2

        if has_staffel:
            num_regular = request.stories - 1  # last story is Staffelgeschoss

        enable_per_floor = getattr(request, "enable_per_floor", True)
        gross_area = dims["length_m"] * dims["depth_m"]

        # ── Per-floor independent generation (phases 5-7) ──────

        floor_plans: list[FloorPlan] = []
        full_summary: dict[str, int] = {}
        total_apts = 0

        # Generate a single reference layout for cloning when per-floor is off
        ref_floor = None

        for floor_idx in range(num_regular):
            is_ground = (floor_idx == 0)
            floor_type = FloorType.GROUND if is_ground else FloorType.STANDARD

            # Resolve per-floor config
            fc = floor_configs.get(floor_idx)

            # Determine per-floor variation params
            fvp_alloc = allocation_order
            fvp_props = room_proportions
            fvp_service = service_layout_order
            fvp_barrier_free = request.prefer_barrier_free

            if fc:
                if fc.allocation_order_override:
                    fvp_alloc = fc.allocation_order_override
                if fc.force_barrier_free:
                    fvp_barrier_free = True

            # Ground floor: force barrier-free (BauO NRW §50)
            if is_ground and getattr(request, "ground_floor_barrier_free", True):
                fvp_barrier_free = True

            # Per-floor optimizer overrides (from chromosome)
            f_overrides = floor_vp.get(floor_idx, {})
            if f_overrides.get("allocation_order"):
                fvp_alloc = f_overrides["allocation_order"]
            if f_overrides.get("room_proportions"):
                fvp_props = f_overrides["room_proportions"]
            if f_overrides.get("service_layout_order"):
                fvp_service = f_overrides["service_layout_order"]

            # Decide: independent generation or clone reference
            if enable_per_floor or ref_floor is None:
                # Phase 5: Allocate apartments to bays
                allocations = self._phase5_allocate_apartments(
                    grid, staircases, request, access_type, fvp_alloc
                )

                # Phase 6: Generate room layouts
                apartments, all_rooms = self._phase6_generate_rooms(
                    allocations, grid, access_type, fvp_barrier_free,
                    fvp_props, fvp_service,
                    rotation_deg=request.rotation_deg,
                    distribution_arm_depth=distribution_arm_depth,
                )

                # Phase 7: Generate walls, doors, windows
                walls, doors, windows, corridor_rooms = self._phase7_generate_elements(
                    grid, apartments, staircases, access_type
                )
                all_rooms.extend(corridor_rooms)

                # Ground floor: replace entrance doors with exterior access
                if is_ground:
                    gf_doors = self._generate_ground_floor_doors(
                        apartments, grid, access_type
                    )
                    non_entrance_doors = [d for d in doors if not d.is_entrance]
                    doors = non_entrance_doors + gf_doors

                net_area = sum(a.total_area_sqm for a in apartments)

                fp = FloorPlan(
                    floor_index=floor_idx,
                    floor_type=floor_type,
                    structural_grid=grid,
                    walls=walls,
                    doors=doors,
                    windows=windows,
                    apartments=apartments,
                    staircases=staircases,
                    rooms=all_rooms,
                    access_type=access_type,
                    gross_area_sqm=round(gross_area, 2),
                    net_area_sqm=round(net_area, 2),
                    num_apartments=len(apartments),
                )

                if ref_floor is None:
                    ref_floor = fp

                floor_plans.append(fp)
            else:
                # Clone reference floor (per-floor disabled, not ground floor)
                fp = ref_floor.model_copy(deep=True)
                fp.floor_index = floor_idx
                fp.floor_type = floor_type
                floor_plans.append(fp)

            # Accumulate apartment summary
            for apt in floor_plans[-1].apartments:
                key = apt.apartment_type.value
                full_summary[key] = full_summary.get(key, 0) + 1
            total_apts += floor_plans[-1].num_apartments

        # ── Staffelgeschoss: independent reduced top floor ─────

        if has_staffel:
            staffel_fp = self._generate_staffelgeschoss(
                request, dims, access_type, vp,
                staffelgeschoss_setback, num_regular,
            )
            if staffel_fp is not None:
                staffel_fp.floor_type = FloorType.STAFFELGESCHOSS
                floor_plans.append(staffel_fp)
                for apt in staffel_fp.apartments:
                    key = apt.apartment_type.value
                    full_summary[key] = full_summary.get(key, 0) + 1
                total_apts += staffel_fp.num_apartments
            else:
                # Fallback: clone last regular floor
                if ref_floor:
                    fp = ref_floor.model_copy(deep=True)
                    fp.floor_index = num_regular
                    fp.floor_type = FloorType.STANDARD
                    floor_plans.append(fp)
                    for apt in fp.apartments:
                        key = apt.apartment_type.value
                        full_summary[key] = full_summary.get(key, 0) + 1
                    total_apts += fp.num_apartments

        return BuildingFloorPlans(
            building_id=request.building_id,
            construction_system="goldbeck",
            building_width_m=round(dims["length_m"], 3),
            building_depth_m=round(dims["depth_m"], 3),
            num_stories=request.stories,
            story_height_m=request.story_height_m,
            access_type=access_type,
            structural_grid=grid,
            floor_plans=floor_plans,
            total_apartments=total_apts,
            apartment_summary=full_summary,
        )

    # ========================================================
    # Staffelgeschoss: Setback top floor generation
    # ========================================================
    def _generate_staffelgeschoss(
        self,
        request: FloorPlanRequest,
        base_dims: dict,
        base_access_type: AccessType,
        variation_params: dict,
        setback_m: float,
        floor_index: int,
    ) -> Optional[FloorPlan]:
        """Generate a reduced Staffelgeschoss (setback top floor).

        The top floor is set back by `setback_m` on both gable ends (length reduction)
        and optionally on the north facade (depth reduction for Ganghaus).
        The result does NOT count as a Vollgeschoss because its area is
        less than the threshold fraction of the standard floor area.

        The reduced floor plan is centered within the original building footprint
        by offsetting wall/room coordinates so it aligns visually.
        """
        try:
            # Compute reduced dimensions
            length_reduction = setback_m * 2  # setback from both gable ends
            depth_reduction = setback_m       # setback from one long side (typically north)

            reduced_length = base_dims["length_m"] - length_reduction
            reduced_depth = base_dims["depth_m"] - depth_reduction

            # Ensure minimum viable building dimensions
            min_length = C.MIN_BAY_WIDTH * 2 + C.GABLE_END_WALL * 2
            if reduced_length < min_length:
                reduced_length = min_length
            if reduced_depth < C.LAUBENGANG_MIN_DEPTH:
                # Too small for any meaningful floor plan
                return None

            # Create a modified request for the reduced floor
            staffel_request = request.model_copy(deep=True)
            staffel_request.building_width_m = reduced_length
            staffel_request.building_depth_m = reduced_depth
            staffel_request.stories = 1
            staffel_request.building_id = f"{request.building_id}-staffel"

            # Run phases 1-7 for the reduced floor
            staffel_dims = self._phase1_snap_to_grid(staffel_request)
            staffel_access = self._phase2_select_access(staffel_dims, base_access_type)

            vp = variation_params
            staffel_grid = self._phase3_build_grid(
                staffel_dims, staffel_access, request.story_height_m,
                vp.get("bay_strategy", "greedy_large"),
                vp.get("raster_preferences", None),
                vp.get("depth_config_index", -1),
            )
            staffel_stairs = self._phase4_place_staircases(
                staffel_grid, staffel_access,
                vp.get("staircase_count_delta", 0),
                vp.get("staircase_position_offset", 0.0),
            )
            staffel_allocs = self._phase5_allocate_apartments(
                staffel_grid, staffel_stairs, staffel_request, staffel_access,
                vp.get("allocation_order", "large_first"),
            )
            staffel_apts, staffel_rooms = self._phase6_generate_rooms(
                staffel_allocs, staffel_grid, staffel_access,
                request.prefer_barrier_free,
                vp.get("room_proportions", None),
                vp.get("service_layout_order", "hall_bath_kitchen"),
            )
            staffel_walls, staffel_doors, staffel_windows, staffel_corr_rooms = (
                self._phase7_generate_elements(
                    staffel_grid, staffel_apts, staffel_stairs, staffel_access
                )
            )
            staffel_rooms.extend(staffel_corr_rooms)

            # Offset all geometry so the reduced floor is centered in the base footprint
            offset_x = setback_m  # shift right by setback amount (center in base)
            offset_y = 0.0  # north setback: no Y offset needed (keep south-aligned)

            def _offset_point(p: Point2D) -> Point2D:
                return Point2D(x=p.x + offset_x, y=p.y + offset_y)

            # Offset walls
            for w in staffel_walls:
                w.start = _offset_point(w.start)
                w.end = _offset_point(w.end)

            # Offset doors
            for d in staffel_doors:
                d.position = _offset_point(d.position)

            # Offset windows
            for win in staffel_windows:
                win.position = _offset_point(win.position)

            # Offset rooms
            for room in staffel_rooms:
                room.polygon = [_offset_point(p) for p in room.polygon]

            # Offset apartments and their rooms
            for apt in staffel_apts:
                for room in apt.rooms:
                    room.polygon = [_offset_point(p) for p in room.polygon]
                apt.bathroom.position = _offset_point(apt.bathroom.position)

            # Offset staircases
            for sc in staffel_stairs:
                sc.position = _offset_point(sc.position)

            # Update grid to reflect the reduced dimensions but offset origin
            staffel_grid.origin = Point2D(x=offset_x, y=offset_y)
            staffel_grid.axis_positions_x = [ax + offset_x for ax in staffel_grid.axis_positions_x]
            staffel_grid.outer_wall_south_y += offset_y
            staffel_grid.outer_wall_north_y += offset_y
            staffel_grid.corridor_y_start_m += offset_y

            gross_area = staffel_dims["length_m"] * staffel_dims["depth_m"]
            net_area = sum(a.total_area_sqm for a in staffel_apts)

            return FloorPlan(
                floor_index=floor_index,
                structural_grid=staffel_grid,
                walls=staffel_walls,
                doors=staffel_doors,
                windows=staffel_windows,
                apartments=staffel_apts,
                staircases=staffel_stairs,
                rooms=staffel_rooms,
                access_type=staffel_access,
                gross_area_sqm=round(gross_area, 2),
                net_area_sqm=round(net_area, 2),
                num_apartments=len(staffel_apts),
            )

        except Exception as e:
            logger.warning(f"[Staffelgeschoss] Generation failed: {e}", exc_info=True)
            return None

    # ========================================================
    # Phase 1: Grid Snapping
    # ========================================================
    def _phase1_snap_to_grid(self, request: FloorPlanRequest) -> dict:
        """Snap dimensions to Goldbeck grid (dimensions already in meters)."""
        w_m = request.building_width_m
        d_m = request.building_depth_m

        # Long side = building length, short side = building depth
        length_m = max(w_m, d_m)
        depth_m = min(w_m, d_m)
        swapped = (d_m > w_m)

        # Snap to grid
        length_m = max(_snap_to_grid(length_m), C.MIN_BAY_WIDTH * 2 + C.GABLE_END_WALL * 2)
        depth_m = max(_snap_to_grid(depth_m), C.MIN_BAY_WIDTH + C.OUTER_LONG_WALL * 2)

        return {
            "length_m": length_m,
            "depth_m": depth_m,
            "swapped": swapped,
        }

    # ========================================================
    # Phase 2: Access Type Selection
    # ========================================================
    def _phase2_select_access(self, dims: dict, override: Optional[AccessType]) -> AccessType:
        """Select access type based on building depth.

        Ganghaus (≥10m): internal corridor, apartments both sides
        Laubengang (≥6.25m): external gallery, apartments full depth
        Spaenner (<6.25m): direct staircase access, no corridor
        """
        if override:
            return override
        if dims["depth_m"] >= C.GANGHAUS_MIN_DEPTH:
            return AccessType.GANGHAUS
        if dims["depth_m"] >= C.LAUBENGANG_MIN_DEPTH:
            return AccessType.LAUBENGANG
        return AccessType.SPAENNER

    # ========================================================
    # Phase 3: Structural Grid
    # ========================================================
    def _phase3_build_grid(
        self,
        dims: dict,
        access: AccessType,
        story_height: float,
        bay_strategy: str = "greedy_large",
        raster_preferences: list[float] | None = None,
        depth_config_index: int = -1,
    ) -> StructuralGrid:
        """Compute bay widths, axis positions, and depth zones."""
        length_m = dims["length_m"]
        depth_m = dims["depth_m"]

        # --- Depth zones ---
        gallery_side = None

        if access == AccessType.GANGHAUS:
            # Find best depth configuration
            best_config = self._pick_depth_config(depth_m, depth_config_index)
            south_depth = best_config[0]
            north_depth = best_config[1]
            corridor_w = C.CORRIDOR_WIDTH
            actual_depth = (
                C.OUTER_LONG_WALL + south_depth +
                C.CORRIDOR_WALL + corridor_w + C.CORRIDOR_WALL +
                north_depth + C.OUTER_LONG_WALL
            )
        elif access == AccessType.LAUBENGANG:
            # External gallery: apartments span full depth, gallery is outside
            inner_depth = depth_m - 2 * C.OUTER_LONG_WALL
            south_depth = _pick_best_raster(inner_depth)
            north_depth = 0.0
            corridor_w = 0.0  # Gallery is external, not counted in building depth
            actual_depth = C.OUTER_LONG_WALL + south_depth + C.OUTER_LONG_WALL
            gallery_side = C.GALLERY_SIDE  # Default: gallery on north side
        else:
            inner_depth = depth_m - 2 * C.OUTER_LONG_WALL
            south_depth = _pick_best_raster(inner_depth)
            north_depth = 0.0
            corridor_w = 0.0
            actual_depth = C.OUTER_LONG_WALL + south_depth + C.OUTER_LONG_WALL

        # Update dimensions
        dims["depth_m"] = actual_depth

        # --- Bay widths along length ---
        interior_length = length_m - 2 * C.GABLE_END_WALL
        if raster_preferences:
            bay_widths = self._compute_bay_widths_custom(interior_length, raster_preferences)
        else:
            bay_widths = self._compute_bay_widths(interior_length, bay_strategy)

        # Actual building length
        actual_length = (
            C.GABLE_END_WALL +
            sum(bay_widths) +
            C.BEARING_CROSS_WALL * (len(bay_widths) - 1) +
            C.GABLE_END_WALL
        )
        dims["length_m"] = actual_length

        # --- Axis positions (x coordinates of cross-wall centers) ---
        axis_x = [C.GABLE_END_WALL / 2]  # first gable wall center
        x = C.GABLE_END_WALL  # inner face of first gable
        for i, bw in enumerate(bay_widths):
            x += bw
            if i < len(bay_widths) - 1:
                axis_x.append(x + C.BEARING_CROSS_WALL / 2)
                x += C.BEARING_CROSS_WALL
            else:
                axis_x.append(actual_length - C.GABLE_END_WALL / 2)

        # --- Y positions ---
        y_south_outer = 0.0
        y_south_inner = C.OUTER_LONG_WALL

        if access == AccessType.GANGHAUS:
            corridor_y_start = y_south_inner + south_depth
            corridor_y_end = corridor_y_start + C.CORRIDOR_WALL + corridor_w + C.CORRIDOR_WALL
            y_north_inner = corridor_y_end + north_depth
        else:
            corridor_y_start = 0.0
            corridor_y_end = 0.0
            y_north_inner = y_south_inner + south_depth

        y_north_outer = y_north_inner + C.OUTER_LONG_WALL

        return StructuralGrid(
            bay_widths=bay_widths,
            building_depth_m=round(actual_depth, 3),
            building_length_m=round(actual_length, 3),
            south_zone_depth_m=south_depth,
            north_zone_depth_m=north_depth,
            corridor_width_m=corridor_w,
            corridor_y_start_m=round(corridor_y_start, 3),
            story_height_m=story_height,
            axis_positions_x=[round(a, 3) for a in axis_x],
            outer_wall_south_y=y_south_outer,
            outer_wall_north_y=round(y_north_outer, 3),
            gallery_side=gallery_side,
        )

    def _pick_depth_config(
        self, target_depth: float, config_index: int = -1,
    ) -> tuple[float, float]:
        """Pick a Ganghaus depth configuration.

        config_index = -1 (default): pick closest to target_depth.
        config_index >= 0: pick the N-th closest config (allows diversity).
        """
        scored = []
        for south, north in C.GANGHAUS_DEPTH_CONFIGS:
            total = (
                C.OUTER_LONG_WALL + south +
                C.CORRIDOR_WALL + C.CORRIDOR_WIDTH + C.CORRIDOR_WALL +
                north + C.OUTER_LONG_WALL
            )
            diff = abs(total - target_depth)
            scored.append((diff, south, north))
        scored.sort(key=lambda x: x[0])

        if config_index >= 0 and config_index < len(scored):
            # Pick the N-th closest (allows optimizer to explore alternatives)
            _, south, north = scored[config_index]
        else:
            # Default: pick closest
            _, south, north = scored[0] if scored else (0, 6.25, 6.25)
        return (south, north)

    def _compute_bay_widths(
        self,
        interior_length: float,
        strategy: str = "greedy_large",
    ) -> list[float]:
        """Compute sequence of bay widths that fill the interior length.

        Strategies:
          greedy_large: fill with largest rasters first (default)
          greedy_small: fill with smallest rasters first (more bays)
          balanced: use median-width rasters for uniformity
          alternating: alternate between large and small rasters
        """
        bays: list[float] = []
        remaining = interior_length

        if strategy == "greedy_small":
            raster_order = sorted(C.STANDARD_RASTERS)
        elif strategy == "balanced":
            # Prefer the median raster (5.00m)
            median = 5.00
            raster_order = sorted(C.STANDARD_RASTERS, key=lambda r: abs(r - median))
        elif strategy == "alternating":
            return self._compute_bay_widths_alternating(interior_length)
        else:
            # greedy_large (default)
            raster_order = sorted(C.STANDARD_RASTERS, reverse=True)

        while remaining > C.GRID_UNIT:
            candidates = [r for r in raster_order if r <= remaining + 0.01]
            if not candidates:
                if bays:
                    bays[-1] = _snap_to_grid(bays[-1] + remaining)
                break

            bay_w = candidates[0]
            bays.append(bay_w)
            remaining -= bay_w

            if remaining > C.MIN_BAY_WIDTH:
                remaining -= C.BEARING_CROSS_WALL

        if not bays:
            bays = [C.MIN_BAY_WIDTH]

        return bays

    def _compute_bay_widths_alternating(self, interior_length: float) -> list[float]:
        """Alternating pattern: large, small, large, small..."""
        large_rasters = [6.25, 5.625]
        small_rasters = [3.125, 3.75]
        bays: list[float] = []
        remaining = interior_length
        use_large = True

        while remaining > C.GRID_UNIT:
            pool = large_rasters if use_large else small_rasters
            candidates = [r for r in pool if r <= remaining + 0.01]
            if not candidates:
                # Fall back to any raster that fits
                candidates = [r for r in sorted(C.STANDARD_RASTERS, reverse=True) if r <= remaining + 0.01]
            if not candidates:
                if bays:
                    bays[-1] = _snap_to_grid(bays[-1] + remaining)
                break

            bay_w = candidates[0]
            bays.append(bay_w)
            remaining -= bay_w
            use_large = not use_large

            if remaining > C.MIN_BAY_WIDTH:
                remaining -= C.BEARING_CROSS_WALL

        if not bays:
            bays = [C.MIN_BAY_WIDTH]

        return bays

    def _compute_bay_widths_custom(
        self,
        interior_length: float,
        raster_preferences: list[float],
    ) -> list[float]:
        """Compute bay widths using per-bay raster preferences.

        Each preference (0.0-1.0) selects from valid rasters for that position:
          0.0 = smallest raster, 1.0 = largest raster.
        This creates hundreds of unique combinations instead of 4 named strategies.
        """
        sorted_rasters = sorted(C.STANDARD_RASTERS)  # [3.125, 3.75, 4.375, 5.0, 5.625, 6.25]
        bays: list[float] = []
        remaining = interior_length
        pref_idx = 0

        while remaining > C.GRID_UNIT:
            # Filter rasters that fit in remaining space
            candidates = [r for r in sorted_rasters if r <= remaining + 0.01]
            if not candidates:
                if bays:
                    bays[-1] = _snap_to_grid(bays[-1] + remaining)
                break

            # Get preference for this bay position
            if pref_idx < len(raster_preferences):
                pref = max(0.0, min(1.0, raster_preferences[pref_idx]))
                pref_idx += 1
            else:
                pref = 0.5  # default to median

            # Map preference to candidate index
            idx = min(len(candidates) - 1, int(pref * len(candidates)))
            bay_w = candidates[idx]
            bays.append(bay_w)
            remaining -= bay_w

            if remaining > C.MIN_BAY_WIDTH:
                remaining -= C.BEARING_CROSS_WALL

        if not bays:
            bays = [C.MIN_BAY_WIDTH]

        return bays

    # ========================================================
    # Phase 4: Staircase Placement
    # ========================================================
    def _phase4_place_staircases(
        self,
        grid: StructuralGrid,
        access: AccessType,
        count_delta: int = 0,
        position_offset: float = 0.0,
    ) -> list[StaircaseUnit]:
        """Place staircases at evenly spaced positions."""
        num_bays = len(grid.bay_widths)
        building_length = grid.building_length_m

        # Number of staircases needed
        num_stairs = max(1, round(building_length / C.PRACTICAL_STAIRCASE_SPACING))
        num_stairs = num_stairs + count_delta
        num_stairs = max(1, min(num_stairs, num_bays // 2))

        # Select staircase type
        if access == AccessType.GANGHAUS:
            stair_type = StaircaseType.TYPE_I
            needed_raster = 6.25
        elif access == AccessType.LAUBENGANG:
            # Laubengang: staircases connect to external gallery, smaller type
            stair_type = StaircaseType.TYPE_II
            needed_raster = 3.125
        else:
            stair_type = StaircaseType.TYPE_III
            needed_raster = 3.125

        # Pick bay indices for staircases
        if num_stairs == 1:
            # Center bay with position offset
            center = num_bays / 2 + position_offset * num_bays / 4
            candidates = [(i, abs(i - center)) for i in range(num_bays)]
            candidates.sort(key=lambda c: c[1])
            stair_indices = []
            for idx, _ in candidates:
                if grid.bay_widths[idx] >= needed_raster - 0.01:
                    stair_indices.append(idx)
                    break
            if not stair_indices:
                stair_indices = [num_bays // 2]
        else:
            spacing = num_bays / (num_stairs + 1)
            stair_indices = []
            for s in range(num_stairs):
                target_idx = int(spacing * (s + 1) + position_offset * spacing)
                target_idx = max(0, min(target_idx, num_bays - 1))
                stair_indices.append(target_idx)

        # Create staircase units
        staircases = []
        for idx in stair_indices:
            if idx == 0:
                x_start = 0.0
            else:
                x_start = grid.axis_positions_x[idx] + C.BEARING_CROSS_WALL / 2

            stair_width = grid.bay_widths[idx]

            staircases.append(StaircaseUnit(
                id=f"stair_{_uid()}",
                staircase_type=stair_type,
                position=Point2D(x=round(x_start, 3), y=0.0),
                width_m=round(stair_width, 3),
                depth_m=grid.building_depth_m,
                has_elevator=(stair_type == StaircaseType.TYPE_I),
                bay_index=idx,
            ))

        return staircases

    # ========================================================
    # Phase 5: Apartment Allocation
    # ========================================================
    def _phase5_allocate_apartments(
        self,
        grid: StructuralGrid,
        staircases: list[StaircaseUnit],
        request: FloorPlanRequest,
        access: AccessType,
        allocation_order: str = "large_first",
    ) -> list[dict]:
        """Map unit_mix to physical bay groupings.

        Solar bias (Phase 2.1): in Ganghaus, when total unit counts split
        unevenly across the two sides, the "extra" of each apartment type
        is placed on the side that compass-faces south (after rotation_deg).
        Larger apartment types (3_room, 4_room) benefit most from south sun
        because their living rooms are bigger.
        """
        stair_bay_indices = {s.bay_index for s in staircases}
        available_bays = [i for i in range(len(grid.bay_widths)) if i not in stair_bay_indices]

        # Parse unit mix from request
        unit_counts = self._parse_unit_mix(request, len(available_bays), access)

        # Build allocation list
        allocations = []

        if access == AccessType.GANGHAUS:
            # Determine which labeled side compass-faces south after rotation.
            # Default: "south" label = bearing 180° = compass south.
            # rotation_deg rotates clockwise, so when rotation ∈ (90, 270),
            # the labeled-south facade actually points compass-north.
            rot_norm = request.rotation_deg % 360
            preferred_side = "south" if not (90.0 < rot_norm < 270.0) else "north"

            # Split unit counts: floor(v/2) goes to each side, the extra
            # (v % 2) goes to the solar-preferred side.
            south_counts: dict[str, int] = {}
            north_counts: dict[str, int] = {}
            for k, v in unit_counts.items():
                base = v // 2
                extra = v % 2
                south_counts[k] = base + (extra if preferred_side == "south" else 0)
                north_counts[k] = base + (extra if preferred_side == "north" else 0)

            for side, side_counts in [("south", south_counts), ("north", north_counts)]:
                side_allocs = self._allocate_side(
                    available_bays, grid.bay_widths, side_counts, side, allocation_order
                )
                allocations.extend(side_allocs)
        elif access == AccessType.LAUBENGANG:
            # Laubengang: apartments span full depth, allocated on single side
            # Gallery side determines which wall has entrance doors
            allocs = self._allocate_side(
                available_bays, grid.bay_widths, unit_counts, "single", allocation_order
            )
            allocations.extend(allocs)
        else:
            allocs = self._allocate_side(
                available_bays, grid.bay_widths, unit_counts, "single", allocation_order
            )
            allocations.extend(allocs)

        return allocations

    def _parse_unit_mix(self, request: FloorPlanRequest, num_available_bays: int, access: AccessType) -> dict[str, int]:
        """Parse unit mix from request into per-floor apartment counts."""
        counts: dict[str, int] = {}

        if request.unit_mix and "entries" in request.unit_mix:
            for entry in request.unit_mix["entries"]:
                unit_type = entry.get("unit_type", "studio")
                total_count = entry.get("count", 0)
                apt_type = C.UNIT_TYPE_TO_APARTMENT.get(unit_type)
                if apt_type and total_count > 0:
                    per_floor = max(1, math.ceil(total_count / max(1, request.stories)))
                    counts[apt_type] = counts.get(apt_type, 0) + per_floor

        # If no valid unit mix, auto-generate based on available bays
        if not counts:
            sides = 2 if access == AccessType.GANGHAUS else 1
            total_apt_slots = num_available_bays * sides
            counts["2_room"] = total_apt_slots // 2
            counts["3_room"] = total_apt_slots - counts["2_room"]

        return counts

    def _allocate_side(
        self,
        available_bays: list[int],
        bay_widths: list[float],
        target_counts: dict[str, int],
        side: str,
        allocation_order: str = "large_first",
    ) -> list[dict]:
        """Allocate apartments to contiguous bay groups on one side."""
        segments: list[list[int]] = []
        current_seg: list[int] = []
        for i, bay_idx in enumerate(available_bays):
            if current_seg and bay_idx != current_seg[-1] + 1:
                segments.append(current_seg)
                current_seg = []
            current_seg.append(bay_idx)
        if current_seg:
            segments.append(current_seg)

        allocations = []
        remaining_counts = dict(target_counts)

        # Sort apartment types based on allocation order
        if allocation_order == "small_first":
            sorted_types = sorted(
                remaining_counts.keys(),
                key=lambda t: C.APARTMENT_BAY_SPECS.get(t, {}).get("bay_count", 1),
            )
        elif allocation_order == "mixed":
            # Interleave: sort by bay count, then take alternating from each end
            by_size = sorted(
                remaining_counts.keys(),
                key=lambda t: C.APARTMENT_BAY_SPECS.get(t, {}).get("bay_count", 1),
            )
            sorted_types = []
            left, right = 0, len(by_size) - 1
            toggle = True
            while left <= right:
                if toggle:
                    sorted_types.append(by_size[right])
                    right -= 1
                else:
                    sorted_types.append(by_size[left])
                    left += 1
                toggle = not toggle
        else:
            # large_first (default)
            sorted_types = sorted(
                remaining_counts.keys(),
                key=lambda t: C.APARTMENT_BAY_SPECS.get(t, {}).get("bay_count", 1),
                reverse=True,
            )

        for seg in segments:
            cursor = 0
            for apt_type in sorted_types:
                spec = C.APARTMENT_BAY_SPECS.get(apt_type)
                if not spec:
                    continue
                needed = spec["bay_count"]
                min_width = spec.get("min_total_width", 0.0)
                count = remaining_counts.get(apt_type, 0)

                placed = 0
                while placed < count and cursor + needed <= len(seg):
                    assigned = seg[cursor:cursor + needed]
                    total_width = sum(bay_widths[i] for i in assigned)

                    # Check if bays are wide enough for this apartment type
                    if total_width < min_width * 0.95:
                        # Bays too narrow — skip, let them be filled as smaller units
                        break

                    allocations.append({
                        "apartment_type": apt_type,
                        "bay_indices": assigned,
                        "total_width": total_width,
                        "side": side,
                    })
                    cursor += needed
                    placed += 1

                remaining_counts[apt_type] = count - placed

            # Fill remaining bays — assign type based on actual width
            while cursor < len(seg):
                idx = seg[cursor]
                w = bay_widths[idx]
                # Determine best apartment type for this bay width
                if w >= 6.25 * 0.95:
                    fill_type = "2_room"
                else:
                    fill_type = "1_room"
                allocations.append({
                    "apartment_type": fill_type,
                    "bay_indices": [idx],
                    "total_width": w,
                    "side": side,
                })
                cursor += 1

        return allocations

    # ========================================================
    # Phase 6: Room Layouts
    # ========================================================
    def _phase6_generate_rooms(
        self,
        allocations: list[dict],
        grid: StructuralGrid,
        access: AccessType,
        prefer_barrier_free: bool,
        room_proportions: Optional[list[float]] = None,
        service_layout_order: str = "hall_bath_kitchen",
        rotation_deg: float = 0.0,  # noqa: ARG002 — reserved for future per-room solar logic
        distribution_arm_depth: float = 1.10,
    ) -> tuple[list[Apartment], list[Room]]:
        """Generate room layouts for each apartment allocation.

        Solar orientation: handled by the optimizer's `orientation` fitness
        criterion (`quality_scoring.score_orientation`), which uses
        `request.rotation_deg` to compute compass bearings for each room's
        facade. Since LIVING and BEDROOM rooms in a Goldbeck apartment share
        the same exterior facade, the bearing is determined by the apartment's
        side relative to the corridor — Phase 6 itself has no per-room choice
        to make. Solar bias is therefore applied at allocation time (Phase 5)
        by preferring living-heavy apartment types on the better-oriented side.
        """
        apartments = []
        all_rooms = []
        apt_counter = {"south": 0, "north": 0, "single": 0}
        proportion_idx = 0

        for alloc in allocations:
            side = alloc["side"]
            apt_counter[side] += 1
            prefix = {"south": "A", "north": "B", "single": "A"}[side]
            unit_num = f"{prefix}{apt_counter[side]:02d}"

            apt_type_str = alloc["apartment_type"]
            apt_type = ApartmentType(apt_type_str)
            bay_indices = alloc["bay_indices"]

            # Compute apartment bounding box
            bbox = self._compute_apt_bbox(bay_indices, grid, side, access)

            # Select bathroom type
            spec = C.APARTMENT_BAY_SPECS.get(apt_type_str, {})
            primary_bath = spec.get("primary_bathroom", "type_i")
            if not prefer_barrier_free and primary_bath != "type_iii":
                primary_bath = "type_iv"

            bath_dims = C.BATHROOM_DIMENSIONS[primary_bath]

            # Get room proportion for this apartment
            apt_proportion = None
            if room_proportions and proportion_idx < len(room_proportions):
                apt_proportion = room_proportions[proportion_idx]
                proportion_idx += 1

            # Generate rooms for this apartment
            rooms, bathroom, entrance_door_id = self._layout_apartment_rooms(
                apt_type_str, bbox, bath_dims, primary_bath, unit_num, grid, side,
                apt_proportion, service_layout_order,
                distribution_arm_depth=distribution_arm_depth,
            )

            total_area = sum(r.area_sqm for r in rooms if r.room_type != RoomType.BALCONY)

            bath_room = next((r for r in rooms if r.room_type == RoomType.BATHROOM), None)
            bath_pos_x = bath_room.polygon[0].x if bath_room else bbox["x_start"]
            bath_pos_y = bath_room.polygon[0].y if bath_room else bbox["y_start"]

            apt = Apartment(
                id=f"apt_{_uid()}",
                apartment_type=apt_type,
                unit_number=unit_num,
                side=side,
                rooms=rooms,
                bathroom=BathroomUnit(
                    id=f"bath_{_uid()}",
                    bathroom_type=BathroomType(primary_bath),
                    position=Point2D(x=bath_pos_x, y=bath_pos_y),
                    width_m=bath_dims["width"],
                    depth_m=bath_dims["depth"],
                    area_sqm=bath_dims["area"],
                ),
                total_area_sqm=round(total_area, 2),
                bay_indices=bay_indices,
                entrance_door_id=entrance_door_id,
                has_balcony=True,
            )
            apartments.append(apt)
            all_rooms.extend(rooms)

        return apartments, all_rooms

    def _compute_apt_bbox(self, bay_indices: list[int], grid: StructuralGrid, side: str, access: AccessType) -> dict:
        """Compute apartment bounding box from bay indices."""
        axes = grid.axis_positions_x

        first_bay = bay_indices[0]
        last_bay = bay_indices[-1]

        x_start = axes[first_bay] + C.BEARING_WALL_HALF if first_bay > 0 else C.GABLE_END_WALL
        x_end = axes[last_bay + 1] - C.BEARING_WALL_HALF if last_bay < len(grid.bay_widths) - 1 else grid.building_length_m - C.GABLE_END_WALL

        if access == AccessType.GANGHAUS:
            if side == "south":
                y_start = C.OUTER_LONG_WALL
                y_end = grid.corridor_y_start_m
            else:
                y_start = grid.corridor_y_start_m + C.CORRIDOR_WALL + grid.corridor_width_m + C.CORRIDOR_WALL
                y_end = grid.outer_wall_north_y - C.OUTER_LONG_WALL
        else:
            y_start = C.OUTER_LONG_WALL
            y_end = grid.outer_wall_north_y - C.OUTER_LONG_WALL

        return {
            "x_start": round(x_start, 3),
            "x_end": round(x_end, 3),
            "y_start": round(y_start, 3),
            "y_end": round(y_end, 3),
            "width": round(x_end - x_start, 3),
            "depth": round(y_end - y_start, 3),
            "side": side,
        }

    def _layout_apartment_rooms(
        self,
        apt_type: str,
        bbox: dict,
        bath_dims: dict,
        bath_type: str,
        unit_num: str,
        grid: StructuralGrid,
        side: str,
        room_proportion: Optional[float] = None,
        service_layout_order: str = "hall_bath_kitchen",
        distribution_arm_depth: float = 1.10,
    ) -> tuple[list[Room], dict, str]:
        """
        Generate room subdivisions for one apartment.

        Layout strategy (Goldbeck):
        - SERVICE STRIP near corridor: hallway, bathroom, TGA shaft (kitchen moved to living room)
        - DISTRIBUTION ARM: for 3+ room apartments, a narrow hallway extension spans
          the full apartment width at the service/room boundary, ensuring every room
          is reachable from the hallway without walking through another room.
        - ROOM ZONE near exterior: bedrooms and WOHNKÜCHE (combined living+kitchen)
        - BALCONY on exterior side with standard Goldbeck dimensions
        """
        rooms = []
        apt_id = f"apt_{unit_num}"
        x0 = bbox["x_start"]
        x1 = bbox["x_end"]
        apt_w = bbox["width"]
        apt_d = bbox["depth"]

        bath_w = bath_dims["width"]
        bath_d = bath_dims["depth"]

        entrance_door_id = f"door_{_uid()}"

        # Service strip depth
        hallway_d = 1.20
        service_d = max(bath_d, hallway_d + 0.5)

        # For 3+ room apartments, reserve space for a distribution arm that
        # spans the full apartment width. This narrow corridor connects the
        # hallway to all rooms — the standard German Flur layout.
        num_rooms = {"1_room": 1, "2_room": 2, "3_room": 3, "4_room": 4, "5_room": 5}
        needs_distribution_arm = num_rooms.get(apt_type, 1) >= 3
        # Phase 2.4: chromosome-controlled hallway depth (1.10m–1.50m). Clamp to range.
        arm_d = max(1.10, min(1.50, distribution_arm_depth))
        dist_arm_d = arm_d if needs_distribution_arm else 0.0  # min barrier-free passage

        room_d = apt_d - service_d - dist_arm_d
        room_d = max(room_d, 2.0)

        # --- Determine Y zones based on side ---
        # Layout from corridor to exterior: service strip → distribution arm → rooms → balcony
        # Balcony is placed OUTSIDE the building envelope, adjacent to the room zone
        if side == "south":
            service_y = bbox["y_end"] - service_d
            dist_arm_y = service_y - dist_arm_d
            room_y = bbox["y_start"]
            balcony_y = bbox["y_start"] - C.BALCONY_STANDARD_DEPTH
        elif side == "north":
            service_y = bbox["y_start"]
            dist_arm_y = bbox["y_start"] + service_d
            room_y = bbox["y_start"] + service_d + dist_arm_d
            balcony_y = bbox["y_end"]  # Adjacent to building edge, extends outward
        else:  # Spaenner/single-side
            service_y = bbox["y_end"] - service_d
            dist_arm_y = service_y - dist_arm_d
            room_y = bbox["y_start"]
            balcony_y = bbox["y_start"] - C.BALCONY_STANDARD_DEPTH

        # === SERVICE STRIP: Only hallway + shaft + bathroom (NO kitchen) ===
        # Kitchen is now part of the living room (Wohnküche)
        bath_w = bath_dims["width"]

        # Recalculate hallway width to fill available space
        # Service strip: hallway → shaft zone → bathroom
        # Ensure total doesn't exceed apartment width
        fixed_strip = C.SHAFT_ZONE_WIDTH + C.PARTITION_WALL  # shaft + partition
        hall_w = apt_w - bath_w - fixed_strip
        hall_w = max(hall_w, 1.50)  # Minimum hallway width

        # Clamp bathroom width if hallway minimum forces overflow
        max_bath_w = apt_w - hall_w - fixed_strip
        if bath_w > max_bath_w > 0:
            bath_w = max_bath_w

        # Place hallway
        cursor_x = x0
        rooms.append(Room(
            id=f"room_{_uid()}", room_type=RoomType.HALLWAY,
            polygon=_rect_polygon(cursor_x, service_y, hall_w, service_d),
            area_sqm=_rect_area(hall_w, service_d),
            label="Hallway", apartment_id=apt_id,
        ))
        cursor_x += hall_w + C.PARTITION_WALL

        # Skip shaft zone (it's TGA, not a room)
        cursor_x += C.SHAFT_ZONE_WIDTH

        # Place bathroom (centered vertically in service strip, clamped to strip bounds)
        bath_y = service_y + (service_d - bath_d) / 2
        # Ensure bathroom doesn't exceed apartment x-boundary
        bath_w = min(bath_w, x1 - cursor_x)
        rooms.append(Room(
            id=f"room_{_uid()}", room_type=RoomType.BATHROOM,
            polygon=_rect_polygon(cursor_x, bath_y, bath_w, bath_d),
            area_sqm=_rect_area(bath_w, bath_d),
            label="Bathroom", apartment_id=apt_id,
        ))

        # === DISTRIBUTION ARM: full-width hallway extension for 3+ room apartments ===
        # This narrow corridor runs along the boundary between service strip and
        # room zone, ensuring every room has a direct connection to the hallway.
        # It's the standard German residential layout: the Flur wraps as an L/T shape.
        if needs_distribution_arm and dist_arm_d > 0:
            rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.HALLWAY,
                polygon=_rect_polygon(x0, dist_arm_y, apt_w, dist_arm_d),
                area_sqm=_rect_area(apt_w, dist_arm_d),
                label="Distribution Corridor", apartment_id=apt_id,
            ))

        # === ROOM ZONE: bedrooms + WOHNKÜCHE (combined living+kitchen) ===
        # Use room_proportion to vary bedroom/living split
        prop = room_proportion if room_proportion is not None else 0.40

        if apt_type == "1_room":
            # Single room: living/sleeping + kitchen (Wohnküche)
            rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.LIVING,
                polygon=_rect_polygon(x0, room_y, apt_w, room_d),
                area_sqm=_rect_area(apt_w, room_d),
                label="Living/Kitchen", apartment_id=apt_id,
            ))

        elif apt_type == "2_room":
            # One bedroom (must be ≥15m²) + Wohnküche
            min_bed1_w = math.ceil((15.0 / room_d) / C.GRID_UNIT) * C.GRID_UNIT
            bed_w = round(apt_w * max(0.25, min(0.55, prop)), 2)
            bed_w = max(bed_w, min_bed1_w)  # Enforce minimum bedroom size
            # Clamp bedroom so living room still fits within apartment
            bed_w = min(bed_w, apt_w - C.PARTITION_WALL - 1.0)
            liv_w = apt_w - bed_w - C.PARTITION_WALL
            liv_w = max(liv_w, 1.0)  # Absolute minimum

            rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.BEDROOM,
                polygon=_rect_polygon(x0, room_y, bed_w, room_d),
                area_sqm=_rect_area(bed_w, room_d),
                label="Bedroom", apartment_id=apt_id,
            ))
            rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.LIVING,
                polygon=_rect_polygon(x0 + bed_w + C.PARTITION_WALL, room_y, liv_w, room_d),
                area_sqm=_rect_area(liv_w, room_d),
                label="Wohnküche", apartment_id=apt_id,
            ))

        elif apt_type == "3_room":
            # Two bedrooms + Wohnküche
            # Bedroom 1 ≥15m², Bedroom 2 ≥10m²
            min_bed1_w = math.ceil((15.0 / room_d) / C.GRID_UNIT) * C.GRID_UNIT
            min_bed_w = math.ceil((10.0 / room_d) / C.GRID_UNIT) * C.GRID_UNIT

            bed_total_ratio = max(0.40, min(0.70, prop + 0.15))
            bed_total_w = apt_w * bed_total_ratio
            bed1_w = round(bed_total_w / 2, 2)
            bed2_w = round(bed_total_w - bed1_w, 2)

            # Enforce minimum sizes
            bed1_w = max(bed1_w, min_bed1_w)
            bed2_w = max(bed2_w, min_bed_w)

            # Cap total bedroom width so living room gets at least 3.0m
            min_liv_w = 3.0
            max_bed_total = apt_w - min_liv_w - 2 * C.PARTITION_WALL
            if bed1_w + bed2_w > max_bed_total > 0:
                # Scale bedrooms down proportionally while keeping minimums
                scale = max_bed_total / (bed1_w + bed2_w)
                bed1_w = max(round(bed1_w * scale, 2), min_bed1_w)
                bed2_w = max(round(max_bed_total - bed1_w, 2), min_bed_w)

            # HARD CLAMP: ensure rooms never exceed apartment boundary
            # If minimums force overflow, shrink living room first, then bedrooms
            total_rooms_w = bed1_w + bed2_w + 2 * C.PARTITION_WALL
            liv_w = apt_w - total_rooms_w
            if liv_w < min_liv_w:
                # Not enough room — shrink bed2 to fit
                bed2_w = apt_w - bed1_w - min_liv_w - 2 * C.PARTITION_WALL
                if bed2_w < min_bed_w:
                    # Still not enough — shrink bed1 too
                    bed2_w = min_bed_w
                    bed1_w = apt_w - bed2_w - min_liv_w - 2 * C.PARTITION_WALL
                    bed1_w = max(bed1_w, min_bed_w)
                liv_w = apt_w - bed1_w - bed2_w - 2 * C.PARTITION_WALL
            liv_w = max(liv_w, 1.0)  # Absolute minimum so room exists

            # Final safety: clamp all widths so total exactly equals apt_w
            total_check = bed1_w + bed2_w + 2 * C.PARTITION_WALL + liv_w
            if total_check > apt_w + 0.01:
                overflow = total_check - apt_w
                liv_w = max(1.0, liv_w - overflow)

            rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.BEDROOM,
                polygon=_rect_polygon(x0, room_y, bed1_w, room_d),
                area_sqm=_rect_area(bed1_w, room_d),
                label="Bedroom 1", apartment_id=apt_id,
            ))
            rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.BEDROOM,
                polygon=_rect_polygon(x0 + bed1_w + C.PARTITION_WALL, room_y, bed2_w, room_d),
                area_sqm=_rect_area(bed2_w, room_d),
                label="Bedroom 2", apartment_id=apt_id,
            ))
            rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.LIVING,
                polygon=_rect_polygon(x0 + bed1_w + bed2_w + 2 * C.PARTITION_WALL, room_y, liv_w, room_d),
                area_sqm=_rect_area(liv_w, room_d),
                label="Wohnküche", apartment_id=apt_id,
            ))

        elif apt_type in ("4_room", "5_room"):
            # Multiple bedrooms + Wohnküche
            num_beds = 3 if apt_type == "4_room" else 4
            min_bed1_w = math.ceil((15.0 / room_d) / C.GRID_UNIT) * C.GRID_UNIT
            min_bed_w = math.ceil((10.0 / room_d) / C.GRID_UNIT) * C.GRID_UNIT

            bed_total_ratio = max(0.50, min(0.80, prop + 0.25))
            bed_total_w = apt_w * bed_total_ratio

            # Cap total bedroom width so living room gets at least 3.0m
            min_liv_w = 3.0
            max_bed_total = apt_w - min_liv_w - num_beds * C.PARTITION_WALL
            if bed_total_w > max_bed_total > 0:
                bed_total_w = max_bed_total

            x_cursor = x0
            for b in range(num_beds):
                bed_w = round(bed_total_w / num_beds, 2)
                # Enforce minimums: first bedroom ≥15m², others ≥10m²
                if b == 0:
                    bed_w = max(bed_w, min_bed1_w)
                else:
                    bed_w = max(bed_w, min_bed_w)
                # Don't exceed remaining space minus living room minimum
                remaining = x1 - x_cursor - (num_beds - b) * C.PARTITION_WALL
                max_this_bed = remaining - min_liv_w - (num_beds - b - 1) * min_bed_w
                if max_this_bed > 0:
                    bed_w = min(bed_w, max_this_bed)
                # Hard clamp: bedroom must not extend past apartment boundary
                bed_w = min(bed_w, x1 - x_cursor)
                if bed_w < 1.0:
                    break  # Not enough room for more bedrooms

                rooms.append(Room(
                    id=f"room_{_uid()}", room_type=RoomType.BEDROOM,
                    polygon=_rect_polygon(x_cursor, room_y, bed_w, room_d),
                    area_sqm=_rect_area(bed_w, room_d),
                    label=f"Bedroom {b+1}", apartment_id=apt_id,
                ))
                x_cursor += bed_w + C.PARTITION_WALL

            liv_w = max(0, x1 - x_cursor)
            if liv_w > 3.0:
                rooms.append(Room(
                    id=f"room_{_uid()}", room_type=RoomType.LIVING,
                    polygon=_rect_polygon(x_cursor, room_y, liv_w, room_d),
                    area_sqm=_rect_area(liv_w, room_d),
                    label="Wohnküche", apartment_id=apt_id,
                ))

        # --- Storage closet ---
        # Place storage at the hallway end (near entrance), carved from hallway space
        storage_w = min(1.20, hall_w * 0.4)  # Max 40% of hallway width
        storage_d = min(1.00, service_d * 0.5)  # Max 50% of service depth
        if storage_w >= 0.625 and storage_d >= 0.625:
            storage_x = x0 + hall_w - storage_w  # At far end of hallway
            storage_y = service_y + service_d - storage_d  # Against inner wall
            rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.STORAGE,
                polygon=_rect_polygon(storage_x, storage_y, storage_w, storage_d),
                area_sqm=_rect_area(storage_w, storage_d),
                label="Storage", apartment_id=apt_id,
            ))

        # === BALCONY: standard Goldbeck dimensions ===
        # Balcony width: min(apt_w, 3.20), depth: 1.60 (two-post standard)
        # Centered on the apartment width, positioned on exterior side
        balcony_w = min(apt_w, C.BALCONY_STANDARD_WIDTH)
        balcony_d = C.BALCONY_STANDARD_DEPTH

        # Center balcony on apartment width, clamped to apartment bounds
        balcony_x = x0 + max(0.0, (apt_w - balcony_w) / 2)

        rooms.append(Room(
            id=f"room_{_uid()}", room_type=RoomType.BALCONY,
            polygon=_rect_polygon(balcony_x, balcony_y, balcony_w, balcony_d),
            area_sqm=_rect_area(balcony_w, balcony_d),
            label="Balcony", apartment_id=apt_id,
        ))

        # === SAFETY CLAMP: ensure NO room polygon exceeds apartment boundary ===
        # This catches any edge case where minimum sizes, rounding, or partition
        # wall accumulation push rooms beyond the bounding box.
        for room in rooms:
            if room.room_type == RoomType.BALCONY:
                continue  # Balconies are intentionally outside the envelope
            clamped_poly = []
            for pt in room.polygon:
                cx = max(x0, min(x1, pt.x))
                cy = max(bbox["y_start"], min(bbox["y_end"], pt.y))
                clamped_poly.append(Point2D(x=round(cx, 3), y=round(cy, 3)))
            room.polygon = clamped_poly
            # Recalculate area from clamped polygon
            if len(clamped_poly) == 4:
                cw = max(p.x for p in clamped_poly) - min(p.x for p in clamped_poly)
                ch = max(p.y for p in clamped_poly) - min(p.y for p in clamped_poly)
                room.area_sqm = round(cw * ch, 2)

        return rooms, bath_dims, entrance_door_id

    # ========================================================
    # Phase 7: Walls, Doors, Windows
    # ========================================================
    def _phase7_generate_elements(
        self,
        grid: StructuralGrid,
        apartments: list[Apartment],
        staircases: list[StaircaseUnit],
        access: AccessType,
    ) -> tuple[list[WallSegment], list[DoorPlacement], list[WindowPlacement], list[Room]]:
        """Generate structural walls, doors, windows, and building-level rooms."""
        walls = []
        doors = []
        windows = []
        building_rooms = []

        length = grid.building_length_m
        depth = grid.building_depth_m

        # --- Outer walls ---
        walls.append(WallSegment(
            id=f"wall_{_uid()}", wall_type=WallType.OUTER_LONG,
            start=Point2D(x=0, y=C.OUTER_LONG_WALL / 2),
            end=Point2D(x=length, y=C.OUTER_LONG_WALL / 2),
            thickness_m=C.OUTER_LONG_WALL, is_bearing=False, is_exterior=True,
        ))
        walls.append(WallSegment(
            id=f"wall_{_uid()}", wall_type=WallType.OUTER_LONG,
            start=Point2D(x=0, y=depth - C.OUTER_LONG_WALL / 2),
            end=Point2D(x=length, y=depth - C.OUTER_LONG_WALL / 2),
            thickness_m=C.OUTER_LONG_WALL, is_bearing=False, is_exterior=True,
        ))
        walls.append(WallSegment(
            id=f"wall_{_uid()}", wall_type=WallType.GABLE_END,
            start=Point2D(x=C.GABLE_END_WALL / 2, y=0),
            end=Point2D(x=C.GABLE_END_WALL / 2, y=depth),
            thickness_m=C.GABLE_END_WALL, is_bearing=True, is_exterior=True,
        ))
        walls.append(WallSegment(
            id=f"wall_{_uid()}", wall_type=WallType.GABLE_END,
            start=Point2D(x=length - C.GABLE_END_WALL / 2, y=0),
            end=Point2D(x=length - C.GABLE_END_WALL / 2, y=depth),
            thickness_m=C.GABLE_END_WALL, is_bearing=True, is_exterior=True,
        ))

        # --- Bearing cross walls ---
        # Cross walls must break at corridor boundaries (Ganghaus) so the
        # corridor/hallway remains fully open and walkable.
        has_corridor = access == AccessType.GANGHAUS and grid.corridor_width_m > 0
        corr_y0 = grid.corridor_y_start_m if has_corridor else 0
        corr_y1 = (corr_y0 + C.CORRIDOR_WALL + grid.corridor_width_m + C.CORRIDOR_WALL) if has_corridor else 0

        for i, ax in enumerate(grid.axis_positions_x):
            if i == 0 or i == len(grid.axis_positions_x) - 1:
                continue
            if has_corridor:
                # South segment: from bottom to corridor south wall
                walls.append(WallSegment(
                    id=f"wall_{_uid()}", wall_type=WallType.BEARING_CROSS,
                    start=Point2D(x=ax, y=0),
                    end=Point2D(x=ax, y=corr_y0),
                    thickness_m=C.BEARING_CROSS_WALL, is_bearing=True, is_exterior=False,
                ))
                # North segment: from corridor north wall to top
                walls.append(WallSegment(
                    id=f"wall_{_uid()}", wall_type=WallType.BEARING_CROSS,
                    start=Point2D(x=ax, y=corr_y1),
                    end=Point2D(x=ax, y=depth),
                    thickness_m=C.BEARING_CROSS_WALL, is_bearing=True, is_exterior=False,
                ))
            else:
                # No corridor — full-height cross wall
                walls.append(WallSegment(
                    id=f"wall_{_uid()}", wall_type=WallType.BEARING_CROSS,
                    start=Point2D(x=ax, y=0),
                    end=Point2D(x=ax, y=depth),
                    thickness_m=C.BEARING_CROSS_WALL, is_bearing=True, is_exterior=False,
                ))

        # --- Corridor walls (Ganghaus) / Gallery annotation (Laubengang) ---
        if access == AccessType.GANGHAUS:
            cy = grid.corridor_y_start_m
            walls.append(WallSegment(
                id=f"wall_{_uid()}", wall_type=WallType.CORRIDOR,
                start=Point2D(x=0, y=cy + C.CORRIDOR_WALL / 2),
                end=Point2D(x=length, y=cy + C.CORRIDOR_WALL / 2),
                thickness_m=C.CORRIDOR_WALL, is_bearing=True, is_exterior=False,
            ))
            north_cy = cy + C.CORRIDOR_WALL + grid.corridor_width_m
            walls.append(WallSegment(
                id=f"wall_{_uid()}", wall_type=WallType.CORRIDOR,
                start=Point2D(x=0, y=north_cy + C.CORRIDOR_WALL / 2),
                end=Point2D(x=length, y=north_cy + C.CORRIDOR_WALL / 2),
                thickness_m=C.CORRIDOR_WALL, is_bearing=True, is_exterior=False,
            ))

            corr_y_inner = cy + C.CORRIDOR_WALL
            corr_h = grid.corridor_width_m
            building_rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.CORRIDOR,
                polygon=_rect_polygon(C.GABLE_END_WALL, corr_y_inner, length - 2 * C.GABLE_END_WALL, corr_h),
                area_sqm=_rect_area(length - 2 * C.GABLE_END_WALL, corr_h),
                label="Central Corridor",
            ))

        elif access == AccessType.LAUBENGANG:
            # External gallery: walkway is OUTSIDE the building envelope
            # Add a gallery room for visualization (positioned outside north wall)
            gallery_y = depth  # Gallery starts at outer north wall
            gallery_length = length - 2 * C.GABLE_END_WALL
            building_rooms.append(Room(
                id=f"room_{_uid()}", room_type=RoomType.CORRIDOR,
                polygon=_rect_polygon(C.GABLE_END_WALL, gallery_y, gallery_length, C.GALLERY_WIDTH),
                area_sqm=_rect_area(gallery_length, C.GALLERY_WIDTH),
                label="External Gallery (Laubengang)",
            ))

        # --- Partition walls within apartments ---
        for apt in apartments:
            for room in apt.rooms:
                if room.room_type in (RoomType.BATHROOM, RoomType.STORAGE):
                    poly = room.polygon
                    if len(poly) >= 4:
                        for j in range(len(poly)):
                            p1 = poly[j]
                            p2 = poly[(j + 1) % len(poly)]
                            walls.append(WallSegment(
                                id=f"wall_{_uid()}",
                                wall_type=WallType.PARTITION,
                                start=p1, end=p2,
                                thickness_m=C.PARTITION_WALL,
                                is_bearing=False, is_exterior=False,
                            ))

        # --- Staircase rooms ---
        for stair in staircases:
            stair_room = Room(
                id=f"room_{_uid()}", room_type=RoomType.STAIRCASE,
                polygon=_rect_polygon(
                    stair.position.x, stair.position.y,
                    stair.width_m, stair.depth_m
                ),
                area_sqm=_rect_area(stair.width_m, stair.depth_m),
                label=f"Staircase ({stair.staircase_type.value})",
            )
            building_rooms.append(stair_room)

            if stair.has_elevator:
                elev_w = 2.10
                elev_d = 1.50
                elev_x = stair.position.x + (stair.width_m - elev_w) / 2
                elev_y = depth / 2 - elev_d / 2
                building_rooms.append(Room(
                    id=f"room_{_uid()}", room_type=RoomType.ELEVATOR,
                    polygon=_rect_polygon(elev_x, elev_y, elev_w, elev_d),
                    area_sqm=_rect_area(elev_w, elev_d),
                    label="Elevator",
                ))

        # --- Windows on exterior walls ---
        # Architectural rule: window area must be 20-25% of room floor area
        # Standard Goldbeck window widths: 0.625, 1.25, 1.50, 1.875m
        # Heights: 2.24m (floor-to-ceiling) or 1.34m (parapet/Brüstung)
        MIN_WINDOW_AREA_RATIO = 0.20  # 20% minimum of room floor area
        TARGET_WINDOW_AREA_RATIO = 0.22  # Target slightly above minimum

        for apt in apartments:
            for room in apt.rooms:
                if room.room_type in (RoomType.LIVING, RoomType.BEDROOM):
                    poly = room.polygon
                    if len(poly) < 4:
                        continue

                    min_x = min(p.x for p in poly)
                    max_x = max(p.x for p in poly)
                    min_y = min(p.y for p in poly)
                    max_y = max(p.y for p in poly)
                    room_w = max_x - min_x
                    center_x = (min_x + max_x) / 2

                    on_south = min_y <= C.OUTER_LONG_WALL + 0.1
                    on_north = max_y >= depth - C.OUTER_LONG_WALL - 0.1

                    if on_south or on_north:
                        win_y = C.OUTER_LONG_WALL / 2 if on_south else depth - C.OUTER_LONG_WALL / 2

                        # Living rooms: floor-to-ceiling (2.24m), others: parapet (1.34m)
                        is_ftc = room.room_type == RoomType.LIVING
                        win_h = C.WINDOW_HEIGHT_FLOOR_TO_CEILING if is_ftc else C.WINDOW_HEIGHT_PARAPET
                        sill_h = 0.0 if is_ftc else C.WINDOW_SILL_HEIGHT

                        # Calculate required window area from room floor area
                        room_area = room.area_sqm
                        required_win_area = room_area * TARGET_WINDOW_AREA_RATIO

                        # Pick window configuration to meet the area requirement
                        # Available widths sorted for greedy fill
                        available_widths = sorted(C.WINDOW_WIDTHS, reverse=True)
                        max_wall_span = room_w - 2 * C.MIN_EDGE_TO_OPENING

                        placed_windows = []
                        remaining_area = required_win_area
                        remaining_span = max_wall_span
                        cursor_x = min_x + C.MIN_EDGE_TO_OPENING

                        while remaining_area > 0 and remaining_span > available_widths[-1]:
                            # Pick largest window that fits
                            chosen_w = None
                            for ww in available_widths:
                                if ww <= remaining_span + 0.01:
                                    chosen_w = ww
                                    break
                            if not chosen_w:
                                break

                            win_area = chosen_w * win_h
                            wx = cursor_x + chosen_w / 2
                            placed_windows.append((wx, chosen_w))
                            remaining_area -= win_area
                            remaining_span -= (chosen_w + C.MIN_BETWEEN_OPENINGS)
                            cursor_x += chosen_w + C.MIN_BETWEEN_OPENINGS

                        # Ensure at least one window per habitable room
                        if not placed_windows:
                            # Fallback: smallest window at room center
                            win_w = min(available_widths[-1], room_w - 2 * C.MIN_EDGE_TO_OPENING)
                            if win_w > 0:
                                placed_windows.append((center_x, max(0.625, win_w)))

                        for wx, ww in placed_windows:
                            # Clamp window to building envelope
                            half_w = ww / 2
                            # Ensure window doesn't protrude past building edges
                            wx = max(half_w + C.MIN_EDGE_TO_OPENING, wx)
                            wx = min(length - half_w - C.MIN_EDGE_TO_OPENING, wx)
                            # Also clamp to room boundaries
                            wx = max(min_x + half_w + C.MIN_EDGE_TO_OPENING, wx)
                            wx = min(max_x - half_w - C.MIN_EDGE_TO_OPENING, wx)
                            # Skip window if room is too narrow to fit it
                            if max_x - min_x < ww + 2 * C.MIN_EDGE_TO_OPENING:
                                # Try a smaller window
                                ww = max(0.625, max_x - min_x - 2 * C.MIN_EDGE_TO_OPENING)
                                half_w = ww / 2
                                wx = (min_x + max_x) / 2
                                if ww < 0.5:
                                    continue  # Room too narrow for any window
                            windows.append(WindowPlacement(
                                id=f"win_{_uid()}",
                                position=Point2D(x=round(wx, 3), y=round(win_y, 3)),
                                wall_id="south_wall" if on_south else "north_wall",
                                width_m=round(ww, 3),
                                height_m=win_h,
                                sill_height_m=sill_h,
                                is_floor_to_ceiling=is_ftc,
                            ))

        # --- Apartment entrance doors (upper floors) ---
        # Each apartment gets exactly ONE entrance door:
        #   Ganghaus: door faces internal corridor wall
        #   Laubengang: door faces gallery-side exterior wall (north)
        #   Spaenner: door faces hallway interior (toward staircase)
        for apt in apartments:
            hallway = next((r for r in apt.rooms if r.room_type == RoomType.HALLWAY), None)
            if not hallway or len(hallway.polygon) < 4:
                continue

            center_x = sum(p.x for p in hallway.polygon) / len(hallway.polygon)

            if access == AccessType.GANGHAUS:
                # Entrance on corridor wall side
                if apt.side == "south":
                    door_y = max(p.y for p in hallway.polygon)
                else:
                    door_y = min(p.y for p in hallway.polygon)
                wall_ref = "corridor_wall"
            elif access == AccessType.LAUBENGANG:
                # Entrance on gallery-side exterior wall (north wall)
                gallery_side = grid.gallery_side or "north"
                if gallery_side == "north":
                    door_y = depth - C.OUTER_LONG_WALL / 2
                else:
                    door_y = C.OUTER_LONG_WALL / 2
                wall_ref = "gallery_wall"
            else:
                # Spaenner: entrance faces toward staircase/hallway
                door_y = max(p.y for p in hallway.polygon)
                wall_ref = "hallway_wall"

            doors.append(DoorPlacement(
                id=apt.entrance_door_id,
                position=Point2D(x=round(center_x, 3), y=round(door_y, 3)),
                wall_id=wall_ref,
                width_m=C.APARTMENT_ENTRANCE_DOOR_WIDTH,
                is_entrance=True,
            ))

        # --- Interior doors ---
        for apt in apartments:
            for room in apt.rooms:
                if room.room_type in (RoomType.BEDROOM, RoomType.LIVING, RoomType.BATHROOM, RoomType.STORAGE):
                    poly = room.polygon
                    if len(poly) >= 4:
                        center_x = sum(p.x for p in poly) / len(poly)
                        if apt.side == "south":
                            door_y = max(p.y for p in poly)
                        else:
                            door_y = min(p.y for p in poly)

                        doors.append(DoorPlacement(
                            id=f"door_{_uid()}",
                            position=Point2D(x=round(center_x, 3), y=round(door_y, 3)),
                            wall_id=f"partition_{room.id}",
                            width_m=C.INTERIOR_DOOR_WIDTH,
                            is_entrance=False,
                        ))

        return walls, doors, windows, building_rooms

    def _generate_ground_floor_doors(
        self,
        apartments: list[Apartment],
        grid: StructuralGrid,
        access: AccessType,
    ) -> list[DoorPlacement]:
        """Generate entrance doors for ground floor apartments.

        Architectural rule: Ground floor apartments can have direct exterior access
        (door on outer wall facing outside) instead of corridor/gallery access.
        Each apartment gets exactly ONE entrance door.
        """
        doors = []
        depth = grid.building_depth_m

        for apt in apartments:
            hallway = next((r for r in apt.rooms if r.room_type == RoomType.HALLWAY), None)
            if not hallway or len(hallway.polygon) < 4:
                continue

            center_x = sum(p.x for p in hallway.polygon) / len(hallway.polygon)

            # Ground floor: entrance door on exterior wall (direct outside access)
            if apt.side == "south" or apt.side == "single":
                # South-side or single apartments: door on south exterior wall
                door_y = C.OUTER_LONG_WALL / 2
            else:
                # North-side apartments: door on north exterior wall
                door_y = depth - C.OUTER_LONG_WALL / 2

            doors.append(DoorPlacement(
                id=apt.entrance_door_id,
                position=Point2D(x=round(center_x, 3), y=round(door_y, 3)),
                wall_id="exterior_wall",
                width_m=C.ENTRANCE_DOOR_EXTERIOR_WIDTH_A,  # Wider exterior entrance
                is_entrance=True,
            ))

        return doors
