/**
 * Site-level multi-building coordination (Phase 4.5).
 *
 * Pure geometric module that takes a LayoutOption (N buildings on a
 * parcel) and emits:
 *
 *  1. **Abstandsflächen** per BauO NRW §6 / MBO §6 — required distance
 *     between any two building facades = 0.4 × H (min 3 m), applied
 *     along each facade's normal. Violations stop financing / permits.
 *  2. **Plot coverage** (GRZ) — footprint area / plot area.
 *  3. **Height homogeneity** — σ of building heights, flagged if > 3 m.
 *  4. **Axis alignment** — whether all buildings share a common
 *     structural grid rotation (within 5°).
 *
 * This is a screening-level check: true Abstandsflächen proofing in
 * Germany requires a CAD overlay with the parcel boundary and any
 * cross-parcel neighboring buildings — not just inter-building
 * distances. But for the design phase it answers "do our own
 * buildings breach each other's Abstandsflächen?" which is by far the
 * most common multi-building failure mode.
 */

import type { LayoutOption, BuildingFootprint } from "@/types/api";

// ── Constants ─────────────────────────────────────────────────────

/** BauO NRW §6 Abstandsflächentiefe-Koeffizient. 0.4 is the general
 *  multi-family residential value. City cores may drop to 0.25; rural
 *  garages are 0.2. We default to 0.4 as the conservative planning
 *  value (caller can override). */
export const DEFAULT_H_COEFF = 0.4;

/** Absolute minimum Abstandsfläche. §6 sets 3 m as a floor even if
 *  0.4 × H would give less. */
export const MIN_ABSTAND_M = 3.0;

/** Alignment tolerance for rotation comparison, in degrees. */
const ALIGNMENT_TOL_DEG = 5.0;

/** Height homogeneity threshold — σ above this gets flagged. */
const HEIGHT_STD_WARN_M = 3.0;

// ── Types ─────────────────────────────────────────────────────────

export interface BuildingPolygon {
  id: string;
  /** 4 corner points (m) in plot-local coordinates, CCW. */
  corners: [number, number][];
  /** Height above ground [m]. */
  height: number;
  /** Rotation relative to plot axis [deg]. */
  rotation: number;
  /** Footprint area [m²]. */
  footprintSqm: number;
}

export interface PairwiseCheck {
  a: string;
  b: string;
  /** Minimum edge-to-edge distance between the two footprints [m]. */
  minDistance: number;
  /** Required Abstandsfläche governing this pair = max(0.4·max(Ha,Hb), 3) [m]. */
  required: number;
  /** pass = dist ≥ required, warn = within 10 %, fail = below required. */
  status: "pass" | "warn" | "fail";
  /** Shortfall in m (0 if pass). */
  shortfall: number;
}

export interface BoundaryCheck {
  /** Building whose facade is being measured. */
  buildingId: string;
  /** Minimum distance from any building corner to the parcel boundary [m]. */
  minDistance: number;
  /** Required §6 setback = max(hCoeff · H, 3) [m]. Uses the building's own
   *  height (single-building check, not pairwise). */
  required: number;
  status: "pass" | "warn" | "fail";
  shortfall: number;
}

export interface SiteCoordinationResult {
  /** Per-building polygons (corners, height, footprint). */
  buildings: BuildingPolygon[];
  /** Pairwise Abstandsflächen checks (building-to-building). */
  pairs: PairwiseCheck[];
  /** Per-building setback to parcel boundary. Empty if no plot polygon
   *  was supplied — the check is skipped rather than guessed. */
  boundaries: BoundaryCheck[];
  /** Total footprint [m²]. */
  totalFootprintSqm: number;
  /** GRZ — footprint / plot area. */
  grz: number | null;
  /** Max, min, mean, σ of building heights. */
  heightStats: { min: number; max: number; mean: number; stdDev: number };
  /** Common axis rotation if buildings are aligned, else null. */
  commonRotationDeg: number | null;
  /** True if all buildings are within ALIGNMENT_TOL_DEG of each other. */
  isAligned: boolean;
  /** Overall verdict. */
  summary: {
    pairFails: number;
    pairWarns: number;
    boundaryFails: number;
    boundaryWarns: number;
    grzOver: boolean; // true if grz > 0.4 (typical Wohngebiet cap)
    heightSpread: boolean;
  };
}

export interface SiteCoordinationInput {
  layout: LayoutOption;
  plotAreaSqm?: number;
  /** Plot boundary polygon in plot-local coordinates [m], CCW. When
   *  supplied, enables the single-building setback check to each
   *  parcel edge per §6. */
  plotBoundary?: [number, number][];
  /** Override §6 coefficient (0.4 default, 0.25 city core, 0.2 rural). */
  hCoeff?: number;
}

// ── Geometry helpers ──────────────────────────────────────────────

function buildingCorners(b: BuildingFootprint): [number, number][] {
  const rad = (b.rotation_deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfW = b.width_m / 2;
  const halfD = b.depth_m / 2;
  const cx = b.position_x;
  const cy = b.position_y;

  const local: [number, number][] = [
    [-halfW, -halfD],
    [halfW, -halfD],
    [halfW, halfD],
    [-halfW, halfD],
  ];
  return local.map(([lx, ly]): [number, number] => [
    cx + lx * cos - ly * sin,
    cy + lx * sin + ly * cos,
  ]);
}

/** Distance from point p to segment ab (closed segment). */
function pointToSegDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    return Math.hypot(px - ax, py - ay);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Minimum distance between two polygons' edges (assumes non-overlapping
 *  convex quads). Iterates point-to-segment over all 4×4 combos. */
function polygonMinDistance(
  polyA: [number, number][],
  polyB: [number, number][],
): number {
  let minD = Infinity;
  for (const p of polyA) {
    for (let i = 0; i < polyB.length; i++) {
      const a = polyB[i];
      const b = polyB[(i + 1) % polyB.length];
      minD = Math.min(minD, pointToSegDistance(p, a, b));
    }
  }
  for (const p of polyB) {
    for (let i = 0; i < polyA.length; i++) {
      const a = polyA[i];
      const b = polyA[(i + 1) % polyA.length];
      minD = Math.min(minD, pointToSegDistance(p, a, b));
    }
  }
  return minD;
}

/** Minimum distance from a building's corners to the nearest edge of
 *  the parcel boundary. Assumes the building is fully inside the plot
 *  (the normal Goldbeck generator guarantee). Iterates all corners ×
 *  all boundary segments. */
function polygonToBoundaryMinDistance(
  polyCorners: [number, number][],
  boundary: [number, number][],
): number {
  let minD = Infinity;
  for (const p of polyCorners) {
    for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i];
      const b = boundary[(i + 1) % boundary.length];
      minD = Math.min(minD, pointToSegDistance(p, a, b));
    }
  }
  return minD;
}

// ── Main analyzer ─────────────────────────────────────────────────

export function analyzeSite(input: SiteCoordinationInput): SiteCoordinationResult {
  const { layout } = input;
  const hCoeff = input.hCoeff ?? DEFAULT_H_COEFF;

  // 1. Polygonize every building.
  //
  // Phase 14 fix — § 6 Abstandsfläche depth uses the height of the
  // wall doing the projecting. For a Staffelgeschoss building the
  // *lower* facade only reaches `stories × floor_height` (the SG sits
  // inset behind a setback at higher elevation). Previously this used
  // `total_height_m` which over-counted the SG's height against the
  // lower facade and produced false §6 violations on the workspace
  // permit dashboard while the layout-side optimizer was happy.
  //
  // The SG itself has its own §6 envelope; with the standard 2 m
  // setback it sits inside the lower envelope, so we don't need to
  // check it separately here.
  const buildings: BuildingPolygon[] = layout.buildings.map((b) => {
    const floorH = b.floor_height_m || 3.05;
    const lowerHeight = b.stories * floorH;
    return {
      id: b.id,
      corners: buildingCorners(b),
      height: lowerHeight,
      rotation: b.rotation_deg,
      footprintSqm: b.width_m * b.depth_m,
    };
  });

  const totalFootprintSqm = buildings.reduce((s, b) => s + b.footprintSqm, 0);
  const grz = input.plotAreaSqm && input.plotAreaSqm > 0 ? totalFootprintSqm / input.plotAreaSqm : null;

  // 2. Pairwise Abstandsfläche check.
  const pairs: PairwiseCheck[] = [];
  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const A = buildings[i];
      const B = buildings[j];
      const dist = polygonMinDistance(A.corners, B.corners);
      const maxH = Math.max(A.height, B.height);
      const required = Math.max(hCoeff * maxH, MIN_ABSTAND_M);
      const shortfall = Math.max(0, required - dist);
      const status: PairwiseCheck["status"] =
        dist >= required
          ? "pass"
          : dist >= required * 0.9
          ? "warn"
          : "fail";
      pairs.push({
        a: A.id,
        b: B.id,
        minDistance: dist,
        required,
        status,
        shortfall,
      });
    }
  }

  // 2b. Boundary setback — per-building distance to every parcel edge.
  //    §6 also applies the Abstandsfläche normal to the lot line, so the
  //    required setback is computed from the single building's height
  //    (not pairwise). We take the min distance from any building corner
  //    to any parcel boundary segment as the governing setback.
  const boundaries: BoundaryCheck[] = [];
  if (input.plotBoundary && input.plotBoundary.length >= 3) {
    for (const A of buildings) {
      const dist = polygonToBoundaryMinDistance(A.corners, input.plotBoundary);
      const required = Math.max(hCoeff * A.height, MIN_ABSTAND_M);
      const shortfall = Math.max(0, required - dist);
      const status: BoundaryCheck["status"] =
        dist >= required ? "pass" : dist >= required * 0.9 ? "warn" : "fail";
      boundaries.push({
        buildingId: A.id,
        minDistance: dist,
        required,
        status,
        shortfall,
      });
    }
  }

  // 3. Height stats.
  const heights = buildings.map((b) => b.height);
  const heightStats = summarize(heights);

  // 4. Axis alignment.
  const rotations = buildings.map((b) => b.rotation);
  const commonRotationDeg = rotations.length > 0 ? rotations[0] : null;
  const isAligned = rotations.every(
    (r) => Math.abs(((r - (commonRotationDeg ?? 0) + 540) % 360) - 180) > 180 - ALIGNMENT_TOL_DEG,
  );

  const pairFails = pairs.filter((p) => p.status === "fail").length;
  const pairWarns = pairs.filter((p) => p.status === "warn").length;
  const boundaryFails = boundaries.filter((b) => b.status === "fail").length;
  const boundaryWarns = boundaries.filter((b) => b.status === "warn").length;

  return {
    buildings,
    pairs,
    boundaries,
    totalFootprintSqm,
    grz,
    heightStats,
    commonRotationDeg,
    isAligned,
    summary: {
      pairFails,
      pairWarns,
      boundaryFails,
      boundaryWarns,
      grzOver: grz !== null && grz > 0.4,
      heightSpread: heightStats.stdDev > HEIGHT_STD_WARN_M,
    },
  };
}

function summarize(xs: number[]): { min: number; max: number; mean: number; stdDev: number } {
  if (xs.length === 0) return { min: 0, max: 0, mean: 0, stdDev: 0 };
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return { min, max, mean, stdDev: Math.sqrt(variance) };
}

// ── Formatting helpers ────────────────────────────────────────────

export function formatMeters(m: number, decimals = 2): string {
  return `${m.toLocaleString("de-DE", { maximumFractionDigits: decimals, minimumFractionDigits: decimals })} m`;
}
