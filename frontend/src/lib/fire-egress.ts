/**
 * MBO §35 Rettungsweglänge check (Phase 5a).
 *
 * German building code (Musterbauordnung §35, and the corresponding
 * §35 in every Landesbauordnung) requires the first escape route
 * (Erster Rettungsweg) from any apartment entrance door to the
 * nearest staircase to be no longer than **35 m**, measured along the
 * traversable path (not euclidean). The nearest staircase must lead
 * outside, or to a second Rettungsweg.
 *
 * Pure geometric module — takes a `FloorPlan` and emits per-apartment
 * egress distance + pass/warn/fail verdict for `validatePlan()` to
 * turn into badges and a row in the validation panel.
 *
 * ## Approach
 *
 * Goldbeck floors have one of three access topologies, identified by
 * `FloorPlan.access_type`:
 *
 *   - **ganghaus**   — one long central corridor, rooms on both sides,
 *                      staircases near the ends.
 *   - **laubengang** — external gallery (no internal corridor).
 *   - **spaenner**   — staircase directly serves 2-4 apartments, no
 *                      corridor.
 *
 * For **ganghaus** we route along the corridor long-axis: the path is
 *   (perpendicular from door to corridor axis) + (along-axis distance
 *    from projection to staircase centroid).
 * For **spaenner** / **laubengang** we use Euclidean × routing factor
 * 1.15 (a conservative padding for the one or two turns a real path
 * takes in a Spänner entry hall).
 *
 * ## Thresholds
 *
 *   ≤ 30 m          → pass
 *   30 m < d ≤ 35 m → warn (approaching the §35 limit)
 *   > 35 m          → fail (§35 violation, blocks permit)
 */

import type { FloorPlan, DoorPlacement, FloorPlanStaircase } from "@/types/api";

// ── Constants ─────────────────────────────────────────────────────

/** MBO §35 absolute maximum Rettungsweglänge [m]. */
export const MAX_EGRESS_M = 35.0;

/** Below this, early warning triggers [m]. Chosen as ~85 % of the
 *  §35 limit — the planning-stage "start worrying" zone. */
export const WARN_EGRESS_M = 30.0;

/** Euclidean → routed distance factor for non-corridor topologies.
 *  Accounts for the one or two orthogonal turns a real escape path
 *  takes from an apt entrance to a Spänner-staircase landing. */
const ROUTING_FACTOR_NO_CORRIDOR = 1.15;

// ── Types ─────────────────────────────────────────────────────────

export interface EgressCheck {
  apartmentId: string;
  unitNumber: string;
  /** Apt entrance door position in plan coordinates [m]. */
  doorPosition: [number, number];
  /** The staircase that won the minimum routed distance. */
  nearestStaircaseId: string;
  /** Straight-line distance door → staircase centroid [m]. */
  euclideanDistanceM: number;
  /** Corridor-routed distance — the number MBO §35 cares about [m]. */
  routedDistanceM: number;
  /** pass ≤ WARN, warn ≤ MAX, fail > MAX. */
  status: "pass" | "warn" | "fail";
  /** Overshoot vs MAX_EGRESS_M (0 if pass/warn). */
  shortfallM: number;
  /** Brief human-readable explanation. */
  reason: string;
}

export interface EgressAnalysis {
  /** One entry per apartment with a resolvable entrance door. */
  checks: EgressCheck[];
  /** Count of apt-checks by status. */
  pass: number;
  warn: number;
  fail: number;
  /** Longest routed distance seen on the floor [m] (0 if no apts). */
  maxDistance: number;
  /** True if no apartment violates MBO §35. */
  overallPass: boolean;
}

// ── Geometry helpers ──────────────────────────────────────────────

function euclidean(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function staircaseCentroid(s: FloorPlanStaircase): [number, number] {
  return [s.position.x + s.width_m / 2, s.position.y + s.depth_m / 2];
}

interface CorridorStrip {
  /** Axis direction: "x" means the corridor runs along the x-axis
   *  (typical Ganghaus), "y" means it runs along y (rare). */
  axis: "x" | "y";
  /** Coordinate of the corridor centerline along the perpendicular
   *  axis. E.g. for axis="x", this is the fixed y value of the corridor
   *  centerline. */
  centerPerp: number;
  /** Extent along the corridor's long axis [m], as [start, end]. */
  extentLong: [number, number];
}

/** Identify the dominant corridor strip in the plan, or null if the
 *  floor has no corridor (Spänner / Laubengang). Picks the largest
 *  room whose type === "corridor" and reads off its bbox. */
function findCorridorStrip(plan: FloorPlan): CorridorStrip | null {
  const corridors = plan.rooms.filter((r) => r.room_type === "corridor");
  if (corridors.length === 0) return null;

  // Prefer the longest corridor by bbox diagonal.
  let best: CorridorStrip | null = null;
  let bestLen = 0;
  for (const c of corridors) {
    const poly = c.polygon;
    if (!poly || poly.length < 3) continue;
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = maxX - minX;
    const d = maxY - minY;
    const longAxis: "x" | "y" = w >= d ? "x" : "y";
    const len = Math.max(w, d);
    if (len > bestLen) {
      bestLen = len;
      best =
        longAxis === "x"
          ? { axis: "x", centerPerp: (minY + maxY) / 2, extentLong: [minX, maxX] }
          : { axis: "y", centerPerp: (minX + maxX) / 2, extentLong: [minY, maxY] };
    }
  }
  return best;
}

/** Routed distance from a door to a target via a corridor centerline.
 *  Path = perp from door to corridor axis, then along-axis to target's
 *  projection on the axis, then perp from axis to target centroid.
 *  This matches how a person actually walks a Ganghaus egress. */
function routedViaCorridor(
  door: [number, number],
  target: [number, number],
  corridor: CorridorStrip,
): number {
  if (corridor.axis === "x") {
    // Corridor runs along x at y = centerPerp, between extentLong[0..1]
    // on x. Door x snaps onto [extentLong[0], extentLong[1]].
    const doorProjX = clamp(door[0], corridor.extentLong[0], corridor.extentLong[1]);
    const targetProjX = clamp(target[0], corridor.extentLong[0], corridor.extentLong[1]);
    const perpDoor = Math.abs(door[1] - corridor.centerPerp);
    const perpTarget = Math.abs(target[1] - corridor.centerPerp);
    const along = Math.abs(targetProjX - doorProjX);
    return perpDoor + along + perpTarget;
  } else {
    const doorProjY = clamp(door[1], corridor.extentLong[0], corridor.extentLong[1]);
    const targetProjY = clamp(target[1], corridor.extentLong[0], corridor.extentLong[1]);
    const perpDoor = Math.abs(door[0] - corridor.centerPerp);
    const perpTarget = Math.abs(target[0] - corridor.centerPerp);
    const along = Math.abs(targetProjY - doorProjY);
    return perpDoor + along + perpTarget;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Main analyzer ─────────────────────────────────────────────────

export function analyzeEgress(plan: FloorPlan): EgressAnalysis {
  const staircases = plan.staircases ?? [];
  const doorById: Map<string, DoorPlacement> = new Map(
    (plan.doors ?? []).map((d) => [d.id, d]),
  );
  const corridor = findCorridorStrip(plan);

  const checks: EgressCheck[] = [];

  for (const apt of plan.apartments ?? []) {
    const door = doorById.get(apt.entrance_door_id);
    if (!door) continue; // can't evaluate — no entrance door resolved
    if (staircases.length === 0) continue; // no sinks on this floor

    const doorPos: [number, number] = [door.position.x, door.position.y];

    let best: { staircase: FloorPlanStaircase; routed: number; euclid: number } | null = null;
    for (const s of staircases) {
      const c = staircaseCentroid(s);
      const euclid = euclidean(doorPos, c);
      const routed = corridor
        ? routedViaCorridor(doorPos, c, corridor)
        : euclid * ROUTING_FACTOR_NO_CORRIDOR;
      if (!best || routed < best.routed) {
        best = { staircase: s, routed, euclid };
      }
    }
    if (!best) continue;

    const d = best.routed;
    let status: EgressCheck["status"];
    let reason: string;
    if (d > MAX_EGRESS_M) {
      status = "fail";
      reason = `Rettungsweg ${d.toFixed(1)} m überschreitet MBO §35 Grenze von ${MAX_EGRESS_M.toFixed(0)} m`;
    } else if (d > WARN_EGRESS_M) {
      status = "warn";
      reason = `Rettungsweg ${d.toFixed(1)} m nähert sich dem §35 Grenzwert (${MAX_EGRESS_M.toFixed(0)} m)`;
    } else {
      status = "pass";
      reason = `Rettungsweg ${d.toFixed(1)} m`;
    }

    checks.push({
      apartmentId: apt.id,
      unitNumber: apt.unit_number,
      doorPosition: doorPos,
      nearestStaircaseId: best.staircase.id,
      euclideanDistanceM: best.euclid,
      routedDistanceM: best.routed,
      status,
      shortfallM: Math.max(0, d - MAX_EGRESS_M),
      reason,
    });
  }

  const pass = checks.filter((c) => c.status === "pass").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  const maxDistance = checks.reduce((m, c) => Math.max(m, c.routedDistanceM), 0);

  return {
    checks,
    pass,
    warn,
    fail,
    maxDistance,
    overallPass: fail === 0,
  };
}
