/**
 * Unified permit-readiness aggregator (Phase 5h).
 *
 * Rolls up every validator we own into one "Baugenehmigungsfähigkeit"
 * verdict per layout so the architect can answer the one question a
 * client actually asks: *"Ist das genehmigungsfähig?"*
 *
 * Aggregated checks:
 *   1. MBO §35 fire egress              — lib/fire-egress
 *   2. DIN 18040-2 barrier-free (EG)    — lib/barrier-free
 *   3. DIN 5034-1 Besonnung              — lib/besonnung
 *   4. GEG 2023 thermal envelope         — lib/thermal-envelope
 *   5. BauO NRW §6 Abstandsflächen      — lib/site-coordination
 *   6. BauNVO / §34 regulation check     — already on LayoutOption
 *
 * Verdict logic:
 *   - `ja`       = 0 errors across all checks
 *   - `bedingt`  = 0 errors but ≥1 warning
 *   - `nein`     = ≥1 error in any check
 *
 * Each check is independent and returns a status so a failure in one
 * validator (e.g. lat/lng missing → Besonnung skipped) never poisons
 * the aggregated verdict.
 */

import type {
  BuildingFloorPlans,
  LayoutOption,
  PlotAnalysis,
} from "@/types/api";
import { analyzeEgress } from "./fire-egress";
import { analyzeBarrierFree } from "./barrier-free";
import { analyzeBesonnung } from "./besonnung";
import { estimateThermal, type ThermalStandard } from "./thermal-envelope";
import { analyzeSite } from "./site-coordination";

// ── Types ─────────────────────────────────────────────────────────

export type PermitVerdict = "ja" | "bedingt" | "nein";
export type CheckStatus = "pass" | "warn" | "fail" | "skipped";

/** Identifiers used to deep-link to the offending panel. */
export type PermitCheckId =
  | "egress"
  | "barrier_free"
  | "besonnung"
  | "thermal"
  | "site_abstand"
  | "regulation";

export interface PermitCheck {
  id: PermitCheckId;
  /** Short German label for the row. */
  label: string;
  /** Regulation reference (e.g. "MBO §35", "DIN 18040-2"). */
  regulation: string;
  status: CheckStatus;
  /** Count of hard violations contributing to "nein". */
  errorCount: number;
  /** Count of soft warnings contributing to "bedingt". */
  warnCount: number;
  /** Human-readable summary for the row. */
  detail: string;
  /** Tab on the results page that shows the full breakdown. */
  targetTab?: string;
  /** Building id if the issue is scoped to a single building. */
  buildingId?: string;
}

export interface PermitReadinessInput {
  layout: LayoutOption;
  /** Generated floor plans indexed by building id. */
  floorPlans: Record<string, BuildingFloorPlans>;
  plot?: PlotAnalysis | null;
  /** Thermal standard to evaluate against. Defaults to Goldbeck Standard. */
  thermalStandard?: ThermalStandard;
  /** §6 coefficient (0.4 Wohngebiet default). */
  hCoeff?: number;
}

export interface PermitReadinessResult {
  overall: PermitVerdict;
  checks: PermitCheck[];
  errorCount: number;
  warnCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function rollupStatus(
  errorCount: number,
  warnCount: number,
): Exclude<CheckStatus, "skipped"> {
  if (errorCount > 0) return "fail";
  if (warnCount > 0) return "warn";
  return "pass";
}

function verdictFromCounts(
  errors: number,
  warnings: number,
): PermitVerdict {
  if (errors > 0) return "nein";
  if (warnings > 0) return "bedingt";
  return "ja";
}

// ── Per-check runners ─────────────────────────────────────────────

function runEgress(
  floorPlans: Record<string, BuildingFloorPlans>,
): PermitCheck {
  let errors = 0;
  let warns = 0;
  let longest = 0;
  let anyChecked = false;
  for (const bfp of Object.values(floorPlans)) {
    for (const plan of bfp.floor_plans) {
      const r = analyzeEgress(plan);
      if (r.checks.length === 0) continue;
      anyChecked = true;
      errors += r.fail;
      warns += r.warn;
      if (r.maxDistance > longest) longest = r.maxDistance;
    }
  }
  if (!anyChecked) {
    return {
      id: "egress",
      label: "Rettungswegelänge",
      regulation: "MBO §35",
      status: "skipped",
      errorCount: 0,
      warnCount: 0,
      detail: "Keine Wohnungs-Eingangstüren gefunden — Prüfung übersprungen.",
      targetTab: "layouts",
    };
  }
  const status = rollupStatus(errors, warns);
  const detail =
    status === "pass"
      ? `Alle Wohnungen ≤ 30 m (längster Weg ${longest.toFixed(1)} m).`
      : status === "warn"
        ? `${warns} Wohnungen zwischen 30–35 m (längster Weg ${longest.toFixed(1)} m).`
        : `${errors} Wohnungen überschreiten 35 m (längster Weg ${longest.toFixed(1)} m).`;
  return {
    id: "egress",
    label: "Rettungswegelänge",
    regulation: "MBO §35",
    status,
    errorCount: errors,
    warnCount: warns,
    detail,
    targetTab: "layouts",
  };
}

function runBarrierFree(
  floorPlans: Record<string, BuildingFloorPlans>,
): PermitCheck {
  let errors = 0;
  let warns = 0;
  let apts = 0;
  let anyGround = false;
  for (const bfp of Object.values(floorPlans)) {
    for (const plan of bfp.floor_plans) {
      const r = analyzeBarrierFree(plan);
      if (r.apartmentsChecked === 0) continue;
      anyGround = true;
      errors += r.errorCount;
      warns += r.warnCount;
      apts += r.apartmentsChecked;
    }
  }
  if (!anyGround) {
    return {
      id: "barrier_free",
      label: "Barrierefreiheit EG",
      regulation: "DIN 18040-2, BauO NRW §50",
      status: "skipped",
      errorCount: 0,
      warnCount: 0,
      detail: "Kein Erdgeschoss zu prüfen.",
      targetTab: "layouts",
    };
  }
  const status = rollupStatus(errors, warns);
  const detail =
    status === "pass"
      ? `${apts} EG-Wohnungen erfüllen R-Standard (Türen, Wendekreis, Flur).`
      : status === "warn"
        ? `${warns} Hinweise bei ${apts} EG-Wohnungen (Innentüren schmal).`
        : `${errors} Verstöße gegen R-Standard bei ${apts} EG-Wohnungen.`;
  return {
    id: "barrier_free",
    label: "Barrierefreiheit EG",
    regulation: "DIN 18040-2, BauO NRW §50",
    status,
    errorCount: errors,
    warnCount: warns,
    detail,
    targetTab: "layouts",
  };
}

function runBesonnung(
  floorPlans: Record<string, BuildingFloorPlans>,
  plot: PlotAnalysis | null | undefined,
  layout: LayoutOption,
): PermitCheck {
  const lat = plot?.centroid_geo?.lat;
  const lng = plot?.centroid_geo?.lng;
  if (lat === undefined || lng === undefined) {
    return {
      id: "besonnung",
      label: "Besonnung",
      regulation: "DIN 5034-1",
      status: "skipped",
      errorCount: 0,
      warnCount: 0,
      detail: "Grundstück nicht geokodiert — Sonnenstandsberechnung übersprungen.",
      targetTab: "site",
    };
  }
  let errors = 0;
  let warns = 0;
  let apts = 0;
  const rotByBuilding = new Map<string, number>(
    layout.buildings.map((b) => [b.id, b.rotation_deg]),
  );
  for (const bfp of Object.values(floorPlans)) {
    const rot = rotByBuilding.get(bfp.building_id) ?? 0;
    for (const plan of bfp.floor_plans) {
      const r = analyzeBesonnung({
        plan,
        latitude: lat,
        longitude: lng,
        buildingRotationDeg: rot,
      });
      if (!r.evaluated) continue;
      errors += r.fail;
      warns += r.warn;
      apts += r.apartments.length;
    }
  }
  const status = rollupStatus(errors, warns);
  const detail =
    status === "pass"
      ? `Alle ${apts} Wohnungen bekommen am 17. Januar ≥ 1 h direkte Sonne.`
      : status === "warn"
        ? `${warns} Wohnungen mit 0,5–1 h Sonne (Grenzbereich).`
        : `${errors} Wohnungen mit < 0,5 h Sonne am 17. Januar.`;
  return {
    id: "besonnung",
    label: "Besonnung",
    regulation: "DIN 5034-1",
    status,
    errorCount: errors,
    warnCount: warns,
    detail,
    targetTab: "site",
  };
}

function runThermal(
  floorPlans: Record<string, BuildingFloorPlans>,
  standard: ThermalStandard,
): PermitCheck {
  let errors = 0;
  let warns = 0;
  let worstHtPrime = 0;
  let any = false;
  for (const bfp of Object.values(floorPlans)) {
    try {
      const est = estimateThermal({ building: bfp, standard });
      any = true;
      if (est.gegStatus === "fail") errors += 1;
      if (est.gegStatus === "warn") warns += 1;
      if (est.htPrime > worstHtPrime) worstHtPrime = est.htPrime;
    } catch {
      // Per-building thermal failure shouldn't poison the whole check.
    }
  }
  if (!any) {
    return {
      id: "thermal",
      label: "Wärmeschutz",
      regulation: "GEG 2023",
      status: "skipped",
      errorCount: 0,
      warnCount: 0,
      detail: "Keine Gebäudegeometrie zur Berechnung.",
      targetTab: "energy",
    };
  }
  const status = rollupStatus(errors, warns);
  const detail =
    status === "pass"
      ? `H_T′ = ${worstHtPrime.toFixed(2)} W/(m²·K) ≤ 0,40 Referenzwert.`
      : status === "warn"
        ? `H_T′ = ${worstHtPrime.toFixed(2)} W/(m²·K) — knapp am Referenzwert.`
        : `H_T′ = ${worstHtPrime.toFixed(2)} W/(m²·K) überschreitet GEG-Referenz.`;
  return {
    id: "thermal",
    label: "Wärmeschutz",
    regulation: "GEG 2023",
    status,
    errorCount: errors,
    warnCount: warns,
    detail,
    targetTab: "energy",
  };
}

function runSite(
  layout: LayoutOption,
  plot: PlotAnalysis | null | undefined,
  hCoeff?: number,
): PermitCheck {
  if (layout.buildings.length === 0) {
    return {
      id: "site_abstand",
      label: "Abstandsflächen",
      regulation: "BauO NRW §6",
      status: "skipped",
      errorCount: 0,
      warnCount: 0,
      detail: "Keine Gebäude vorhanden.",
      targetTab: "site",
    };
  }
  const result = analyzeSite({
    layout,
    plotAreaSqm: plot?.area_sqm,
    plotBoundary: plot?.boundary_polygon_local,
    hCoeff,
  });
  const errors =
    result.summary.pairFails + result.summary.boundaryFails;
  const warns =
    result.summary.pairWarns + result.summary.boundaryWarns;
  const status = rollupStatus(errors, warns);
  const detail =
    status === "pass"
      ? layout.buildings.length === 1
        ? "§6-Abstand zur Grundstücksgrenze eingehalten."
        : `${result.pairs.length} Gebäudepaare & ${result.boundaries.length} Grenzabstände OK.`
      : status === "warn"
        ? `${warns} Grenzwertverletzungen (innerhalb 10 % Toleranz).`
        : `${errors} Abstandsflächen-Verstöße (§6 Abs. 1).`;
  return {
    id: "site_abstand",
    label: "Abstandsflächen",
    regulation: "BauO NRW §6",
    status,
    errorCount: errors,
    warnCount: warns,
    detail,
    targetTab: "site",
  };
}

function runRegulation(layout: LayoutOption): PermitCheck {
  const rc = layout.regulation_check;
  const errors = rc.violations.length;
  const warns = rc.warnings.length;
  const status: CheckStatus = rc.is_compliant
    ? warns > 0
      ? "warn"
      : "pass"
    : "fail";
  const detail =
    status === "pass"
      ? `GRZ ${rc.lot_coverage_pct.toFixed(0)} % / GFZ ${rc.far_used.toFixed(2)} innerhalb BauNVO.`
      : status === "warn"
        ? rc.warnings[0] ?? `${warns} Hinweise zur Bauleitplanung.`
        : rc.violations[0] ?? `${errors} Verstöße gegen BauNVO / §34.`;
  return {
    id: "regulation",
    label: "Planungsrecht",
    regulation: "BauNVO / BauGB §34",
    status,
    errorCount: errors,
    warnCount: warns,
    detail,
    targetTab: "layouts",
  };
}

// ── Aggregator ────────────────────────────────────────────────────

export function analyzePermitReadiness(
  input: PermitReadinessInput,
): PermitReadinessResult {
  const {
    layout,
    floorPlans,
    plot,
    thermalStandard = "goldbeck_standard",
    hCoeff,
  } = input;

  const checks: PermitCheck[] = [
    runRegulation(layout),
    runSite(layout, plot, hCoeff),
    runEgress(floorPlans),
    runBarrierFree(floorPlans),
    runBesonnung(floorPlans, plot, layout),
    runThermal(floorPlans, thermalStandard),
  ];

  const errorCount = checks.reduce((s, c) => s + c.errorCount, 0);
  const warnCount = checks.reduce((s, c) => s + c.warnCount, 0);
  const overall = verdictFromCounts(errorCount, warnCount);

  return { overall, checks, errorCount, warnCount };
}

// ── Presentation helpers ──────────────────────────────────────────

export function verdictLabel(v: PermitVerdict): string {
  switch (v) {
    case "ja":
      return "Genehmigungsfähig";
    case "bedingt":
      return "Bedingt genehmigungsfähig";
    case "nein":
      return "Nicht genehmigungsfähig";
  }
}

export function verdictColorClasses(v: PermitVerdict): string {
  switch (v) {
    case "ja":
      return "bg-emerald-50 border-emerald-300 text-emerald-900";
    case "bedingt":
      return "bg-amber-50 border-amber-300 text-amber-900";
    case "nein":
      return "bg-rose-50 border-rose-300 text-rose-900";
  }
}

export function statusColorClasses(s: CheckStatus): string {
  switch (s) {
    case "pass":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "warn":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "fail":
      return "bg-rose-100 text-rose-800 border-rose-200";
    case "skipped":
      return "bg-neutral-100 text-neutral-500 border-neutral-200";
  }
}

export function statusLabel(s: CheckStatus): string {
  switch (s) {
    case "pass":
      return "Erfüllt";
    case "warn":
      return "Hinweis";
    case "fail":
      return "Verstoß";
    case "skipped":
      return "—";
  }
}
