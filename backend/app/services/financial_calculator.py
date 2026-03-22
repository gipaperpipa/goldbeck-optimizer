from app.models.financial import (
    FinancialAnalysisRequest,
    FinancialAnalysis,
    CostBreakdown,
    RevenueBreakdown,
    AnnualCashflow,
)
from app.services.floorplan import goldbeck_constants as C


DEFAULT_CONSTRUCTION_COSTS = {
    "residential_per_sqft": 250.0,
    "commercial_per_sqft": 200.0,
    "parking_per_space": 35000.0,
    "sitework_per_sqft": 15.0,
}

DEFAULT_SOFT_COST_RATES = {
    "architecture_engineering": 0.08,
    "permits_fees": 0.03,
    "legal_accounting": 0.015,
    "insurance": 0.01,
    "developer_fee": 0.04,
    "contingency": 0.05,
    "financing_costs": 0.02,
    "marketing_lease_up": 0.015,
}

DEFAULT_REVENUE = {
    "studio_rent_per_sqft": 3.50,
    "one_bed_rent_per_sqft": 3.00,
    "two_bed_rent_per_sqft": 2.75,
    "three_bed_rent_per_sqft": 2.50,
    "commercial_rent_per_sqft": 2.00,
    "parking_rent_per_space": 150.0,
    "vacancy_rate": 0.05,
    "operating_expense_ratio": 0.35,
    "annual_rent_growth": 0.03,
    "annual_expense_growth": 0.02,
}


class FinancialCalculator:
    def analyze(self, request: FinancialAnalysisRequest) -> FinancialAnalysis:
        layout = request.layout
        costs = {**DEFAULT_CONSTRUCTION_COSTS, **(request.construction_costs or {})}
        soft_rates = {**DEFAULT_SOFT_COST_RATES, **(request.soft_cost_rates or {})}
        rev = {**DEFAULT_REVENUE, **(request.revenue_assumptions or {})}

        # ── Cost Breakdown ──
        # Convert sqm to sqft for cost calculations
        res_sqft = layout.total_residential_sqm / (C.FT_TO_M ** 2)
        com_sqft = layout.total_commercial_sqm / (C.FT_TO_M ** 2)
        hard_res = res_sqft * costs["residential_per_sqft"]
        hard_com = com_sqft * costs["commercial_per_sqft"]
        hard_park = layout.total_parking_spaces * costs["parking_per_space"]
        plot_area_sqft = request.plot_area_sqm / (C.FT_TO_M ** 2)
        hard_site = plot_area_sqft * costs["sitework_per_sqft"]
        total_hard = hard_res + hard_com + hard_park + hard_site

        soft_detail = {}
        for key, rate in soft_rates.items():
            soft_detail[key] = total_hard * rate
        total_soft = sum(soft_detail.values())

        total_dev_cost = request.land_cost + total_hard + total_soft
        cost_per_unit = total_dev_cost / layout.total_units if layout.total_units > 0 else 0
        cost_per_sqm = (
            total_dev_cost / layout.total_residential_sqm
            if layout.total_residential_sqm > 0
            else 0
        )

        cost_breakdown = CostBreakdown(
            land_cost=request.land_cost,
            hard_costs_residential=hard_res,
            hard_costs_commercial=hard_com,
            hard_costs_parking=hard_park,
            hard_costs_sitework=hard_site,
            total_hard_costs=total_hard,
            soft_costs_detail=soft_detail,
            total_soft_costs=total_soft,
            total_development_cost=total_dev_cost,
            cost_per_unit=cost_per_unit,
            cost_per_sqm=cost_per_sqm,
        )

        # ── Revenue Breakdown ──
        monthly_res = 0.0
        for b in layout.buildings:
            if b.unit_mix:
                for entry in b.unit_mix.entries:
                    # Convert sqm to sqft for revenue calculations
                    entry_sqft = entry.total_sqm / (C.FT_TO_M ** 2)
                    rent_key = f"{entry.unit_type}_rent_per_sqft"
                    mapped_key = {
                        "studio": "studio_rent_per_sqft",
                        "1br": "one_bed_rent_per_sqft",
                        "2br": "two_bed_rent_per_sqft",
                        "3br": "three_bed_rent_per_sqft",
                        "commercial": "commercial_rent_per_sqft",
                    }.get(entry.unit_type, "one_bed_rent_per_sqft")
                    monthly_res += entry_sqft * rev[mapped_key]

        monthly_com = com_sqft * rev["commercial_rent_per_sqft"]
        monthly_park = layout.total_parking_spaces * rev["parking_rent_per_space"]
        gross_monthly = monthly_res + monthly_com + monthly_park
        effective_monthly = gross_monthly * (1 - rev["vacancy_rate"])
        annual_egi = effective_monthly * 12
        annual_opex = annual_egi * rev["operating_expense_ratio"]
        annual_noi = annual_egi - annual_opex
        noi_per_unit = annual_noi / layout.total_units if layout.total_units > 0 else 0

        revenue_breakdown = RevenueBreakdown(
            monthly_residential_income=monthly_res,
            monthly_commercial_income=monthly_com,
            monthly_parking_income=monthly_park,
            gross_monthly_income=gross_monthly,
            effective_gross_income_monthly=effective_monthly,
            annual_noi=annual_noi,
            noi_per_unit=noi_per_unit,
        )

        # ── Return Metrics ──
        cap_rate = annual_noi / total_dev_cost if total_dev_cost > 0 else 0
        exit_cap = request.exit_cap_rate_pct / 100
        stabilized_value = annual_noi / exit_cap if exit_cap > 0 else 0

        ltc = request.financing_ltc_pct / 100
        loan_amount = total_dev_cost * ltc
        equity_required = total_dev_cost - loan_amount
        interest_rate = request.interest_rate_pct / 100
        # 30-year amortization monthly payment
        monthly_rate = interest_rate / 12
        n_payments = 360
        if monthly_rate > 0:
            monthly_payment = loan_amount * (
                monthly_rate * (1 + monthly_rate) ** n_payments
            ) / ((1 + monthly_rate) ** n_payments - 1)
        else:
            monthly_payment = loan_amount / n_payments
        annual_debt = monthly_payment * 12

        annual_cashflow_yr1 = annual_noi - annual_debt
        coc_return = (
            annual_cashflow_yr1 / equity_required * 100
            if equity_required > 0
            else 0
        )
        roi = (stabilized_value - total_dev_cost) / total_dev_cost * 100 if total_dev_cost > 0 else 0
        yoc = annual_noi / total_dev_cost * 100 if total_dev_cost > 0 else 0
        dev_spread = (yoc - (exit_cap * 100)) * 100  # in basis points
        profit_margin = (
            (stabilized_value - total_dev_cost) / stabilized_value * 100
            if stabilized_value > 0
            else 0
        )

        # ── Cashflow Projection ──
        projections = []
        cumulative = 0.0
        noi_yr = annual_noi
        for yr in range(1, request.analysis_period_years + 1):
            cf = noi_yr - annual_debt
            cumulative += cf
            projections.append(AnnualCashflow(
                year=yr,
                noi=round(noi_yr, 2),
                debt_service=round(annual_debt, 2),
                cashflow=round(cf, 2),
                cumulative_cashflow=round(cumulative, 2),
            ))
            noi_yr *= (1 + rev["annual_rent_growth"])

        return FinancialAnalysis(
            cost_breakdown=cost_breakdown,
            revenue_breakdown=revenue_breakdown,
            total_development_cost=round(total_dev_cost, 2),
            annual_noi=round(annual_noi, 2),
            cap_rate=round(cap_rate, 4),
            stabilized_value=round(stabilized_value, 2),
            equity_required=round(equity_required, 2),
            loan_amount=round(loan_amount, 2),
            annual_debt_service=round(annual_debt, 2),
            cash_on_cash_return_pct=round(coc_return, 2),
            roi_pct=round(roi, 2),
            yield_on_cost_pct=round(yoc, 2),
            development_spread_bps=round(dev_spread, 0),
            profit_margin_pct=round(profit_margin, 2),
            annual_cashflow_projection=projections,
        )
