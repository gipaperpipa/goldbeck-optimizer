#!/usr/bin/env python3
"""Run the validation suite against generated floor plans.

Generates floor plans for several test scenarios and checks each one
against all building code validation rules. Reports a summary of
errors and warnings per scenario.

Usage:
    cd backend && python -m scripts.run_validation
    cd backend && python -m scripts.run_validation --verbose
    cd backend && python -m scripts.run_validation --scenario ganghaus_30x12
"""

import sys
import os
import argparse
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models.floorplan import FloorPlanRequest, FloorPlanWeights, AccessType
from app.services.floorplan.registry import get_system
from app.services.floorplan.validation import validate_building, Severity


# ============================================================
# Test scenarios — representative building configurations
# ============================================================

SCENARIOS: dict[str, FloorPlanRequest] = {
    "ganghaus_30x12": FloorPlanRequest(
        building_id="test_ganghaus_30x12",
        building_width_m=30.0,
        building_depth_m=12.0,
        stories=4,
        rotation_deg=0.0,
    ),
    "ganghaus_45x12": FloorPlanRequest(
        building_id="test_ganghaus_45x12",
        building_width_m=45.0,
        building_depth_m=12.0,
        stories=4,
        rotation_deg=0.0,
    ),
    "ganghaus_24x10": FloorPlanRequest(
        building_id="test_ganghaus_24x10",
        building_width_m=24.0,
        building_depth_m=10.0,
        stories=3,
        rotation_deg=0.0,
    ),
    "laubengang_30x8": FloorPlanRequest(
        building_id="test_laubengang_30x8",
        building_width_m=30.0,
        building_depth_m=8.0,
        stories=4,
        rotation_deg=0.0,
    ),
    "spaenner_15x10": FloorPlanRequest(
        building_id="test_spaenner_15x10",
        building_width_m=15.0,
        building_depth_m=10.0,
        stories=3,
        rotation_deg=0.0,
        access_type_override=AccessType.SPAENNER,
    ),
    "large_ganghaus_60x12": FloorPlanRequest(
        building_id="test_large_60x12",
        building_width_m=60.0,
        building_depth_m=12.0,
        stories=5,
        rotation_deg=0.0,
    ),
    "small_ganghaus_18x10": FloorPlanRequest(
        building_id="test_small_18x10",
        building_width_m=18.0,
        building_depth_m=10.0,
        stories=3,
        rotation_deg=0.0,
    ),
}


def run_scenario(name: str, request: FloorPlanRequest, verbose: bool = False) -> dict:
    """Generate a floor plan and run validation. Returns summary."""
    system = get_system(request.construction_system)

    print(f"\n{'='*60}")
    print(f"SCENARIO: {name}")
    print(f"  Dimensions: {request.building_width_m}m x {request.building_depth_m}m")
    print(f"  Stories: {request.stories}")
    print(f"  Access override: {request.access_type_override or 'auto'}")
    print(f"{'='*60}")

    start = time.time()
    try:
        plans = system.generate_floor_plans(request)
    except Exception as e:
        print(f"  GENERATION FAILED: {e}")
        return {"status": "generation_failed", "error": str(e)}

    gen_time = time.time() - start

    if not plans or not plans.floor_plans:
        print(f"  GENERATION FAILED: Empty result")
        return {"status": "empty_result"}

    print(f"  Generated in {gen_time:.2f}s")
    print(f"  Access type: {plans.access_type.value}")
    print(f"  Apartments: {plans.total_apartments}")
    print(f"  Floors: {len(plans.floor_plans)}")
    print(f"  Bay widths: {plans.structural_grid.bay_widths}")

    # Run validation
    start = time.time()
    report = validate_building(plans)
    val_time = time.time() - start

    summary = report.summary
    print(f"\n  Validation ({val_time*1000:.0f}ms): "
          f"{summary['errors']} errors, {summary['warnings']} warnings, {summary['info']} info")
    print(f"  COMPLIANT: {'YES' if report.is_compliant else 'NO'}")

    if verbose or report.errors:
        # Always show errors
        if report.errors:
            print(f"\n  ERRORS:")
            for r in report.errors:
                print(f"    {r}")

        if verbose and report.warnings:
            print(f"\n  WARNINGS:")
            for r in report.warnings:
                print(f"    {r}")

    # Group errors by check type
    error_types: dict[str, int] = {}
    for r in report.errors:
        error_types[r.check] = error_types.get(r.check, 0) + 1
    if error_types:
        print(f"\n  Error breakdown: {error_types}")

    return {
        "status": "ok",
        "compliant": report.is_compliant,
        "errors": summary["errors"],
        "warnings": summary["warnings"],
        "error_types": error_types,
        "apartments": plans.total_apartments,
        "access_type": plans.access_type.value,
    }


def main():
    parser = argparse.ArgumentParser(description="Run floor plan validation suite")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show all warnings")
    parser.add_argument("--scenario", "-s", help="Run only this scenario")
    args = parser.parse_args()

    print("Goldbeck Floor Plan Validation Suite")
    print("=" * 60)

    scenarios = SCENARIOS
    if args.scenario:
        if args.scenario not in SCENARIOS:
            print(f"Unknown scenario '{args.scenario}'. Available: {list(SCENARIOS.keys())}")
            sys.exit(1)
        scenarios = {args.scenario: SCENARIOS[args.scenario]}

    results = {}
    for name, request in scenarios.items():
        results[name] = run_scenario(name, request, verbose=args.verbose)

    # Final summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    total_pass = 0
    total_fail = 0
    total_gen_fail = 0
    for name, result in results.items():
        if result["status"] != "ok":
            status = "GENERATION FAILED"
            total_gen_fail += 1
        elif result["compliant"]:
            status = "PASS"
            total_pass += 1
        else:
            status = f"FAIL ({result['errors']} errors)"
            total_fail += 1
        print(f"  {name:30s}: {status}")

    print(f"\n  Passed: {total_pass}/{len(results)}")
    print(f"  Failed: {total_fail}/{len(results)}")
    if total_gen_fail:
        print(f"  Generation failed: {total_gen_fail}/{len(results)}")

    # Exit code: 0 if all pass, 1 if any fail
    sys.exit(0 if total_fail == 0 and total_gen_fail == 0 else 1)


if __name__ == "__main__":
    main()
