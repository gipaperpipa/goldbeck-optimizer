import uuid
import random
import logging
from typing import Callable

logger = logging.getLogger(__name__)

from shapely.geometry import Polygon

from app.models.optimization import (
    OptimizationRequest,
    LayoutOption,
    LayoutScores,
    RegulationCheckResult,
)
from app.models.building import BuildingFootprint, UnitMix, UnitMixEntry
from app.services.geometry_engine import GeometryEngine
from app.services.regulation_engine import RegulationEngine
from app.services.optimizer.chromosome import Chromosome, Gene, decode_gene
from app.services.optimizer.fitness import FitnessEvaluator
from app.services.optimizer.operators import (
    tournament_select,
    crossover,
    mutate,
)
from app.services.floorplan import goldbeck_constants as C


class LayoutOptimizer:
    """Genetic algorithm orchestrator for building layout optimization."""

    def __init__(self):
        self.geometry = GeometryEngine()
        self.reg_engine = RegulationEngine()
        self.fitness_eval = FitnessEvaluator()

    def optimize(
        self,
        request: OptimizationRequest,
        progress_callback: Callable[[int, int, float, float], None] | None = None,
    ) -> list[LayoutOption]:
        """Run the genetic algorithm to find optimal building layouts.

        Evolves a population of building placement candidates, scoring each
        by efficiency, financial viability, livability, and regulation
        compliance.  Returns the top-K unique LayoutOptions ranked by
        overall fitness.

        Args:
            request: Plot geometry, regulations, unit mix, GA parameters
                (population_size, generations, weights).
            progress_callback: Called each generation with
                (gen, total_gens, best_fitness, avg_fitness).

        Returns:
            Ranked list of LayoutOptions with scores and regulation checks.
        """
        boundary = request.plot.boundary_polygon_local
        plot_polygon = Polygon(boundary)
        plot_area = request.plot.area_sqm

        logger.info("plot_area=%.1f sqm, boundary=%s...", plot_area, boundary[:4])
        logger.info("plot_polygon valid=%s, area=%.1f", plot_polygon.is_valid, plot_polygon.area)

        regs = request.regulations
        logger.info(
            "regs: max_far=%s, max_stories=%s, max_height_m=%s, "
            "max_lot_cov=%s, min_open_space=%s, min_sep=%s",
            regs.max_far, regs.max_stories, regs.max_height_m,
            regs.max_lot_coverage_pct, regs.min_open_space_pct, regs.min_building_separation_m,
        )

        buildable = self.geometry.compute_buildable_area(
            boundary,
            front_m=regs.setbacks.front_m,
            rear_m=regs.setbacks.rear_m,
            side_left_m=regs.setbacks.side_left_m,
            side_right_m=regs.setbacks.side_right_m,
        )
        if buildable is None or buildable.is_empty:
            logger.error("Buildable area is None or empty!")
            return []

        logger.info("buildable bounds=%s, area=%.1f", buildable.bounds, buildable.area)

        # Reset per-run diagnostics
        self._eval_count = 0
        self._fail_reasons = {}

        buildable_bounds = buildable.bounds
        max_building_height = regs.max_height_m
        max_stories = regs.max_stories

        # Initialize population
        pop_size = request.population_size
        generations = request.generations
        population = [
            self._random_chromosome(
                request.min_buildings,
                request.max_buildings,
                buildable_bounds,
                max_stories,
            )
            for _ in range(pop_size)
        ]

        # Evaluate initial population — use SOFT constraints for gradient
        fitness_scores = [
            self._evaluate(ch, buildable, plot_polygon, plot_area, request)
            for ch in population
        ]

        best_fitness = max(fitness_scores)
        best_ever = best_fitness
        elitism_count = max(2, pop_size // 10)
        immigrant_count = max(1, pop_size // 7)  # ~15% random immigrants per gen
        base_mutation_rate = 0.15
        mutation_rate = base_mutation_rate
        mutation_sigma = 0.1  # Mutation magnitude (std dev)
        stagnation_counter = 0
        prev_best = best_fitness

        for gen in range(generations):
            # --- Fitness sharing (niching) to preserve diversity ---
            shared_fitness = self._apply_fitness_sharing(
                population, fitness_scores, sigma=0.3
            )

            # Elitism: preserve top individuals by ORIGINAL fitness
            sorted_pop = sorted(
                zip(population, fitness_scores),
                key=lambda x: x[1],
                reverse=True,
            )
            new_population = [ch for ch, _ in sorted_pop[:elitism_count]]

            # Random immigrants: inject fresh blood each generation
            for _ in range(immigrant_count):
                new_population.append(self._random_chromosome(
                    request.min_buildings, request.max_buildings,
                    buildable_bounds, max_stories,
                ))

            # Fill rest with selection + crossover + mutation
            # Use SHARED fitness for selection to favor unique solutions
            while len(new_population) < pop_size:
                parent_a = tournament_select(population, shared_fitness, k=3)
                parent_b = tournament_select(population, shared_fitness, k=3)
                child = crossover(parent_a, parent_b)
                child = mutate(child, mutation_rate=mutation_rate,
                               mutation_sigma=mutation_sigma,
                               bounds=buildable_bounds, max_stories=max_stories)
                new_population.append(child)

            population = new_population
            fitness_scores = [
                self._evaluate(ch, buildable, plot_polygon, plot_area, request)
                for ch in population
            ]

            best_fitness = max(fitness_scores)
            best_ever = max(best_ever, best_fitness)
            nonzero = [f for f in fitness_scores if f > 0]
            avg_fitness = sum(nonzero) / len(nonzero) if nonzero else 0.0

            # Adaptive mutation: increase BOTH rate and magnitude when stagnating
            if best_fitness > prev_best + 0.001:
                stagnation_counter = 0
                mutation_rate = base_mutation_rate
                mutation_sigma = 0.1
            else:
                stagnation_counter += 1
                if stagnation_counter > 10:
                    # Ramp up mutation rate AND magnitude
                    mutation_rate = min(0.6, base_mutation_rate + 0.02 * (stagnation_counter - 10))
                    mutation_sigma = min(0.4, 0.1 + 0.015 * (stagnation_counter - 10))

            # Population restart: if stagnant for 30+ gens, replace bottom 40%
            if stagnation_counter > 0 and stagnation_counter % 30 == 0:
                sorted_by_fit = sorted(
                    zip(population, fitness_scores),
                    key=lambda x: x[1], reverse=True,
                )
                keep = max(elitism_count, int(pop_size * 0.6))
                population = [ch for ch, _ in sorted_by_fit[:keep]]
                for _ in range(pop_size - keep):
                    population.append(self._random_chromosome(
                        request.min_buildings, request.max_buildings,
                        buildable_bounds, max_stories,
                    ))
                fitness_scores = [
                    self._evaluate(ch, buildable, plot_polygon, plot_area, request)
                    for ch in population
                ]
                best_fitness = max(fitness_scores)
                if gen % 50 == 0:
                    logger.info(
                        "gen=%d RESTART: stagnation=%d, best=%.4f, mutation_rate=%.3f, sigma=%.3f",
                        gen, stagnation_counter, best_fitness, mutation_rate, mutation_sigma,
                    )

            prev_best = best_fitness

            if progress_callback:
                progress_callback(gen + 1, generations, best_ever, avg_fitness)

        # Extract top distinct layouts
        scored = sorted(
            zip(population, fitness_scores),
            key=lambda x: x[1],
            reverse=True,
        )

        layouts: list[LayoutOption] = []
        seen_fingerprints: set[str] = set()
        seen_building_counts: set[int] = set()

        # First pass: try to get diverse building counts
        for chromosome, fitness in scored:
            if len(layouts) >= 5:
                break
            layout = self._chromosome_to_layout(
                chromosome, buildable, plot_polygon, plot_area, request, len(layouts) + 1
            )
            if layout is None:
                continue

            fp = self._layout_fingerprint(layout)
            n_buildings = len(layout.buildings)

            # Prefer layouts with different building counts
            if fp in seen_fingerprints:
                continue
            # After we have one of each building count, allow duplicates
            if n_buildings in seen_building_counts and len(layouts) < 3:
                # Skip if we haven't explored other building counts yet
                # but only if there's still hope for diversity
                if len(seen_building_counts) < min(request.max_buildings, 3):
                    continue

            seen_fingerprints.add(fp)
            seen_building_counts.add(n_buildings)
            layout.scores.overall = fitness
            layouts.append(layout)

        # If we didn't get 5, do a second pass without the building count filter
        if len(layouts) < 5:
            for chromosome, fitness in scored:
                if len(layouts) >= 5:
                    break
                layout = self._chromosome_to_layout(
                    chromosome, buildable, plot_polygon, plot_area, request, len(layouts) + 1
                )
                if layout is None:
                    continue
                fp = self._layout_fingerprint(layout)
                if fp in seen_fingerprints:
                    continue
                seen_fingerprints.add(fp)
                layout.scores.overall = fitness
                layouts.append(layout)

        return layouts

    def _random_chromosome(
        self,
        min_buildings: int,
        max_buildings: int,
        bounds: tuple,
        max_stories: int,
    ) -> Chromosome:
        n = random.randint(min_buildings, max_buildings)
        genes = []
        for _ in range(n):
            gene = Gene(
                x=random.random(),
                y=random.random(),
                width=random.uniform(0.2, 0.8),
                depth=random.uniform(0.2, 0.8),
                rotation=random.random(),
                stories=random.random(),
                has_staffel=random.random(),
            )
            genes.append(gene)
        return Chromosome(genes=genes)

    # M38: Instance variables (initialized in optimize()) — not class-level to avoid sharing across instances
    _eval_count: int
    _fail_reasons: dict[str, int]

    def _evaluate(
        self,
        chromosome: Chromosome,
        buildable: Polygon,
        plot_polygon: Polygon,
        plot_area: float,
        request: OptimizationRequest,
    ) -> float:
        self._eval_count += 1
        log_this = self._eval_count <= 5  # Log first 5 evaluations in detail

        buildings = self._decode_buildings(chromosome, buildable, request)
        if not buildings:
            self._track_fail("no_buildings")
            return 0.0

        if log_this:
            for i, b in enumerate(buildings):
                logger.debug(
                    "eval#%d bldg%d: pos=(%.1f,%.1f) size=%.1fx%.1f rot=%.1f stories=%d",
                    self._eval_count, i,
                    b['x'], b['y'], b['width'], b['depth'], b['rotation'], b['stories'],
                )

        bldg_polys = [
            self.geometry.create_building_polygon(
                b["x"], b["y"], b["width"], b["depth"], b["rotation"]
            )
            for b in buildings
        ]

        # --- Soft constraint penalties (gradient instead of zero walls) ---
        penalty = 1.0  # Multiplicative penalty factor

        # Containment: penalize proportional to area outside buildable
        for idx, poly in enumerate(bldg_polys):
            if not self.geometry.fits_within(poly, buildable):
                try:
                    outside_area = poly.difference(buildable).area
                    overlap_ratio = 1.0 - min(1.0, outside_area / max(poly.area, 0.01))
                except Exception as e:
                    logger.debug(f"Geometry difference failed for building {idx}: {e}")
                    overlap_ratio = 0.0
                if overlap_ratio < 0.5:
                    # Too far outside — still effectively zero
                    self._track_fail("fits_within")
                    return 0.0
                # Soft penalty: proportional to how much is outside
                penalty *= overlap_ratio ** 2
                if log_this:
                    logger.debug(
                        "eval#%d SOFT PENALTY bldg%d: overlap_ratio=%.3f",
                        self._eval_count, idx, overlap_ratio,
                    )

        # Overlap between buildings: hard zero (can't have buildings intersect)
        for i in range(len(bldg_polys)):
            for j in range(i + 1, len(bldg_polys)):
                if self.geometry.check_overlap(bldg_polys[i], bldg_polys[j]):
                    self._track_fail("overlap")
                    return 0.0

        # ── Phase 8.5: §6 Abstandsflächen ⊂ plot ──────────────────
        # The buildable area already inflates inward by the planning-rule
        # setbacks (front / rear / side from the BauNVO regulations), but
        # those are separate from §6 (BauO NRW §6 = max(0.4·H, 3 m) per
        # facade). Without this check the layout optimizer happily places
        # a 4-storey block whose §6 ground projection extends 5 m onto
        # the neighbour's parcel — a hard violation.
        #
        # When a chromosome flags has_staffel we additionally check the
        # SG envelope: lower footprint inset symmetrically by
        # `setback_m`, then inflated by max(0.4·H_total, 3 m) where
        # H_total includes the SG storey. The SG often dominates §6
        # because adding one storey to a 4-storey building bumps d from
        # ~4.6 m to ~5.8 m and the setback (2 m) doesn't fully offset.
        H_COEFF = 0.4
        STORY_H = 3.05
        SG_SETBACK_M = 2.0
        for b in buildings:
            h_lower = b["stories"] * STORY_H
            d_lower = max(H_COEFF * h_lower, 3.0)
            abst_lower = self.geometry.create_inflated_building(
                b["x"], b["y"], b["width"], b["depth"], b["rotation"], d_lower,
            )
            penalty *= self._abstand_penalty(
                abst_lower, plot_polygon, "abstand_lower_overflow",
            )
            if penalty == 0.0:
                return 0.0

            if b.get("has_staffel"):
                sg_w = max(b["width"] - 2 * SG_SETBACK_M, 1.0)
                sg_d = max(b["depth"] - 2 * SG_SETBACK_M, 1.0)
                h_total = (b["stories"] + 1) * STORY_H
                d_sg = max(H_COEFF * h_total, 3.0)
                abst_sg = self.geometry.create_inflated_building(
                    b["x"], b["y"], sg_w, sg_d, b["rotation"], d_sg,
                )
                penalty *= self._abstand_penalty(
                    abst_sg, plot_polygon, "abstand_sg_overflow",
                )
                if penalty == 0.0:
                    return 0.0

        lot_cov = self.geometry.compute_lot_coverage(bldg_polys, plot_area)
        far_data = [
            {"footprint_area": poly.area, "stories": b["stories"]}
            for poly, b in zip(bldg_polys, buildings)
        ]
        far = self.geometry.compute_far(far_data, plot_area)
        open_space = self.geometry.compute_open_space_pct(bldg_polys, plot_polygon)

        regs = request.regulations

        # Soft constraint: FAR (penalize overshoot proportionally)
        if far > regs.max_far:
            overshoot = (far - regs.max_far) / max(regs.max_far, 0.01)
            penalty *= max(0.1, 1.0 - overshoot * 2.0)

        # Soft constraint: lot coverage
        if lot_cov > regs.max_lot_coverage_pct:
            overshoot = (lot_cov - regs.max_lot_coverage_pct) / max(regs.max_lot_coverage_pct, 1.0)
            penalty *= max(0.1, 1.0 - overshoot * 2.0)

        # Soft constraint: open space
        if open_space < regs.min_open_space_pct:
            shortfall = (regs.min_open_space_pct - open_space) / max(regs.min_open_space_pct, 1.0)
            penalty *= max(0.1, 1.0 - shortfall * 2.0)

        # Hard constraints that MUST be zero (absolute physical limits)
        for b in buildings:
            if b["stories"] > regs.max_stories:
                self._track_fail(f"stories({b['stories']}>{regs.max_stories})")
                return 0.0
            if b["stories"] * 3.05 > regs.max_height_m:
                self._track_fail(f"height({b['stories']*3.05:.1f}>{regs.max_height_m})")
                return 0.0

        # Min separation: soft penalty
        min_sep = float("inf")
        for i in range(len(bldg_polys)):
            for j in range(i + 1, len(bldg_polys)):
                sep = self.geometry.compute_building_separation(bldg_polys[i], bldg_polys[j])
                min_sep = min(min_sep, sep)
        if len(bldg_polys) > 1 and min_sep < regs.min_building_separation_m:
            shortfall = (regs.min_building_separation_m - min_sep) / max(regs.min_building_separation_m, 0.1)
            penalty *= max(0.15, 1.0 - shortfall * 1.5)

        if log_this:
            logger.debug(
                "eval#%d PASS: far=%.3f, lot_cov=%.1f%%, open_space=%.1f%%, penalty=%.3f",
                self._eval_count, far, lot_cov, open_space, penalty,
            )

        raw_score = self.fitness_eval.evaluate(
            far=far,
            max_far=regs.max_far,
            lot_coverage=lot_cov,
            max_lot_coverage=regs.max_lot_coverage_pct,
            open_space_pct=open_space,
            min_separation=min_sep if len(bldg_polys) > 1 else 100.0,
            total_units=self._estimate_units(buildings, request),
            # Phase 8.6: include SG floor area in total GFA so fitness
            # rewards SG layouts (the Staffelgeschoss is real Wohnfläche
            # the developer monetises).
            total_gfa=sum(
                p.area * bl["stories"] + (
                    max(bl["width"] - 4.0, 1.0) * max(bl["depth"] - 4.0, 1.0)
                    if bl.get("has_staffel") else 0
                )
                for p, bl in zip(bldg_polys, buildings)
            ),
            weights=request.weights,
            plot_area=plot_area,
        )

        return raw_score * penalty

    def _apply_fitness_sharing(
        self,
        population: list[Chromosome],
        fitness_scores: list[float],
        sigma: float = 0.3,
    ) -> list[float]:
        """Fitness sharing to maintain population diversity.

        Individuals close together in genotype space share their fitness,
        reducing the reward for crowding into one region of the search space.
        sigma controls the sharing radius in normalized gene space.
        """
        n = len(population)
        shared = list(fitness_scores)  # copy

        for i in range(n):
            if fitness_scores[i] <= 0:
                continue
            niche_count = 1.0
            for j in range(n):
                if i == j or fitness_scores[j] <= 0:
                    continue
                dist = self._genotype_distance(population[i], population[j])
                if dist < sigma:
                    # Triangular sharing function
                    niche_count += 1.0 - (dist / sigma)
            shared[i] = fitness_scores[i] / niche_count

        return shared

    def _abstand_penalty(
        self,
        envelope: Polygon,
        plot_polygon: Polygon,
        fail_tag: str,
    ) -> float:
        """Multiplicative penalty for an Abstandsflächen envelope that
        doesn't lie within the plot. Returns:
          • 1.0  → fully contained, no penalty
          • 0.0  → reject this chromosome entirely (overflow ≥ 30 % of
                   the envelope area is unrecoverable)
          • r²   → soft penalty in (0, 1) where r = 1 − overflow_ratio
        """
        if plot_polygon.contains(envelope):
            return 1.0
        try:
            overflow = envelope.difference(plot_polygon).area
        except Exception:
            overflow = 0.0
        ratio = max(0.0, 1.0 - overflow / max(envelope.area, 0.01))
        if ratio < 0.7:
            self._track_fail(fail_tag)
            return 0.0
        return ratio ** 2

    @staticmethod
    def _genotype_distance(a: Chromosome, b: Chromosome) -> float:
        """Euclidean distance in normalized gene space between two chromosomes."""
        max_len = max(len(a.genes), len(b.genes))
        if max_len == 0:
            return 0.0
        total = 0.0
        for i in range(max_len):
            if i < len(a.genes) and i < len(b.genes):
                ga, gb = a.genes[i], b.genes[i]
                total += (ga.x - gb.x) ** 2 + (ga.y - gb.y) ** 2
                total += (ga.width - gb.width) ** 2 + (ga.depth - gb.depth) ** 2
                total += (ga.rotation - gb.rotation) ** 2 + (ga.stories - gb.stories) ** 2
            else:
                # Penalty for mismatched building count
                total += 1.0
        return (total / max_len) ** 0.5

    def _track_fail(self, reason: str):
        # Simplify parameterized reasons for aggregation
        key = reason.split("(")[0]
        self._fail_reasons[key] = self._fail_reasons.get(key, 0) + 1
        # Periodically log failure distribution
        total = sum(self._fail_reasons.values())
        if total % 500 == 0:
            logger.info("Failure distribution after %d fails: %s", total, self._fail_reasons)

    def _decode_buildings(
        self,
        chromosome: Chromosome,
        buildable: Polygon,
        request: OptimizationRequest,
    ) -> list[dict]:
        bounds = buildable.bounds
        min_x, min_y, max_x, max_y = bounds
        bx_range = max_x - min_x
        by_range = max_y - min_y

        min_dim = 9.0   # ~9 meters minimum building dimension
        max_dim_w = min(bx_range * 0.7, 60.0)  # max ~60m
        max_dim_d = min(by_range * 0.7, 60.0)

        buildings = []
        for gene in chromosome.genes:
            x = min_x + gene.x * bx_range
            y = min_y + gene.y * by_range
            width = min_dim + gene.width * (max_dim_w - min_dim)
            depth = min_dim + gene.depth * (max_dim_d - min_dim)
            rotation = gene.rotation * 45.0 - 22.5  # -22.5 to +22.5 degrees
            raw_stories = max(1, int(gene.stories * request.regulations.max_stories) + 1)
            raw_stories = min(raw_stories, request.regulations.max_stories)

            # Phase 8.6 fix: SG counts toward the total story budget.
            # When SG is enabled we reserve one storey for it so the
            # §6 envelope (which grows with TOTAL height) doesn't get
            # systematically pushed past the plot edge. Without this
            # adjustment SG layouts always lost the §6 ⊂ plot test.
            has_staffel_raw = gene.has_staffel >= 0.5
            if has_staffel_raw and raw_stories >= 2:
                stories = raw_stories - 1
                has_staffel = True
            else:
                stories = raw_stories
                has_staffel = False

            buildings.append({
                "x": x, "y": y,
                "width": width, "depth": depth,
                "rotation": rotation, "stories": stories,
                "footprint_area": width * depth,
                "has_staffel": has_staffel,
            })
        return buildings

    def _estimate_units(self, buildings: list[dict], request: OptimizationRequest) -> int:
        total = 0
        avg_unit_size = (
            request.regulations.min_unit_sizes.studio_sqm * request.unit_mix_preference.studio_pct
            + request.regulations.min_unit_sizes.one_bed_sqm * request.unit_mix_preference.one_bed_pct
            + request.regulations.min_unit_sizes.two_bed_sqm * request.unit_mix_preference.two_bed_pct
            + request.regulations.min_unit_sizes.three_bed_sqm * request.unit_mix_preference.three_bed_pct
        )
        # Phase 8.6 fix: include the Staffelgeschoss floor in the
        # estimated unit count so the GA actually sees the upside of
        # picking SG. Without this, fitness only credited the lower
        # stories' NFA, so SG was strictly worse than non-SG (it could
        # only fail the §6 check, never gain reward).
        SG_SETBACK_M = 2.0
        for b in buildings:
            nfa = b["footprint_area"] * b["stories"] * 0.85
            if b.get("has_staffel"):
                sg_w = max(b["width"] - 2 * SG_SETBACK_M, 1.0)
                sg_d = max(b["depth"] - 2 * SG_SETBACK_M, 1.0)
                nfa += sg_w * sg_d * 0.85
            total += int(nfa / avg_unit_size)
        return total

    def _chromosome_to_layout(
        self,
        chromosome: Chromosome,
        buildable: Polygon,
        plot_polygon: Polygon,
        plot_area: float,
        request: OptimizationRequest,
        rank: int,
    ) -> LayoutOption | None:
        buildings_data = self._decode_buildings(chromosome, buildable, request)
        if not buildings_data:
            return None

        bldg_polys = [
            self.geometry.create_building_polygon(
                b["x"], b["y"], b["width"], b["depth"], b["rotation"]
            )
            for b in buildings_data
        ]

        # Validate all fit within buildable area
        for poly in bldg_polys:
            if not self.geometry.fits_within(poly, buildable):
                return None

        # Validate no buildings overlap each other
        for i in range(len(bldg_polys)):
            for j in range(i + 1, len(bldg_polys)):
                if self.geometry.check_overlap(bldg_polys[i], bldg_polys[j]):
                    return None

        building_footprints: list[BuildingFootprint] = []
        regs = request.regulations
        pref = request.unit_mix_preference

        for i, (b, poly) in enumerate(zip(buildings_data, bldg_polys)):
            # Dimensions are already in meters (geometry engine works in meters)
            width_m = b["width"]
            depth_m = b["depth"]
            has_staffel = bool(b.get("has_staffel"))
            sg_setback = 2.0
            # GFA: full-footprint floors + (if SG) one extra floor with
            # the symmetric setback footprint. This matches what the
            # FP generator and 3D viewer will actually build.
            gfa_sqm = poly.area * b["stories"]
            if has_staffel:
                sg_w = max(width_m - 2 * sg_setback, 1.0)
                sg_d = max(depth_m - 2 * sg_setback, 1.0)
                gfa_sqm += sg_w * sg_d
            nfa_sqm = gfa_sqm * 0.85
            unit_mix = self._generate_unit_mix(nfa_sqm, pref, regs)

            # SG adds one extra storey at reduced footprint. We bake the
            # extra storey into total_height_m so downstream consumers
            # (thermal envelope, IFC exporter, viewer) see the real
            # building height.
            extra_stories = 1 if has_staffel else 0
            building_footprints.append(BuildingFootprint(
                id=f"bldg-{i+1}",
                position_x=b["x"],
                position_y=b["y"],
                width_m=width_m,
                depth_m=depth_m,
                rotation_deg=b["rotation"],
                stories=b["stories"],
                floor_height_m=3.05,
                total_height_m=(b["stories"] + extra_stories) * 3.05,
                gross_floor_area_sqm=gfa_sqm,
                net_floor_area_sqm=nfa_sqm,
                efficiency_factor=0.85,
                unit_mix=unit_mix,
                ground_floor_parking=b["stories"] >= 3,
                has_staffelgeschoss=has_staffel,
                staffelgeschoss_setback_m=sg_setback,
            ))

        lot_cov = self.geometry.compute_lot_coverage(bldg_polys, plot_area)
        far_data = [
            {"footprint_area": poly.area, "stories": b["stories"]}
            for poly, b in zip(bldg_polys, buildings_data)
        ]
        far = self.geometry.compute_far(far_data, plot_area)
        open_space = self.geometry.compute_open_space_pct(bldg_polys, plot_polygon)

        min_sep = float("inf")
        for i in range(len(bldg_polys)):
            for j in range(i + 1, len(bldg_polys)):
                sep = self.geometry.compute_building_separation(bldg_polys[i], bldg_polys[j])
                min_sep = min(min_sep, sep)
        if min_sep == float("inf"):
            min_sep = 0.0

        total_units = sum(
            bf.unit_mix.total_units if bf.unit_mix else 0 for bf in building_footprints
        )
        total_res_sqm = sum(
            bf.unit_mix.total_residential_sqm if bf.unit_mix else 0
            for bf in building_footprints
        )

        reg_check = self.reg_engine.check_compliance(
            buildings=building_footprints,
            plot_area_sqm=plot_area,
            lot_coverage_pct=lot_cov,
            open_space_pct=open_space,
            regs=regs,
            min_separation_m=min_sep,
        )

        return LayoutOption(
            id=str(uuid.uuid4()),
            rank=rank,
            buildings=building_footprints,
            scores=LayoutScores(
                overall=0.0,
                efficiency=far / regs.max_far if regs.max_far > 0 else 0,
                financial=total_units * 0.01,
                livability=min(1.0, min_sep / 15.0) if min_sep > 0 else 0.5,
                compliance=1.0 if reg_check.is_compliant else 0.0,
            ),
            regulation_check=reg_check,
            total_units=total_units,
            total_residential_sqm=total_res_sqm,
            total_commercial_sqm=0.0,
            total_parking_spaces=int(reg_check.total_parking_provided),
            far_achieved=far,
            lot_coverage_pct=lot_cov,
            open_space_pct=open_space,
            building_separation_min_m=min_sep,
        )

    def _generate_unit_mix(
        self, net_floor_area_sqm: float, pref, regs
    ) -> UnitMix:
        entries: list[UnitMixEntry] = []
        allocations = [
            ("studio", pref.studio_pct, regs.min_unit_sizes.studio_sqm),
            ("1br", pref.one_bed_pct, regs.min_unit_sizes.one_bed_sqm),
            ("2br", pref.two_bed_pct, regs.min_unit_sizes.two_bed_sqm),
            ("3br", pref.three_bed_pct, regs.min_unit_sizes.three_bed_sqm),
        ]

        total_units = 0
        total_res_sqm = 0.0

        for unit_type, pct, min_size in allocations:
            area_for_type = net_floor_area_sqm * pct
            count = max(0, int(area_for_type / min_size))
            total_sqm = count * min_size
            entries.append(UnitMixEntry(
                unit_type=unit_type,
                count=count,
                avg_sqm=min_size,
                total_sqm=total_sqm,
            ))
            total_units += count
            total_res_sqm += total_sqm

        return UnitMix(
            entries=entries,
            total_units=total_units,
            total_residential_sqm=total_res_sqm,
            total_commercial_sqm=0.0,
        )

    def _layout_fingerprint(self, layout: LayoutOption) -> str:
        """Coarse fingerprint: round to 6m grid for deduplication."""
        parts = []
        grid = 6.0  # round positions to nearest 6m
        for b in sorted(layout.buildings, key=lambda x: (x.position_x, x.position_y)):
            rx = round(b.position_x / grid) * grid
            ry = round(b.position_y / grid) * grid
            rw = round(b.width_m)
            rd = round(b.depth_m)
            parts.append(f"{rw}x{rd}x{b.stories}@{rx},{ry}")
        return f"{len(layout.buildings)}|" + "|".join(parts)
