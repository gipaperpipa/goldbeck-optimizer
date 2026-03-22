from app.models.optimization import OptimizationWeights


class FitnessEvaluator:
    """Multi-objective fitness evaluation for layout optimization.

    Scores are normalized relative to achievable targets for the given
    plot, so the fitness landscape has meaningful gradients regardless
    of whether the plot is 500 sqm or 500,000 sqm.
    """

    def evaluate(
        self,
        far: float,
        max_far: float,
        lot_coverage: float,
        max_lot_coverage: float,
        open_space_pct: float,
        min_separation: float,
        total_units: int,
        total_gfa: float,
        weights: OptimizationWeights,
        plot_area: float = 10000.0,
    ) -> float:
        efficiency = self._efficiency_score(far, max_far, lot_coverage, max_lot_coverage)
        financial = self._financial_score(total_units, total_gfa, plot_area, max_far)
        livability = self._livability_score(open_space_pct, min_separation, max_lot_coverage)
        compliance = 1.0  # Already verified via hard constraints

        score = (
            weights.efficiency * efficiency
            + weights.financial * financial
            + weights.livability * livability
            + weights.compliance * compliance
        )
        return score

    def _efficiency_score(
        self,
        far: float,
        max_far: float,
        lot_coverage: float,
        max_lot_coverage: float,
    ) -> float:
        far_util = far / max_far if max_far > 0 else 0
        cov_util = lot_coverage / max_lot_coverage if max_lot_coverage > 0 else 0
        # Reward being close to max but not over
        far_score = min(1.0, far_util) * (1.0 - max(0, far_util - 1.0) * 10)
        cov_score = min(1.0, cov_util)
        return 0.6 * far_score + 0.4 * cov_score

    def _financial_score(
        self,
        total_units: int,
        total_gfa: float,
        plot_area: float,
        max_far: float,
    ) -> float:
        # Scale targets to the achievable maximum for this plot
        max_gfa = plot_area * max_far  # theoretical max gross floor area
        gfa_target = max(1.0, max_gfa * 0.6)  # target = 60% of regulatory max
        unit_target = max(1.0, gfa_target * 0.85 / 60.0)  # ~60 sqm avg unit

        unit_score = min(1.0, total_units / unit_target)
        gfa_score = min(1.0, total_gfa / gfa_target)
        return 0.5 * unit_score + 0.5 * gfa_score

    def _livability_score(
        self,
        open_space_pct: float,
        min_separation: float,
        max_lot_coverage: float,
    ) -> float:
        # Scale open space target relative to what's achievable
        # If max lot coverage is 50%, min open space is ~50%, so target ~65%
        open_space_target = max(30.0, 100.0 - max_lot_coverage * 0.7)
        space_score = min(1.0, open_space_pct / open_space_target)

        # Separation: diminishing returns past 15m
        sep_score = min(1.0, min_separation / 15.0)
        return 0.5 * space_score + 0.5 * sep_score
