from app.models.regulation import RegulationSet, RegulationValidationResult
from app.models.optimization import RegulationCheckResult
from app.models.building import BuildingFootprint


class RegulationEngine:
    """Validates regulation sets and checks layout compliance."""

    def validate(self, regs: RegulationSet) -> RegulationValidationResult:
        issues: list[str] = []
        warnings: list[str] = []

        if regs.max_lot_coverage_pct + regs.min_open_space_pct > 100:
            issues.append(
                f"max_lot_coverage_pct ({regs.max_lot_coverage_pct}%) + "
                f"min_open_space_pct ({regs.min_open_space_pct}%) exceeds 100%"
            )

        if regs.max_far <= 0:
            issues.append("max_far must be positive")
        if regs.max_height_m <= 0:
            issues.append("max_height_m must be positive")
        if regs.max_stories <= 0:
            issues.append("max_stories must be positive")

        effective_height = regs.max_stories * 3.05
        if effective_height > regs.max_height_m:
            warnings.append(
                f"max_stories ({regs.max_stories}) at 3.05m floor height "
                f"({effective_height:.1f}m) exceeds max_height_m ({regs.max_height_m:.1f}m)"
            )

        if regs.setbacks.front_m < 0 or regs.setbacks.rear_m < 0:
            issues.append("Setbacks cannot be negative")
        if regs.setbacks.side_left_m < 0 or regs.setbacks.side_right_m < 0:
            issues.append("Side setbacks cannot be negative")

        if regs.fire_access_width_m < 3.66:
            warnings.append("Fire access width below 3.66m may not meet code")

        if regs.parking.studio_ratio < 0:
            issues.append("Parking ratios cannot be negative")

        return RegulationValidationResult(
            is_valid=len(issues) == 0,
            issues=issues,
            warnings=warnings,
        )

    def check_compliance(
        self,
        buildings: list[BuildingFootprint],
        plot_area_sqm: float,
        lot_coverage_pct: float,
        open_space_pct: float,
        regs: RegulationSet,
        min_separation_m: float,
    ) -> RegulationCheckResult:
        violations: list[str] = []
        warnings: list[str] = []

        # FAR check
        total_gfa = sum(b.gross_floor_area_sqm for b in buildings)
        far_used = total_gfa / plot_area_sqm if plot_area_sqm > 0 else 0

        if far_used > regs.max_far:
            violations.append(
                f"FAR {far_used:.2f} exceeds maximum {regs.max_far}"
            )

        # Height check
        max_height = max((b.total_height_m for b in buildings), default=0)
        if max_height > regs.max_height_m:
            violations.append(
                f"Building height {max_height:.1f}m exceeds maximum {regs.max_height_m:.1f}m"
            )

        # Stories check
        max_stories = max((b.stories for b in buildings), default=0)
        if max_stories > regs.max_stories:
            violations.append(
                f"Building has {max_stories} stories, max allowed is {regs.max_stories}"
            )

        # Lot coverage check
        if lot_coverage_pct > regs.max_lot_coverage_pct:
            violations.append(
                f"Lot coverage {lot_coverage_pct:.1f}% exceeds maximum {regs.max_lot_coverage_pct}%"
            )

        # Open space check
        if open_space_pct < regs.min_open_space_pct:
            violations.append(
                f"Open space {open_space_pct:.1f}% below minimum {regs.min_open_space_pct}%"
            )

        # Building separation
        if len(buildings) > 1 and min_separation_m < regs.min_building_separation_m:
            violations.append(
                f"Minimum building separation {min_separation_m:.1f}m "
                f"below required {regs.min_building_separation_m:.1f}m"
            )

        # Parking check
        parking_required = self._compute_parking_required(buildings, regs)
        parking_provided = self._estimate_parking_provided(
            buildings, plot_area_sqm, lot_coverage_pct
        )

        if parking_provided < parking_required:
            warnings.append(
                f"Parking: {parking_provided:.0f} spaces provided, "
                f"{parking_required:.0f} required"
            )

        return RegulationCheckResult(
            is_compliant=len(violations) == 0,
            violations=violations,
            warnings=warnings,
            far_used=far_used,
            far_max=regs.max_far,
            lot_coverage_pct=lot_coverage_pct,
            height_max_m=max_height,
            total_parking_required=parking_required,
            total_parking_provided=parking_provided,
        )

    def _compute_parking_required(
        self, buildings: list[BuildingFootprint], regs: RegulationSet
    ) -> float:
        total = 0.0
        for b in buildings:
            if b.unit_mix:
                for entry in b.unit_mix.entries:
                    if entry.unit_type == "studio":
                        total += entry.count * regs.parking.studio_ratio
                    elif entry.unit_type == "1br":
                        total += entry.count * regs.parking.one_bed_ratio
                    elif entry.unit_type == "2br":
                        total += entry.count * regs.parking.two_bed_ratio
                    elif entry.unit_type == "3br":
                        total += entry.count * regs.parking.three_bed_ratio
                    elif entry.unit_type == "commercial":
                        total += (
                            entry.total_sqm
                            / 1000
                            * regs.parking.commercial_ratio_per_1000sqm
                        )
        guest = sum(
            b.unit_mix.total_units if b.unit_mix else 0 for b in buildings
        ) * regs.parking.guest_ratio
        return total + guest

    def _estimate_parking_provided(
        self,
        buildings: list[BuildingFootprint],
        plot_area_sqm: float,
        lot_coverage_pct: float,
    ) -> float:
        """Estimate parking from podium/surface parking areas."""
        podium_spaces = sum(
            (b.width_m * b.depth_m) / 32.5  # ~32.5 sqm per parking space
            for b in buildings
            if b.ground_floor_parking
        )
        open_area = plot_area_sqm * (1 - lot_coverage_pct / 100)
        surface_spaces = (open_area * 0.3) / 32.5  # 30% of open area for surface parking
        return podium_spaces + surface_spaces
