/**
 * Goldbeck precast construction cost estimator (Phase 4.3).
 *
 * Pure functional cost model following DIN 276 (Kostengliederung) and
 * BKI 2024 residential benchmarks, adjusted down 8–12% for Goldbeck's
 * precast concrete system vs. conventional monolithic construction.
 *
 * Rates are German national averages for mid-range residential
 * (Wohnungsbau KG-Mittelwert). Regional factors (Berlin / München /
 * rural) can be applied via the `regionalFactor` parameter.
 *
 * All figures in Euro, exclusive VAT (German convention for
 * cost planning).
 */

import type { BuildingFloorPlans, FloorPlanRoom } from "@/types/api";

// ── Rates (€/m² or €/m³) ──────────────────────────────────────────

/** Base construction cost per m² BGF (Bruttogrundfläche) for Goldbeck
 *  precast residential mid-range (2024 BKI adjusted).
 *  KG 300 = Bauwerk Baukonstruktion (structure, envelope, finishes). */
const KG300_PER_SQM_BGF = 1_750; // €/m²

/** KG 400 = Bauwerk Technische Anlagen (HVAC, plumbing, electrical). */
const KG400_PER_SQM_BGF = 520; // €/m²

/** KG 500 = Außenanlagen (landscaping, paving, outdoor fixtures) —
 *  typically 3% of (KG 300 + KG 400). */
const KG500_RATIO_OF_300_400 = 0.03;

/** KG 700 = Baunebenkosten (architects, engineers, permits, insurance,
 *  financing). Typically 16–20% of (KG 300 + KG 400 + KG 500). */
const KG700_RATIO_OF_HARD_COSTS = 0.18;

/** Contingency reserve on top of everything — 5% is standard for
 *  precast projects (less than monolithic's 8–10% because Goldbeck's
 *  fixed grid removes many risk sources). */
const CONTINGENCY_RATIO = 0.05;

/** Rental benchmarks — cold rent per m² NGF per month. */
const RENT_PER_SQM_MONTH_BY_MARKET: Record<string, number> = {
  berlin: 15.5,
  munich: 23.0,
  hamburg: 17.0,
  frankfurt: 18.5,
  cologne: 14.5,
  stuttgart: 17.5,
  dresden: 12.0,
  leipzig: 11.5,
  rural: 9.0,
  default: 14.0,
};

/** Sale price benchmarks — €/m² NGF for condominiums (Eigentumswohnungen). */
const SALE_PRICE_PER_SQM_NGF_BY_MARKET: Record<string, number> = {
  berlin: 6_200,
  munich: 10_500,
  hamburg: 7_200,
  frankfurt: 7_800,
  cologne: 5_800,
  stuttgart: 6_500,
  dresden: 4_500,
  leipzig: 4_000,
  rural: 3_200,
  default: 5_500,
};

// ── Types ─────────────────────────────────────────────────────────

export type Market = keyof typeof RENT_PER_SQM_MONTH_BY_MARKET;

export interface CostEstimateInput {
  building: BuildingFloorPlans;
  /** Market for revenue benchmarks. Default: "default" (national avg). */
  market?: Market;
  /** Multiplier on KG300 to account for regional construction-cost
   *  premiums (0.95 for rural East Germany, 1.15 for München). */
  regionalFactor?: number;
  /** Land cost in Euro for the plot. Optional; if omitted, the
   *  margin calculation excludes land. */
  landCostEur?: number;
}

export interface CostBreakdown {
  /** KG 300 Bauwerk Baukonstruktion (structure + envelope). */
  kg300: number;
  /** KG 400 Bauwerk Technische Anlagen (MEP). */
  kg400: number;
  /** KG 500 Außenanlagen. */
  kg500: number;
  /** KG 700 Baunebenkosten (soft costs). */
  kg700: number;
  /** Contingency. */
  contingency: number;
  /** Sum of all construction + soft costs (KG 300–700 + contingency). */
  totalConstruction: number;
  /** Land cost if provided, else 0. */
  land: number;
  /** Grand total including land. */
  total: number;
}

export interface AreaMetrics {
  /** Bruttogrundfläche — gross floor area including walls. */
  bgfSqm: number;
  /** Nettogrundfläche — net floor area (rooms + apartment circulation). */
  ngfSqm: number;
  /** Total exterior facade area (perimeter × total height). */
  facadeSqm: number;
  /** Roof footprint. */
  roofSqm: number;
  /** Gross volume (BRI — Bruttorauminhalt). */
  briCbm: number;
  /** Total number of stories counted as Vollgeschosse (incl. staffel). */
  stories: number;
}

export interface RevenueEstimate {
  /** Monthly cold rent (Kaltmiete) at market rate. */
  monthlyRent: number;
  /** Annual cold rent. */
  annualRent: number;
  /** Total sale value if selling all units as condos. */
  saleValue: number;
  /** Vacancy assumption (5% for Berlin, 3% for Munich). */
  vacancyPct: number;
  /** Effective annual income after vacancy. */
  effectiveAnnualRent: number;
}

export interface CostEstimate {
  /** Area metrics (inputs to cost model). */
  areas: AreaMetrics;
  /** KG-by-KG cost breakdown. */
  costs: CostBreakdown;
  /** Derived per-unit + per-m² metrics. */
  perUnit: {
    totalCost: number;
    constructionCost: number;
  };
  perSqmBgf: {
    totalCost: number;
    constructionCost: number;
    kg300: number;
    kg400: number;
  };
  perSqmNgf: {
    totalCost: number;
    constructionCost: number;
  };
  /** Revenue side. */
  revenue: RevenueEstimate;
  /** Total cost / sale value — below 0.75 is healthy. */
  costToValueRatio: number;
  /** Sale value − total cost. */
  grossMargin: number;
  grossMarginPct: number;
  /** Market used for revenue. */
  market: Market;
  /** Region factor applied. */
  regionalFactor: number;
}

// ── Area computation ──────────────────────────────────────────────

function computeAreas(building: BuildingFloorPlans): AreaMetrics {
  let bgfSqm = 0;
  let ngfSqm = 0;
  const storyHeight = building.story_height_m || 2.75;
  const stories = building.num_stories;

  for (const floor of building.floor_plans) {
    const grid = floor.structural_grid;
    const floorBgf = grid.building_length_m * grid.building_depth_m;
    bgfSqm += floorBgf;

    // NGF = sum of room areas excluding technical shafts and balconies
    // (balconies count as Nutzfläche NUF but not NGF in German practice).
    for (const room of floor.rooms as FloorPlanRoom[]) {
      if (room.room_type === "shaft" || room.room_type === "balcony") continue;
      ngfSqm += room.area_sqm;
    }
  }

  // Facade area = sum per floor of (perimeter × story_height). Uses each
  // floor's own grid so Staffelgeschoss contributes correctly.
  let facadeSqm = 0;
  for (const floor of building.floor_plans) {
    const grid = floor.structural_grid;
    const perim = 2 * (grid.building_length_m + grid.building_depth_m);
    facadeSqm += perim * storyHeight;
  }

  // Roof = the topmost floor's footprint (Staffelgeschoss lands on the
  // lower roof but for simplicity we use the top floor's grid).
  const topFloor = building.floor_plans[building.floor_plans.length - 1];
  const roofSqm = topFloor
    ? topFloor.structural_grid.building_length_m * topFloor.structural_grid.building_depth_m
    : bgfSqm / stories;

  const briCbm = bgfSqm * storyHeight;

  return { bgfSqm, ngfSqm, facadeSqm, roofSqm, briCbm, stories };
}

// ── Main estimator ────────────────────────────────────────────────

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const { building } = input;
  const market = (input.market ?? "default") as Market;
  const regionalFactor = input.regionalFactor ?? 1.0;

  const areas = computeAreas(building);

  // KG 300 scaled by regional factor (the majority of the variance);
  // KG 400 is mostly equipment + labor at the standard national rate.
  const kg300 = areas.bgfSqm * KG300_PER_SQM_BGF * regionalFactor;
  const kg400 = areas.bgfSqm * KG400_PER_SQM_BGF;
  const kg500 = (kg300 + kg400) * KG500_RATIO_OF_300_400;
  const hardCosts = kg300 + kg400 + kg500;
  const kg700 = hardCosts * KG700_RATIO_OF_HARD_COSTS;
  const contingency = (hardCosts + kg700) * CONTINGENCY_RATIO;
  const totalConstruction = hardCosts + kg700 + contingency;
  const land = input.landCostEur ?? 0;
  const total = totalConstruction + land;

  const costs: CostBreakdown = {
    kg300,
    kg400,
    kg500,
    kg700,
    contingency,
    totalConstruction,
    land,
    total,
  };

  const units = Math.max(1, building.total_apartments);

  const rentPerSqm = RENT_PER_SQM_MONTH_BY_MARKET[market] ?? RENT_PER_SQM_MONTH_BY_MARKET.default;
  const salePerSqm = SALE_PRICE_PER_SQM_NGF_BY_MARKET[market] ?? SALE_PRICE_PER_SQM_NGF_BY_MARKET.default;

  const monthlyRent = areas.ngfSqm * rentPerSqm;
  const annualRent = monthlyRent * 12;
  const vacancyPct = market === "munich" || market === "frankfurt" ? 3 : market === "rural" || market === "leipzig" ? 8 : 5;
  const effectiveAnnualRent = annualRent * (1 - vacancyPct / 100);
  const saleValue = areas.ngfSqm * salePerSqm;

  const revenue: RevenueEstimate = {
    monthlyRent,
    annualRent,
    saleValue,
    vacancyPct,
    effectiveAnnualRent,
  };

  const costToValueRatio = saleValue > 0 ? total / saleValue : 0;
  const grossMargin = saleValue - total;
  const grossMarginPct = saleValue > 0 ? (grossMargin / saleValue) * 100 : 0;

  return {
    areas,
    costs,
    perUnit: {
      totalCost: total / units,
      constructionCost: totalConstruction / units,
    },
    perSqmBgf: {
      totalCost: areas.bgfSqm > 0 ? total / areas.bgfSqm : 0,
      constructionCost: areas.bgfSqm > 0 ? totalConstruction / areas.bgfSqm : 0,
      kg300: areas.bgfSqm > 0 ? kg300 / areas.bgfSqm : 0,
      kg400: areas.bgfSqm > 0 ? kg400 / areas.bgfSqm : 0,
    },
    perSqmNgf: {
      totalCost: areas.ngfSqm > 0 ? total / areas.ngfSqm : 0,
      constructionCost: areas.ngfSqm > 0 ? totalConstruction / areas.ngfSqm : 0,
    },
    revenue,
    costToValueRatio,
    grossMargin,
    grossMarginPct,
    market,
    regionalFactor,
  };
}

/** Format a Euro amount with German grouping separators.
 *  Example: 1234567.89 → "1.234.568 €". */
export function formatEur(value: number, decimals: number = 0): string {
  const rounded = decimals === 0 ? Math.round(value) : value;
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(rounded);
}

/** Format area with German convention "123,4 m²". */
export function formatArea(sqm: number): string {
  return `${sqm.toLocaleString("de-DE", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} m²`;
}
