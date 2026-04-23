/**
 * DIN 18040-2 barrier-free validator for ground-floor apartments
 * (Phase 5f).
 *
 * BauO NRW §50 requires ground-floor apartments in multi-story
 * residential buildings to be barrier-free per DIN 18040-2. The
 * generator already flags the ground floor (`floor_type === "ground"`)
 * and forces barrier-free bathrooms + exterior entrance doors, but
 * nothing currently validates that the finished layout actually meets
 * DIN 18040-2's minimum dimensions.
 *
 * Checks (all from DIN 18040-2:2011-09):
 *
 *   - **Main entrance door** ≥ 0.90 m clear width (§5.3.1)
 *   - **Interior doors** ≥ 0.80 m clear width (§4.3.3.1 standard R)
 *   - **Bathroom turning area** ≥ 1.50 m × 1.50 m free of fixtures
 *     (§5.3.2 — inscribed bbox min side is our proxy; Goldbeck rooms
 *     are rectangular so bbox = polygon extent)
 *   - **Corridors / hallways** ≥ 1.20 m clear width (§4.3.4 standard R)
 *
 * The stricter "R" standard (wheelchair-accessible / rollstuhlgerecht)
 * raises entrance to 0.90 m and turning to 1.50 m — those are the BauO
 * NRW targets, so we use them.
 *
 * Ground-floor-only: upper floors skip this module entirely.
 */

import type {
  FloorPlan,
  FloorPlanApartment,
  FloorPlanRoom,
  DoorPlacement,
} from "@/types/api";

// ── Constants ─────────────────────────────────────────────────────

/** Clear width for the main apartment entrance door [m] — DIN 18040-2 §5.3.1. */
export const BF_MAIN_ENTRANCE_MIN_WIDTH_M = 0.9;

/** Clear width for interior doors [m] — DIN 18040-2 §4.3.3.1 R. */
export const BF_INTERIOR_DOOR_MIN_WIDTH_M = 0.8;

/** Required Bewegungsfläche in bathroom [m × m] — DIN 18040-2 §5.3.2. */
export const BF_BATHROOM_TURNING_CIRCLE_M = 1.5;

/** Corridor min clear width [m] — DIN 18040-2 §4.3.4 R. */
export const BF_CORRIDOR_MIN_WIDTH_M = 1.2;

/** Tolerance — accept measurements within 2cm of the limit as pass
 *  (real construction tolerances on precast are ±5-10mm). */
const TOL_M = 0.02;

// ── Types ─────────────────────────────────────────────────────────

export interface BarrierFreeIssue {
  code:
    | "bf_entrance_door_narrow"
    | "bf_interior_door_narrow"
    | "bf_bathroom_turning_area"
    | "bf_corridor_narrow";
  severity: "error" | "warn";
  /** Apartment scope, if known. */
  apartmentId?: string;
  /** Room / door / wall scope, if known. */
  subjectId?: string;
  message: string;
  /** Measured value [m]. */
  measuredM: number;
  /** Required value [m]. */
  requiredM: number;
}

export interface BarrierFreeAnalysis {
  issues: BarrierFreeIssue[];
  errorCount: number;
  warnCount: number;
  /** Number of ground-floor apartments evaluated. 0 means the floor
   *  is not ground and the check was skipped. */
  apartmentsChecked: number;
}

// ── Geometry helpers ──────────────────────────────────────────────

/** Shortest side of the axis-aligned bbox of a polygon [m]. For the
 *  rectangular rooms the Goldbeck generator emits, this equals the
 *  inscribed-rect shortest side; for non-rect polygons it's an upper
 *  bound so we only under-report violations. */
function polygonBboxMinSide(poly: Array<{ x: number; y: number }>): number {
  if (!poly || poly.length < 3) return 0;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.min(maxX - minX, maxY - minY);
}

// ── Main analyzer ─────────────────────────────────────────────────

/** Returns `true` when the given plan is the ground floor and should
 *  be subjected to BauO NRW §50 / DIN 18040-2. */
export function isGroundFloor(plan: FloorPlan): boolean {
  return plan.floor_type === "ground" || plan.floor_index === 0;
}

export function analyzeBarrierFree(plan: FloorPlan): BarrierFreeAnalysis {
  const issues: BarrierFreeIssue[] = [];

  if (!isGroundFloor(plan)) {
    return { issues, errorCount: 0, warnCount: 0, apartmentsChecked: 0 };
  }

  const doorById = new Map<string, DoorPlacement>(
    (plan.doors ?? []).map((d) => [d.id, d]),
  );
  const apartments: FloorPlanApartment[] = plan.apartments ?? [];

  // Track which doors are entrance doors so the interior-door check
  // can skip them (entrance has its own, stricter, check).
  const entranceDoorIds = new Set<string>();
  for (const apt of apartments) {
    if (apt.entrance_door_id) entranceDoorIds.add(apt.entrance_door_id);
  }

  // 1. Entrance door clear width per apartment.
  for (const apt of apartments) {
    const door = doorById.get(apt.entrance_door_id);
    if (!door) continue;
    if (door.width_m + TOL_M < BF_MAIN_ENTRANCE_MIN_WIDTH_M) {
      issues.push({
        code: "bf_entrance_door_narrow",
        severity: "error",
        apartmentId: apt.id,
        subjectId: door.id,
        measuredM: door.width_m,
        requiredM: BF_MAIN_ENTRANCE_MIN_WIDTH_M,
        message: `Wohnungstür ${door.width_m.toFixed(2)} m < ${BF_MAIN_ENTRANCE_MIN_WIDTH_M.toFixed(2)} m (DIN 18040-2 §5.3.1)`,
      });
    }
  }

  // 2. Interior door clear width (all non-entrance doors on this floor).
  for (const door of plan.doors ?? []) {
    if (entranceDoorIds.has(door.id)) continue;
    if (door.width_m + TOL_M < BF_INTERIOR_DOOR_MIN_WIDTH_M) {
      // Assign to apartment by owning room: find the nearest room whose
      // polygon bbox contains the door position (best-effort).
      const owningApt = findApartmentContainingPoint(apartments, door.position);
      issues.push({
        code: "bf_interior_door_narrow",
        severity: "warn",
        apartmentId: owningApt?.id,
        subjectId: door.id,
        measuredM: door.width_m,
        requiredM: BF_INTERIOR_DOOR_MIN_WIDTH_M,
        message: `Innentür ${door.width_m.toFixed(2)} m < ${BF_INTERIOR_DOOR_MIN_WIDTH_M.toFixed(2)} m (DIN 18040-2 §4.3.3)`,
      });
    }
  }

  // 3. Bathroom turning area — every bathroom room in every apt.
  for (const apt of apartments) {
    const bathrooms: FloorPlanRoom[] = apt.rooms.filter(
      (r) => r.room_type === "bathroom",
    );
    for (const bath of bathrooms) {
      const minSide = polygonBboxMinSide(bath.polygon);
      if (minSide + TOL_M < BF_BATHROOM_TURNING_CIRCLE_M) {
        issues.push({
          code: "bf_bathroom_turning_area",
          severity: "error",
          apartmentId: apt.id,
          subjectId: bath.id,
          measuredM: minSide,
          requiredM: BF_BATHROOM_TURNING_CIRCLE_M,
          message: `Bad ${minSide.toFixed(2)} m kürzeste Kante < ${BF_BATHROOM_TURNING_CIRCLE_M.toFixed(2)} m Bewegungsfläche (DIN 18040-2 §5.3.2)`,
        });
      }
    }
  }

  // 4. Corridor / hallway clear width — all corridor + hallway rooms.
  //    Floor-scope (not per-apt) because Goldbeck Ganghaus corridors
  //    are shared circulation, not apt-owned.
  for (const room of plan.rooms ?? []) {
    if (room.room_type !== "corridor" && room.room_type !== "hallway") continue;
    const minSide = polygonBboxMinSide(room.polygon);
    if (minSide + TOL_M < BF_CORRIDOR_MIN_WIDTH_M) {
      issues.push({
        code: "bf_corridor_narrow",
        severity: "error",
        apartmentId: room.apartment_id,
        subjectId: room.id,
        measuredM: minSide,
        requiredM: BF_CORRIDOR_MIN_WIDTH_M,
        message: `Flur ${minSide.toFixed(2)} m < ${BF_CORRIDOR_MIN_WIDTH_M.toFixed(2)} m lichte Breite (DIN 18040-2 §4.3.4)`,
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warn").length;

  return {
    issues,
    errorCount,
    warnCount,
    apartmentsChecked: apartments.length,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function findApartmentContainingPoint(
  apartments: FloorPlanApartment[],
  p: { x: number; y: number },
): FloorPlanApartment | undefined {
  // Best-effort: check each apt's rooms' bbox. Cheap; entrance doors
  // typically sit on an exterior wall close to the entry corridor,
  // so the owning apt is whichever room's inflated bbox the door
  // position falls in.
  const INFLATE = 0.4;
  for (const apt of apartments) {
    for (const room of apt.rooms) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const v of room.polygon) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
      }
      if (
        p.x >= minX - INFLATE &&
        p.x <= maxX + INFLATE &&
        p.y >= minY - INFLATE &&
        p.y <= maxY + INFLATE
      ) {
        return apt;
      }
    }
  }
  return undefined;
}
