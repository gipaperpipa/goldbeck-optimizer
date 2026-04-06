#!/usr/bin/env python3
"""Diagnose optimizer fitness flatline.

Runs a small optimization and dumps per-generation stats to identify:
  1. What fraction of chromosomes fail generation entirely (fitness=0)?
  2. How spread are non-zero fitness values? (std dev, min, max)
  3. Does the population lose diversity? (unique signatures per gen)
  4. Which fitness criteria are "stuck" (same score for every individual)?
  5. Are mutations producing meaningfully different plans?

Usage:
    cd backend && python -m scripts.diagnose_optimizer
"""

import sys
import os
import json
import statistics

# Add project root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models.floorplan import (
    FloorPlanRequest, FloorPlanWeights, AccessType,
)
from app.services.floorplan.optimizer import (
    FloorPlanChromosome, FloorPlanOptimizer,
    generate_variant, _evaluate_floor_plan, _plan_signature,
    _mutate, _crossover, NUM_RASTER_PREFS,
)
from app.services.floorplan import goldbeck_constants as C


def build_test_request() -> FloorPlanRequest:
    """Standard test: 30m x 12m Ganghaus, 4 stories."""
    return FloorPlanRequest(
        building_id="diag_test",
        building_width_m=30.0,
        building_depth_m=12.0,
        stories=4,
        rotation_deg=0.0,
        population_size=20,
        generations=30,
        weights=FloorPlanWeights(),
    )


def test_generation_failure_rate():
    """How many random chromosomes fail to generate any plan?"""
    request = build_test_request()
    n = 50
    successes = 0
    fail_reasons = []

    for i in range(n):
        chrom = FloorPlanChromosome()
        try:
            plans = generate_variant(request, chrom)
            if plans and plans.floor_plans:
                successes += 1
            else:
                fail_reasons.append("empty_result")
        except Exception as e:
            fail_reasons.append(str(e)[:80])

    print(f"\n{'='*60}")
    print(f"TEST 1: Generation Failure Rate")
    print(f"{'='*60}")
    print(f"  Attempts: {n}")
    print(f"  Successes: {successes} ({successes/n*100:.0f}%)")
    print(f"  Failures: {n - successes} ({(n-successes)/n*100:.0f}%)")
    if fail_reasons:
        from collections import Counter
        for reason, count in Counter(fail_reasons).most_common(5):
            print(f"    - {reason}: {count}")
    return successes / n


def test_fitness_spread():
    """How spread are fitness scores across random chromosomes?"""
    request = build_test_request()
    weights = FloorPlanWeights()
    n = 30
    scores = []
    breakdowns = []

    for i in range(n):
        chrom = FloorPlanChromosome()
        plans = generate_variant(request, chrom)
        if plans and plans.floor_plans:
            fitness, bd = _evaluate_floor_plan(plans, request, weights)
            scores.append(fitness)
            breakdowns.append(bd)

    print(f"\n{'='*60}")
    print(f"TEST 2: Fitness Score Spread")
    print(f"{'='*60}")
    if not scores:
        print("  No successful generations!")
        return

    print(f"  Samples: {len(scores)}")
    print(f"  Min:    {min(scores):.2f}")
    print(f"  Max:    {max(scores):.2f}")
    print(f"  Mean:   {statistics.mean(scores):.2f}")
    print(f"  Median: {statistics.median(scores):.2f}")
    print(f"  StdDev: {statistics.stdev(scores):.2f}" if len(scores) > 1 else "")
    print(f"  Range:  {max(scores) - min(scores):.2f}")

    # Check per-criterion variance
    print(f"\n  Per-criterion breakdown (mean ± stdev):")
    all_keys = sorted(breakdowns[0].keys()) if breakdowns else []
    for key in all_keys:
        vals = [bd[key] for bd in breakdowns if key in bd]
        if vals:
            m = statistics.mean(vals)
            s = statistics.stdev(vals) if len(vals) > 1 else 0
            # Flag criteria with near-zero variance (stuck)
            flag = " *** STUCK" if s < 0.3 else ""
            print(f"    {key:30s}: {m:6.2f} ± {s:5.2f}{flag}")


def test_mutation_effectiveness():
    """Does mutation produce meaningfully different plans?"""
    request = build_test_request()
    weights = FloorPlanWeights()

    # Generate a parent
    parent = FloorPlanChromosome()
    parent_plans = generate_variant(request, parent)
    if not parent_plans:
        print("\n  Parent generation failed, skipping mutation test")
        return

    parent_fitness, _ = _evaluate_floor_plan(parent_plans, request, weights)
    parent_sig = _plan_signature(parent_plans)

    n_mutations = 30
    different_sigs = 0
    fitness_deltas = []

    print(f"\n{'='*60}")
    print(f"TEST 3: Mutation Effectiveness")
    print(f"{'='*60}")
    print(f"  Parent fitness: {parent_fitness:.2f}")
    print(f"  Parent signature: {parent_sig}")

    for i in range(n_mutations):
        child = _mutate(parent.clone(), rate=0.25, generation=5, total_generations=30)
        child_plans = generate_variant(request, child)
        if child_plans and child_plans.floor_plans:
            child_fitness, _ = _evaluate_floor_plan(child_plans, request, weights)
            child_sig = _plan_signature(child_plans)
            fitness_deltas.append(child_fitness - parent_fitness)
            if child_sig != parent_sig:
                different_sigs += 1
        else:
            fitness_deltas.append(-parent_fitness)  # generation failure = total loss

    print(f"  Mutations tested: {n_mutations}")
    print(f"  Different signatures: {different_sigs}/{n_mutations} ({different_sigs/n_mutations*100:.0f}%)")
    if fitness_deltas:
        print(f"  Fitness delta mean: {statistics.mean(fitness_deltas):+.2f}")
        print(f"  Fitness delta stdev: {statistics.stdev(fitness_deltas):.2f}")
        improving = sum(1 for d in fitness_deltas if d > 0)
        print(f"  Improving mutations: {improving}/{len(fitness_deltas)} ({improving/len(fitness_deltas)*100:.0f}%)")


def test_crossover_effectiveness():
    """Does crossover produce children different from parents?"""
    request = build_test_request()
    weights = FloorPlanWeights()

    # Generate two parents
    parents = []
    for _ in range(10):
        chrom = FloorPlanChromosome()
        plans = generate_variant(request, chrom)
        if plans and plans.floor_plans:
            fitness, _ = _evaluate_floor_plan(plans, request, weights)
            chrom.fitness = fitness
            chrom.raw_fitness = fitness
            chrom._plan_sig = _plan_signature(plans)
            parents.append(chrom)
        if len(parents) >= 2:
            break

    if len(parents) < 2:
        print("\n  Need at least 2 parents, skipping crossover test")
        return

    print(f"\n{'='*60}")
    print(f"TEST 4: Crossover Effectiveness")
    print(f"{'='*60}")
    print(f"  Parent A fitness: {parents[0].raw_fitness:.2f}, sig: {parents[0]._plan_sig}")
    print(f"  Parent B fitness: {parents[1].raw_fitness:.2f}, sig: {parents[1]._plan_sig}")

    n = 20
    new_sigs = 0
    child_scores = []
    for _ in range(n):
        child = _crossover(parents[0], parents[1])
        child_plans = generate_variant(request, child)
        if child_plans and child_plans.floor_plans:
            f, _ = _evaluate_floor_plan(child_plans, request, weights)
            child_scores.append(f)
            sig = _plan_signature(child_plans)
            if sig != parents[0]._plan_sig and sig != parents[1]._plan_sig:
                new_sigs += 1

    print(f"  Children tested: {n}")
    print(f"  Novel signatures: {new_sigs}/{n}")
    if child_scores:
        print(f"  Child fitness range: {min(child_scores):.2f} - {max(child_scores):.2f}")
        print(f"  Child fitness mean: {statistics.mean(child_scores):.2f}")


def test_dimension_offset_impact():
    """How much do dim_offset and depth_offset affect results?"""
    request = build_test_request()
    weights = FloorPlanWeights()

    print(f"\n{'='*60}")
    print(f"TEST 5: Dimension Offset Impact")
    print(f"{'='*60}")
    print(f"  Requested: {request.building_width_m}m x {request.building_depth_m}m")

    # dim_offset can only SHRINK (clamped to min(0, ...))
    # This means if all chromosomes shrink, they're all generating smaller buildings
    for offset in [-3.0, -1.5, 0.0]:
        chrom = FloorPlanChromosome.make_seeded(0.5)
        chrom.dim_offset = offset
        chrom.depth_offset = offset
        plans = generate_variant(request, chrom)
        if plans:
            actual_w = plans.building_width_m
            actual_d = plans.building_depth_m
            f, bd = _evaluate_floor_plan(plans, request, weights)
            dim_conf = bd.get("dimension_conformance", 0)
            print(f"  offset={offset:+.1f} → actual {actual_w:.1f}x{actual_d:.1f}m, "
                  f"fitness={f:.2f}, dim_conformance={dim_conf:.2f}")


def test_mini_evolution():
    """Run a mini evolution and track per-generation stats."""
    request = build_test_request()
    request.population_size = 20
    request.generations = 20

    print(f"\n{'='*60}")
    print(f"TEST 6: Mini Evolution (pop={request.population_size}, gen={request.generations})")
    print(f"{'='*60}")

    gen_stats = []

    def callback(gen, total, best, avg, preview=None):
        gen_stats.append({"gen": gen, "best": best, "avg": avg})
        delta_best = best - gen_stats[-2]["best"] if len(gen_stats) > 1 else 0
        print(f"  Gen {gen:3d}/{total}: best={best:6.2f} (Δ{delta_best:+.2f}), avg={avg:6.2f}")

    optimizer = FloorPlanOptimizer()
    variants = optimizer.optimize(request, progress_callback=callback)

    print(f"\n  Final variants: {len(variants)}")
    for v in variants[:5]:
        print(f"    Rank {v.rank}: fitness={v.fitness_score:.2f}")
        # Show key breakdown items
        for k in ["net_to_gross", "circulation_efficiency", "unit_mix_match",
                   "dimension_conformance", "connectivity", "furniture"]:
            print(f"      {k}: {v.fitness_breakdown.get(k, 0):.2f}")

    # Check for flatline
    if len(gen_stats) > 5:
        early = gen_stats[2]["best"]
        late = gen_stats[-1]["best"]
        improvement = late - early
        print(f"\n  Improvement from gen 2 to {gen_stats[-1]['gen']}: {improvement:+.2f}")
        if improvement < 1.0:
            print("  *** FLATLINE DETECTED — less than 1.0 improvement over entire run ***")


if __name__ == "__main__":
    print("Goldbeck Optimizer Diagnostic Report")
    print("=" * 60)

    test_generation_failure_rate()
    test_fitness_spread()
    test_mutation_effectiveness()
    test_crossover_effectiveness()
    test_dimension_offset_impact()
    test_mini_evolution()

    print(f"\n{'='*60}")
    print("DIAGNOSTIC COMPLETE")
    print("=" * 60)
