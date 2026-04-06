from pydantic import BaseModel, Field

from app.models.optimization import LayoutOption


class CostBreakdown(BaseModel):
    land_cost: float
    hard_costs_residential: float
    hard_costs_commercial: float
    hard_costs_parking: float
    hard_costs_sitework: float
    total_hard_costs: float
    soft_costs_detail: dict[str, float]
    total_soft_costs: float
    total_development_cost: float
    cost_per_unit: float
    cost_per_sqm: float


class RevenueBreakdown(BaseModel):
    monthly_residential_income: float
    monthly_commercial_income: float
    monthly_parking_income: float
    gross_monthly_income: float
    effective_gross_income_monthly: float
    annual_noi: float
    noi_per_unit: float


class AnnualCashflow(BaseModel):
    year: int
    noi: float
    debt_service: float
    cashflow: float
    cumulative_cashflow: float


class FinancialAnalysis(BaseModel):
    cost_breakdown: CostBreakdown
    revenue_breakdown: RevenueBreakdown
    total_development_cost: float
    annual_noi: float
    cap_rate: float
    stabilized_value: float
    equity_required: float
    loan_amount: float
    annual_debt_service: float
    cash_on_cash_return_pct: float
    roi_pct: float
    yield_on_cost_pct: float
    development_spread_bps: float
    irr_pct: float | None = None
    equity_multiple: float | None = None
    profit_margin_pct: float
    annual_cashflow_projection: list[AnnualCashflow]


class FinancialAnalysisRequest(BaseModel):
    layout: LayoutOption
    plot_area_sqm: float = Field(gt=0, description="Plot area in m²")
    land_cost: float = Field(default=2_000_000.0, ge=0, description="Land acquisition cost")
    construction_costs: dict[str, float] | None = None
    soft_cost_rates: dict[str, float] | None = None
    revenue_assumptions: dict[str, float] | None = None
    analysis_period_years: int = Field(default=10, ge=1, le=50, description="Projection horizon in years")
    financing_ltc_pct: float = Field(default=65.0, ge=0, le=100, description="Loan-to-cost percentage")
    interest_rate_pct: float = Field(default=6.5, ge=0, le=30, description="Annual interest rate percentage")
    exit_cap_rate_pct: float = Field(default=5.5, gt=0, le=20, description="Exit cap rate percentage (must be >0)")
