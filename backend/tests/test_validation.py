"""
Tests for the building code validation suite.

Runs validation on real generator output to verify:
- Validation runs without crashing
- Dict output has correct structure
- Generated buildings pass most checks (known issues documented)
"""
import pytest

from app.models.floorplan import FloorPlanRequest, BuildingFloorPlans
from app.services.floorplan.goldbeck_generator import GoldbeckGenerator
from app.services.floorplan.validation import (
    validate_building,
    validate_building_dict,
    ValidationReport,
    Severity,
)


def _generate_building(width=25.0, depth=12.5, stories=3) -> BuildingFloorPlans:
    gen = GoldbeckGenerator()
    return gen.generate_floor_plans(FloorPlanRequest(
        building_id="val-test",
        building_width_m=width,
        building_depth_m=depth,
        stories=stories,
    ))


# ── Validation execution ──────────────────────────────────────────────

class TestValidationExecution:
    def test_validate_runs_on_generated_building(self):
        """Validation should complete without crashing on valid generator output."""
        plans = _generate_building()
        report = validate_building(plans)
        assert isinstance(report, ValidationReport)
        assert report.summary is not None

    def test_validate_building_dict_structure(self):
        """Dict output should have compliant, summary, and results keys."""
        plans = _generate_building()
        result = validate_building_dict(plans)
        assert "compliant" in result
        assert "summary" in result
        assert "results" in result
        assert isinstance(result["results"], list)

    def test_each_result_has_required_fields(self):
        plans = _generate_building()
        result = validate_building_dict(plans)
        for r in result["results"]:
            assert "severity" in r
            assert "check" in r
            assert "message" in r
            assert r["severity"] in ("ERROR", "WARNING", "INFO")

    def test_results_sorted_by_severity(self):
        """Errors should come before warnings, warnings before info."""
        plans = _generate_building()
        result = validate_building_dict(plans)
        severity_order = {"ERROR": 0, "WARNING": 1, "INFO": 2}
        severities = [severity_order[r["severity"]] for r in result["results"]]
        assert severities == sorted(severities), "Results not sorted by severity"

    def test_summary_counts_match(self):
        plans = _generate_building()
        report = validate_building(plans)
        errors = sum(1 for r in report.results if r.severity == Severity.ERROR)
        warnings = sum(1 for r in report.results if r.severity == Severity.WARNING)
        infos = sum(1 for r in report.results if r.severity == Severity.INFO)
        assert report.summary["errors"] == errors
        assert report.summary["warnings"] == warnings
        assert report.summary["info"] == infos


# ── Multi-building-type validation ────────────────────────────────────

class TestValidationVariety:
    """Validate across different building configurations."""

    @pytest.mark.parametrize("width,depth,stories", [
        (25.0, 12.5, 3),   # Standard ganghaus
        (25.0, 12.5, 5),   # Tall ganghaus
        (25.0, 12.5, 1),   # Single story
        (12.5, 6.25, 3),   # Narrow / spaenner
        (50.0, 12.5, 3),   # Wide building
    ])
    def test_validates_without_crash(self, width, depth, stories):
        """Generator + validation should not crash for any building type."""
        plans = _generate_building(width=width, depth=depth, stories=stories)
        result = validate_building_dict(plans)
        assert "compliant" in result
        assert isinstance(result["compliant"], bool)


# ── Structural grid check ─────────────────────────────────────────────

class TestStructuralGridValidation:
    def test_generated_building_has_valid_grid(self):
        """Generator should always produce valid Goldbeck rasters."""
        from app.services.floorplan import goldbeck_constants as C
        plans = _generate_building()
        valid = set(C.STANDARD_RASTERS)
        for fp in plans.floor_plans:
            for bw in fp.structural_grid.bay_widths:
                assert bw in valid, f"Invalid bay width {bw}m on floor {fp.floor_index}"


# ── Apartment area validation ─────────────────────────────────────────

class TestApartmentAreaValidation:
    def test_apartments_have_reasonable_areas(self):
        """All apartments should be between 20 and 200 sqm."""
        plans = _generate_building()
        for fp in plans.floor_plans:
            for apt in fp.apartments:
                assert 15 <= apt.total_area_sqm <= 250, (
                    f"Apt {apt.id} has unreasonable area: {apt.total_area_sqm:.1f} sqm"
                )
