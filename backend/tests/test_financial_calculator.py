"""
Tests for FinancialCalculator — especially division-by-zero guards.

The calculator takes a LayoutOption with building metrics and produces
cost breakdowns, revenue projections, and return metrics. Every division
in the code must be guarded against zero denominators.
"""
import pytest

from app.models.financial import FinancialAnalysisRequest, FinancialAnalysis
from app.models.optimization import LayoutOption, LayoutScores, RegulationCheckResult
from app.models.building import BuildingFootprint, UnitMix, UnitMixEntry
from app.services.financial_calculator import FinancialCalculator


def _make_layout(
    total_units=10,
    total_residential_sqm=800.0,
    total_commercial_sqm=0.0,
    total_parking_spaces=5,
    buildings=None,
):
    """Build a minimal LayoutOption for testing."""
    if buildings is None:
        buildings = [BuildingFootprint(
            id="b1",
            position_x=0,
            position_y=0,
            width_m=25,
            depth_m=12.5,
            stories=3,
            total_height_m=9.15,
            gross_floor_area_sqm=937.5,
            net_floor_area_sqm=800.0,
            unit_mix=UnitMix(
                entries=[
                    UnitMixEntry(unit_type="1br", count=6, avg_sqm=50, total_sqm=300),
                    UnitMixEntry(unit_type="2br", count=4, avg_sqm=75, total_sqm=300),
                ],
                total_units=total_units,
                total_residential_sqm=total_residential_sqm,
                total_commercial_sqm=total_commercial_sqm,
            ),
        )]
    return LayoutOption(
        id="layout-1",
        rank=1,
        buildings=buildings,
        scores=LayoutScores(overall=0.8, efficiency=0.8, financial=0.8, livability=0.8, compliance=0.8),
        regulation_check=RegulationCheckResult(
            is_compliant=True, violations=[], warnings=[],
            far_used=1.5, far_max=2.0, lot_coverage_pct=40.0,
            height_max_m=15.0, total_parking_required=10, total_parking_provided=10,
        ),
        total_units=total_units,
        total_residential_sqm=total_residential_sqm,
        total_commercial_sqm=total_commercial_sqm,
        total_parking_spaces=total_parking_spaces,
        far_achieved=1.5,
        lot_coverage_pct=40.0,
        open_space_pct=60.0,
        building_separation_min_m=10.0,
    )


def _make_request(layout=None, **overrides):
    if layout is None:
        layout = _make_layout()
    defaults = dict(
        layout=layout,
        plot_area_sqm=2000.0,
        land_cost=2_000_000,
        analysis_period_years=10,
        financing_ltc_pct=65.0,
        interest_rate_pct=6.5,
        exit_cap_rate_pct=5.5,
    )
    defaults.update(overrides)
    return FinancialAnalysisRequest(**defaults)


# ── Normal operation ──────────────────────────────────────────────────

class TestFinancialCalculatorNormal:
    def test_basic_analysis(self):
        calc = FinancialCalculator()
        result = calc.analyze(_make_request())
        assert isinstance(result, FinancialAnalysis)
        assert result.total_development_cost > 0
        assert result.annual_noi >= 0

    def test_cost_breakdown_components(self):
        calc = FinancialCalculator()
        result = calc.analyze(_make_request())
        cb = result.cost_breakdown
        assert cb.total_hard_costs > 0
        assert cb.total_soft_costs > 0
        assert cb.total_development_cost == cb.land_cost + cb.total_hard_costs + cb.total_soft_costs
        assert cb.cost_per_unit > 0
        assert cb.cost_per_sqm > 0

    def test_cashflow_projection_length(self):
        calc = FinancialCalculator()
        result = calc.analyze(_make_request(analysis_period_years=5))
        assert len(result.annual_cashflow_projection) == 5
        for i, cf in enumerate(result.annual_cashflow_projection):
            assert cf.year == i + 1

    def test_noi_grows_over_time(self):
        calc = FinancialCalculator()
        result = calc.analyze(_make_request(analysis_period_years=5))
        nois = [cf.noi for cf in result.annual_cashflow_projection]
        for i in range(1, len(nois)):
            assert nois[i] > nois[i - 1], "NOI should grow year over year"

    def test_cap_rate_reasonable(self):
        calc = FinancialCalculator()
        result = calc.analyze(_make_request())
        assert 0 <= result.cap_rate <= 0.5, f"Cap rate {result.cap_rate} seems unreasonable"


# ── Division-by-zero guards ───────────────────────────────────────────

class TestFinancialCalculatorZeroGuards:
    """Every division in the calculator must handle zero denominators."""

    def test_zero_units(self):
        """cost_per_unit and noi_per_unit should be 0, not crash."""
        layout = _make_layout(total_units=0)
        calc = FinancialCalculator()
        result = calc.analyze(_make_request(layout=layout))
        assert result.cost_breakdown.cost_per_unit == 0
        assert result.revenue_breakdown.noi_per_unit == 0

    def test_zero_residential_sqm(self):
        """cost_per_sqm should be 0 with no residential area."""
        layout = _make_layout(total_residential_sqm=0.0)
        calc = FinancialCalculator()
        result = calc.analyze(_make_request(layout=layout))
        assert result.cost_breakdown.cost_per_sqm == 0

    def test_zero_land_cost(self):
        """All-zero land cost should not crash."""
        calc = FinancialCalculator()
        result = calc.analyze(_make_request(land_cost=0))
        assert result.total_development_cost > 0  # still has hard+soft costs

    def test_zero_interest_rate(self):
        """Zero interest rate should fall back to simple division."""
        calc = FinancialCalculator()
        result = calc.analyze(_make_request(interest_rate_pct=0.0))
        assert result.annual_debt_service > 0  # still has principal payments

    def test_full_equity_no_loan(self):
        """100% equity (0% LTC) means no loan and no debt service."""
        calc = FinancialCalculator()
        result = calc.analyze(_make_request(financing_ltc_pct=0.0))
        assert result.loan_amount == 0
        assert result.annual_debt_service == 0
        assert result.equity_required == result.total_development_cost

    def test_zero_total_dev_cost_edge(self):
        """If somehow total dev cost is near zero, metrics should not crash."""
        layout = _make_layout(
            total_units=0,
            total_residential_sqm=0.0,
            total_commercial_sqm=0.0,
            total_parking_spaces=0,
            buildings=[BuildingFootprint(
                id="b1", position_x=0, position_y=0, width_m=1, depth_m=1,
                stories=1, total_height_m=3, gross_floor_area_sqm=1, net_floor_area_sqm=0,
                unit_mix=None,
            )],
        )
        calc = FinancialCalculator()
        result = calc.analyze(_make_request(layout=layout, land_cost=0))
        # Should not crash — all ratio metrics should be 0
        assert result.cap_rate == 0
        assert result.roi_pct == 0
        assert result.yield_on_cost_pct == 0
