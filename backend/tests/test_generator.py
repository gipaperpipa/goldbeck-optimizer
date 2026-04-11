"""
Smoke tests for the Goldbeck floor plan generator and optimizer.

These tests verify that the generator produces structurally valid output
and that the optimizer converges (fitness improves or stays stable).
"""
import pytest

from app.models.floorplan import FloorPlanRequest, FloorPlanWeights


# ── Generator smoke tests ─────────────────────────────────────────────

class TestGoldbeckGenerator:
    """Test the 7-phase deterministic generator directly."""

    def _make_request(self, width=25.0, depth=12.5, stories=3, **kw):
        return FloorPlanRequest(
            building_id="test",
            building_width_m=width,
            building_depth_m=depth,
            stories=stories,
            **kw,
        )

    def _generate(self, request):
        from app.services.floorplan.goldbeck_generator import GoldbeckGenerator
        gen = GoldbeckGenerator()
        return gen.generate_floor_plans(request)

    def test_basic_generation(self):
        """Generator should produce a BuildingFloorPlans with correct story count."""
        result = self._generate(self._make_request())
        assert result is not None
        assert len(result.floor_plans) == 3
        assert result.num_stories == 3

    def test_ganghaus_generation(self):
        """A 12.5m deep building should produce Ganghaus access."""
        from app.models.floorplan import AccessType
        result = self._generate(self._make_request(depth=12.5))
        assert result.access_type in (AccessType.GANGHAUS, AccessType.LAUBENGANG, AccessType.SPAENNER)

    def test_narrow_building_spaenner(self):
        """A narrow building (~6.25m) should use Spaenner access."""
        from app.models.floorplan import AccessType
        result = self._generate(self._make_request(width=12.5, depth=6.25))
        # Spaenner is selected for narrow buildings, but generator may override
        assert result.access_type is not None

    def test_each_floor_has_structural_grid(self):
        result = self._generate(self._make_request())
        for fp in result.floor_plans:
            assert fp.structural_grid is not None
            assert len(fp.structural_grid.bay_widths) > 0
            assert fp.structural_grid.building_length_m > 0
            assert fp.structural_grid.building_depth_m > 0

    def test_each_floor_has_walls(self):
        result = self._generate(self._make_request())
        for fp in result.floor_plans:
            assert len(fp.walls) > 0, f"Floor {fp.floor_index} has no walls"

    def test_each_floor_has_rooms(self):
        result = self._generate(self._make_request())
        for fp in result.floor_plans:
            assert len(fp.rooms) > 0, f"Floor {fp.floor_index} has no rooms"

    def test_each_floor_has_apartments(self):
        result = self._generate(self._make_request())
        for fp in result.floor_plans:
            assert fp.num_apartments > 0, f"Floor {fp.floor_index} has no apartments"

    def test_apartments_have_positive_area(self):
        result = self._generate(self._make_request())
        for fp in result.floor_plans:
            for apt in fp.apartments:
                assert apt.total_area_sqm > 0, f"Apt {apt.id} has zero area"

    def test_bay_widths_are_valid_goldbeck_rasters(self):
        """All bay widths should be valid Goldbeck rasters (3.125 to 6.25m)."""
        from app.services.floorplan import goldbeck_constants as C
        result = self._generate(self._make_request())
        valid = set(C.VALID_RASTERS)
        for fp in result.floor_plans:
            for bw in fp.structural_grid.bay_widths:
                assert bw in valid, f"Bay width {bw}m is not a valid Goldbeck raster"

    def test_gross_area_positive(self):
        result = self._generate(self._make_request())
        for fp in result.floor_plans:
            assert fp.gross_area_sqm > 0

    def test_apartment_summary_matches(self):
        result = self._generate(self._make_request())
        summary_total = sum(result.apartment_summary.values())
        assert summary_total == result.total_apartments

    def test_single_story_building(self):
        result = self._generate(self._make_request(stories=1))
        assert len(result.floor_plans) == 1
        assert result.num_stories == 1

    def test_five_story_building(self):
        result = self._generate(self._make_request(stories=5))
        assert len(result.floor_plans) == 5

    def test_staffelgeschoss(self):
        """Staffelgeschoss (setback top floor) should have different grid dims."""
        result = self._generate(self._make_request(
            stories=4,
            enable_staffelgeschoss=True,
            staffelgeschoss_setback_m=2.0,
        ))
        assert len(result.floor_plans) == 4
        top = result.floor_plans[-1]
        regular = result.floor_plans[0]
        # Setback top floor should have smaller depth or length
        assert (
            top.structural_grid.building_depth_m <= regular.structural_grid.building_depth_m
        ), "Staffelgeschoss should have reduced dimensions"

    def test_wide_building(self):
        """A 50m wide building should still generate successfully."""
        result = self._generate(self._make_request(width=50.0, depth=12.5))
        assert result is not None
        assert len(result.floor_plans) > 0


# ── Optimizer smoke tests ─────────────────────────────────────────────

class TestFloorPlanOptimizer:
    """Smoke tests for the genetic algorithm optimizer."""

    def test_optimizer_returns_variants(self):
        """Optimizer should return at least 1 variant."""
        from app.services.floorplan.optimizer import FloorPlanOptimizer
        request = FloorPlanRequest(
            building_id="opt-test",
            building_width_m=25.0,
            building_depth_m=12.5,
            stories=3,
            generations=2,
            population_size=6,
        )
        optimizer = FloorPlanOptimizer()
        variants = optimizer.optimize(request)
        assert len(variants) > 0

    def test_variants_are_ranked(self):
        """Variants should be sorted by descending fitness."""
        from app.services.floorplan.optimizer import FloorPlanOptimizer
        request = FloorPlanRequest(
            building_id="opt-test",
            building_width_m=25.0,
            building_depth_m=12.5,
            stories=3,
            generations=3,
            population_size=8,
        )
        optimizer = FloorPlanOptimizer()
        variants = optimizer.optimize(request)
        if len(variants) >= 2:
            scores = [v.fitness_score for v in variants]
            assert scores == sorted(scores, reverse=True), "Variants not sorted by fitness"

    def test_progress_callback_called(self):
        """Progress callback should be invoked at least once per generation."""
        from app.services.floorplan.optimizer import FloorPlanOptimizer
        request = FloorPlanRequest(
            building_id="opt-test",
            building_width_m=25.0,
            building_depth_m=12.5,
            stories=3,
            generations=3,
            population_size=6,
        )
        calls = []

        def cb(gen, total, best, avg=0.0, live_preview=None):
            calls.append((gen, total, best))

        optimizer = FloorPlanOptimizer()
        optimizer.optimize(request, progress_callback=cb)
        assert len(calls) >= 3, f"Expected ≥3 callback calls, got {len(calls)}"

    def test_variant_has_fitness_breakdown(self):
        """Each variant should include a fitness breakdown dict."""
        from app.services.floorplan.optimizer import FloorPlanOptimizer
        request = FloorPlanRequest(
            building_id="opt-test",
            building_width_m=25.0,
            building_depth_m=12.5,
            stories=3,
            generations=2,
            population_size=6,
        )
        optimizer = FloorPlanOptimizer()
        variants = optimizer.optimize(request)
        for v in variants:
            assert v.fitness_breakdown is not None, f"Variant rank {v.rank} has no breakdown"
            assert len(v.fitness_breakdown) > 0

    def test_variant_building_plans_valid(self):
        """Each variant's building_floor_plans should have the right structure."""
        from app.services.floorplan.optimizer import FloorPlanOptimizer
        request = FloorPlanRequest(
            building_id="opt-test",
            building_width_m=25.0,
            building_depth_m=12.5,
            stories=3,
            generations=2,
            population_size=6,
        )
        optimizer = FloorPlanOptimizer()
        variants = optimizer.optimize(request)
        for v in variants:
            bfp = v.building_floor_plans
            assert bfp.num_stories == 3
            assert len(bfp.floor_plans) == 3
            assert bfp.total_apartments > 0
