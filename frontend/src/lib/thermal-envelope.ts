/**
 * Thermal envelope analysis (Phase 4.4).
 *
 * Pure client-side GEG 2023 heat-loss calculation for a Goldbeck
 * residential building. Computes element-by-element thermal
 * transmittance (U × A), the specific transmission heat-loss
 * coefficient H_T' [W/(m²·K)], an approximate annual heating demand
 * [kWh/(m²·a)], and a GEG 2023 Referenzgebäude compliance verdict.
 *
 * Standards referenced:
 * - DIN V 18599-2 (transmission + ventilation heat losses)
 * - GEG 2023 §15 Referenzgebäude MFH → H_T' ≤ 0.40 W/(m²·K)
 * - DIN V 4108-6 simplified monthly method (intentionally skipped for
 *   a grobkostenrahmen-style indicator; architects can still see the
 *   order of magnitude)
 *
 * This is a high-level screening indicator for the planning phase —
 * NOT a replacement for a Nachweisberechnung in GEG-compliant software
 * (Hottgenroth, ZUB Helena, etc.). The output is precise enough to
 * tell a KfW-40 envelope apart from a GEG-baseline one, but not to
 * sign a Nachweis.
 */

import type { BuildingFloorPlans, FloorPlan } from "@/types/api";

// ── Thermal standards ─────────────────────────────────────────────

export type ThermalStandard = "geg_reference" | "goldbeck_standard" | "kfw_55" | "kfw_40" | "passivhaus";

/** U-values in W/(m²·K) per envelope element for each standard.
 *  Sources: GEG 2023 Anlage 1 (reference) and KfW technical minimum
 *  requirements 2024 (effizienzhaus_stufen.pdf). */
export const U_VALUES: Record<ThermalStandard, {
  wall: number;
  window: number;
  roof: number;
  floor: number; // ground-facing floor
  door: number;
  label: string;
  description: string;
}> = {
  geg_reference: {
    wall: 0.28, window: 1.3, roof: 0.20, floor: 0.35, door: 1.8,
    label: "GEG 2023 Referenz",
    description: "Gesetzlicher Mindeststandard (§15 GEG Referenzgebäude).",
  },
  goldbeck_standard: {
    wall: 0.24, window: 1.1, roof: 0.18, floor: 0.30, door: 1.6,
    label: "Goldbeck Standard",
    description: "Werksstandard mit 20 cm Dämmung, 3-fach verglaste Fenster.",
  },
  kfw_55: {
    wall: 0.18, window: 1.0, roof: 0.16, floor: 0.25, door: 1.3,
    label: "KfW Effizienzhaus 55",
    description: "H_T' ≤ 55 % Referenz → förderfähig §261 KfW.",
  },
  kfw_40: {
    wall: 0.14, window: 0.85, roof: 0.12, floor: 0.20, door: 1.1,
    label: "KfW Effizienzhaus 40",
    description: "H_T' ≤ 40 % Referenz → höchste reguläre KfW-Stufe.",
  },
  passivhaus: {
    wall: 0.12, window: 0.80, roof: 0.10, floor: 0.15, door: 0.80,
    label: "Passivhaus",
    description: "PHPP-konform, Heizwärmebedarf ≤ 15 kWh/(m²·a).",
  },
};

// ── Physics constants ─────────────────────────────────────────────

/** Reduction factor for floor-to-ground per DIN V 4108-6 (§6.2). */
const F_FLOOR = 0.5;
/** Reduction factor for roof (ceiling to unheated attic). */
const F_ROOF = 0.8;
/** Reduction factor for windows & walls to ambient air. */
const F_EXT = 1.0;

/** German heating degree-hours [K·kh/a] — mean Wohnungsbau reference
 *  from DIN V 4108-6 Annex (HGT = 3500 K·d with 24 h/d → 84 kKh). */
const HGT_KKH_PER_YEAR = 84;

/** Air-change rate for natural ventilation in residential [1/h]. */
const AIR_CHANGE_RATE = 0.5;
/** Specific heat capacity of air [Wh/(m³·K)] — standard DIN value. */
const C_AIR = 0.34;

/** Annual internal + solar gain yield per m² NGF [kWh/(m²·a)] — typical
 *  MFH value per DIN V 4108-6 utilization factor ≈ 0.85 × 50 kWh/m². */
const GAINS_PER_SQM_NGF = 20;

/** GEG 2023 reference transmission coefficient for MFH [W/(m²·K)]. */
export const GEG_HT_PRIME_REFERENCE = 0.40;

// ── Types ─────────────────────────────────────────────────────────

export interface EnvelopeElement {
  /** Element kind. */
  kind: "wall" | "window" | "roof" | "floor" | "door";
  /** Area [m²]. */
  area: number;
  /** U-value [W/(m²·K)]. */
  uValue: number;
  /** Reduction factor F_x (per DIN V 4108-6). */
  fx: number;
  /** UA × F_x contribution to H_T [W/K]. */
  htContribution: number;
}

export interface ThermalEstimateInput {
  building: BuildingFloorPlans;
  standard: ThermalStandard;
  /** Override any U-value (kept optional for power users). */
  uOverrides?: Partial<Record<"wall" | "window" | "roof" | "floor" | "door", number>>;
}

export interface ThermalEstimate {
  standard: ThermalStandard;
  elements: EnvelopeElement[];
  /** Total envelope area A [m²]. */
  envelopeArea: number;
  /** Heated floor area A_N / NGF [m²]. */
  ngfSqm: number;
  /** Heated volume V_e [m³]. */
  heatedVolume: number;
  /** Transmission heat-loss coefficient H_T [W/K]. */
  htTotal: number;
  /** Specific transmission coefficient H_T' = H_T / A_envelope [W/(m²·K)]. */
  htPrime: number;
  /** Ventilation heat-loss coefficient H_V [W/K]. */
  hvTotal: number;
  /** Annual transmission heat demand [kWh/a]. */
  qTransmission: number;
  /** Annual ventilation heat demand [kWh/a]. */
  qVentilation: number;
  /** Annual heating demand [kWh/a] — after subtracting gains. */
  qHeating: number;
  /** Heating demand per NGF [kWh/(m²·a)]. */
  qHeatingPerSqm: number;
  /** Building compactness A/V [1/m]. */
  avRatio: number;
  /** Pass / warn / fail vs GEG 2023 H_T' ≤ 0.40. */
  gegStatus: "pass" | "warn" | "fail";
  /** KfW Effizienzhaus tier achieved, or null if not reached. */
  kfwTier: 55 | 40 | null;
}

// ── Geometry helpers ──────────────────────────────────────────────

function windowAreaForFloor(floor: FloorPlan): number {
  let a = 0;
  for (const w of floor.windows) a += w.width_m * w.height_m;
  return a;
}

function doorAreaForFloor(floor: FloorPlan): { ext: number; count: number } {
  let a = 0;
  let count = 0;
  for (const d of floor.doors) {
    if (d.is_entrance) {
      a += d.width_m * d.height_m;
      count += 1;
    }
  }
  return { ext: a, count };
}

function exteriorWallAreaForFloor(floor: FloorPlan, storyHeight: number): number {
  // Exterior perimeter × story height − openings on exterior walls
  const grid = floor.structural_grid;
  const perim = 2 * (grid.building_length_m + grid.building_depth_m);
  const gross = perim * storyHeight;
  const windowA = windowAreaForFloor(floor);
  const { ext: doorA } = doorAreaForFloor(floor);
  return Math.max(0, gross - windowA - doorA);
}

// ── Main estimator ────────────────────────────────────────────────

export function estimateThermal(input: ThermalEstimateInput): ThermalEstimate {
  const { building, standard } = input;
  const u = U_VALUES[standard];
  const overrides = input.uOverrides ?? {};
  const uWall = overrides.wall ?? u.wall;
  const uWin = overrides.window ?? u.window;
  const uRoof = overrides.roof ?? u.roof;
  const uFloor = overrides.floor ?? u.floor;
  const uDoor = overrides.door ?? u.door;

  const storyHeight = building.story_height_m || 2.75;

  // Per-floor accumulation
  let totalWallArea = 0;
  let totalWindowArea = 0;
  let totalDoorArea = 0;
  let ngfSqm = 0;

  for (const floor of building.floor_plans) {
    totalWallArea += exteriorWallAreaForFloor(floor, storyHeight);
    totalWindowArea += windowAreaForFloor(floor);
    totalDoorArea += doorAreaForFloor(floor).ext;
    for (const room of floor.rooms) {
      if (room.room_type === "shaft" || room.room_type === "balcony") continue;
      ngfSqm += room.area_sqm;
    }
  }

  // Roof = top floor footprint
  const top = building.floor_plans[building.floor_plans.length - 1];
  const roofArea = top
    ? top.structural_grid.building_length_m * top.structural_grid.building_depth_m
    : 0;

  // Ground-facing floor = bottom floor footprint
  const bottom = building.floor_plans[0];
  const floorArea = bottom
    ? bottom.structural_grid.building_length_m * bottom.structural_grid.building_depth_m
    : 0;

  const envelopeArea = totalWallArea + totalWindowArea + totalDoorArea + roofArea + floorArea;

  const elements: EnvelopeElement[] = [
    {
      kind: "wall",
      area: totalWallArea,
      uValue: uWall,
      fx: F_EXT,
      htContribution: totalWallArea * uWall * F_EXT,
    },
    {
      kind: "window",
      area: totalWindowArea,
      uValue: uWin,
      fx: F_EXT,
      htContribution: totalWindowArea * uWin * F_EXT,
    },
    {
      kind: "door",
      area: totalDoorArea,
      uValue: uDoor,
      fx: F_EXT,
      htContribution: totalDoorArea * uDoor * F_EXT,
    },
    {
      kind: "roof",
      area: roofArea,
      uValue: uRoof,
      fx: F_ROOF,
      htContribution: roofArea * uRoof * F_ROOF,
    },
    {
      kind: "floor",
      area: floorArea,
      uValue: uFloor,
      fx: F_FLOOR,
      htContribution: floorArea * uFloor * F_FLOOR,
    },
  ];

  const htTotal = elements.reduce((s, e) => s + e.htContribution, 0);
  const htPrime = envelopeArea > 0 ? htTotal / envelopeArea : 0;

  // Heated volume: NGF × story height is an underestimate; use BGF × h
  // per-floor instead so we cover the building wrapper honestly.
  let heatedVolume = 0;
  for (const floor of building.floor_plans) {
    const g = floor.structural_grid;
    heatedVolume += g.building_length_m * g.building_depth_m * storyHeight;
  }

  const hvTotal = C_AIR * AIR_CHANGE_RATE * heatedVolume;

  const qTransmission = htTotal * HGT_KKH_PER_YEAR;
  const qVentilation = hvTotal * HGT_KKH_PER_YEAR;
  const qGainsTotal = GAINS_PER_SQM_NGF * ngfSqm;
  const qHeating = Math.max(0, qTransmission + qVentilation - qGainsTotal);
  const qHeatingPerSqm = ngfSqm > 0 ? qHeating / ngfSqm : 0;

  const avRatio = heatedVolume > 0 ? envelopeArea / heatedVolume : 0;

  // GEG compliance
  const gegStatus: ThermalEstimate["gegStatus"] =
    htPrime <= GEG_HT_PRIME_REFERENCE * 0.9
      ? "pass"
      : htPrime <= GEG_HT_PRIME_REFERENCE
      ? "warn"
      : "fail";

  // KfW tier (based on H_T' vs reference)
  const kfwRatio = htPrime / GEG_HT_PRIME_REFERENCE;
  const kfwTier: ThermalEstimate["kfwTier"] = kfwRatio <= 0.4 ? 40 : kfwRatio <= 0.55 ? 55 : null;

  return {
    standard,
    elements,
    envelopeArea,
    ngfSqm,
    heatedVolume,
    htTotal,
    htPrime,
    hvTotal,
    qTransmission,
    qVentilation,
    qHeating,
    qHeatingPerSqm,
    avRatio,
    gegStatus,
    kfwTier,
  };
}

// ── Formatting helpers ────────────────────────────────────────────

export function formatU(u: number): string {
  return `${u.toFixed(2)} W/(m²·K)`;
}

export function formatKwhPerSqm(v: number): string {
  return `${v.toLocaleString("de-DE", { maximumFractionDigits: 1 })} kWh/(m²·a)`;
}

export function formatHt(v: number): string {
  return `${v.toLocaleString("de-DE", { maximumFractionDigits: 0 })} W/K`;
}

export function formatArea(sqm: number): string {
  return `${sqm.toLocaleString("de-DE", { maximumFractionDigits: 1 })} m²`;
}
