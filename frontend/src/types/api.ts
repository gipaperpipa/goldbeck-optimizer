export interface CoordinatePoint {
  lng: number;
  lat: number;
}

export interface PlotInput {
  mode: "coordinates" | "address";
  boundary_polygon?: CoordinatePoint[];
  address?: string;
  width_m?: number;
  depth_m?: number;
  vertices_m?: [number, number][];
}

export interface PlotAnalysis {
  area_sqm: number;
  area_acres: number;
  perimeter_m: number;
  width_m: number;
  depth_m: number;
  boundary_polygon_local: [number, number][];
  boundary_polygon_geo: CoordinatePoint[];
  centroid_geo: CoordinatePoint;
  address_resolved?: string;
  zoning_hint?: string;
}

export interface SetbackRequirements {
  front_m: number;
  rear_m: number;
  side_left_m: number;
  side_right_m: number;
}

export interface ParkingRequirements {
  studio_ratio: number;
  one_bed_ratio: number;
  two_bed_ratio: number;
  three_bed_ratio: number;
  commercial_ratio_per_1000sqm: number;
  guest_ratio: number;
}

export interface MinimumUnitSize {
  studio_sqm: number;
  one_bed_sqm: number;
  two_bed_sqm: number;
  three_bed_sqm: number;
}

export interface RegulationSet {
  zoning_type: string;
  setbacks: SetbackRequirements;
  max_far: number;
  max_height_m: number;
  max_stories: number;
  max_lot_coverage_pct: number;
  min_open_space_pct: number;
  parking: ParkingRequirements;
  min_unit_sizes: MinimumUnitSize;
  fire_access_width_m: number;
  min_building_separation_m: number;
  max_units_per_acre?: number;
  allow_commercial_ground_floor: boolean;
  max_impervious_surface_pct?: number;
}

export interface RegulationLookupResponse {
  regulations: RegulationSet;
  confidence: number;
  source_description: string;
  notes: string[];
  raw_zoning_code?: string;
}

export interface UnitMixEntry {
  unit_type: "studio" | "1br" | "2br" | "3br" | "commercial";
  count: number;
  avg_sqm: number;
  total_sqm: number;
}

export interface UnitMix {
  entries: UnitMixEntry[];
  total_units: number;
  total_residential_sqm: number;
  total_commercial_sqm: number;
}

export interface BuildingFootprint {
  id: string;
  building_type: string;
  position_x: number;
  position_y: number;
  width_m: number;
  depth_m: number;
  rotation_deg: number;
  stories: number;
  floor_height_m: number;
  total_height_m: number;
  gross_floor_area_sqm: number;
  net_floor_area_sqm: number;
  efficiency_factor: number;
  unit_mix?: UnitMix;
  ground_floor_commercial: boolean;
  ground_floor_commercial_sqm: number;
  ground_floor_parking: boolean;
}

export interface LayoutScores {
  overall: number;
  efficiency: number;
  financial: number;
  livability: number;
  compliance: number;
}

export interface RegulationCheckResult {
  is_compliant: boolean;
  violations: string[];
  warnings: string[];
  far_used: number;
  far_max: number;
  lot_coverage_pct: number;
  height_max_m: number;
  total_parking_required: number;
  total_parking_provided: number;
}

export interface BuildingFloorPlanResult {
  building_id: string;
  best_floor_plan?: BuildingFloorPlans;
  variants: FloorPlanVariant[];
}

export interface LayoutOption {
  id: string;
  rank: number;
  buildings: BuildingFootprint[];
  scores: LayoutScores;
  regulation_check: RegulationCheckResult;
  total_units: number;
  total_residential_sqm: number;
  total_commercial_sqm: number;
  total_parking_spaces: number;
  far_achieved: number;
  lot_coverage_pct: number;
  open_space_pct: number;
  building_separation_min_m: number;
  floor_plans: BuildingFloorPlanResult[];
}

export interface FloorPlanSettings {
  generations: number;
  population_size: number;
  story_height_m: number;
  weights: FloorPlanWeights;
}

export interface OptimizationRequest {
  plot: PlotAnalysis;
  regulations: RegulationSet;
  objective: string;
  unit_mix_preference: {
    studio_pct: number;
    one_bed_pct: number;
    two_bed_pct: number;
    three_bed_pct: number;
  };
  weights: {
    efficiency: number;
    financial: number;
    livability: number;
    compliance: number;
  };
  max_buildings: number;
  min_buildings: number;
  allow_podium_parking: boolean;
  allow_surface_parking: boolean;
  allow_structured_parking: boolean;
  population_size: number;
  generations: number;
  include_floor_plans: boolean;
  floor_plan_settings: FloorPlanSettings;
}

export interface FitnessHistoryEntry {
  generation: number;
  best_fitness: number;
  avg_fitness: number;
}

export interface OptimizationResult {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  progress_pct: number;
  current_generation: number;
  total_generations: number;
  best_fitness?: number;
  layouts: LayoutOption[];
  elapsed_seconds?: number;
  estimated_remaining_seconds?: number;
  fitness_history: FitnessHistoryEntry[];
  error?: string;
  phase?: "layout" | "floor_plans";
}

export interface CostBreakdown {
  land_cost: number;
  hard_costs_residential: number;
  hard_costs_commercial: number;
  hard_costs_parking: number;
  hard_costs_sitework: number;
  total_hard_costs: number;
  soft_costs_detail: Record<string, number>;
  total_soft_costs: number;
  total_development_cost: number;
  cost_per_unit: number;
  cost_per_sqm: number;
}

export interface RevenueBreakdown {
  monthly_residential_income: number;
  monthly_commercial_income: number;
  monthly_parking_income: number;
  gross_monthly_income: number;
  effective_gross_income_monthly: number;
  annual_noi: number;
  noi_per_unit: number;
}

export interface FinancialAnalysis {
  cost_breakdown: CostBreakdown;
  revenue_breakdown: RevenueBreakdown;
  total_development_cost: number;
  annual_noi: number;
  cap_rate: number;
  stabilized_value: number;
  equity_required: number;
  loan_amount: number;
  annual_debt_service: number;
  cash_on_cash_return_pct: number;
  roi_pct: number;
  yield_on_cost_pct: number;
  development_spread_bps: number;
  irr_pct?: number;
  equity_multiple?: number;
  profit_margin_pct: number;
  annual_cashflow_projection: {
    year: number;
    noi: number;
    debt_service: number;
    cashflow: number;
    cumulative_cashflow: number;
  }[];
}

export interface FinancialAnalysisRequest {
  layout: LayoutOption;
  plot_area_sqm: number;
  land_cost: number;
  construction_costs?: Record<string, number>;
  soft_cost_rates?: Record<string, number>;
  revenue_assumptions?: Record<string, number>;
  analysis_period_years?: number;
  financing_ltc_pct?: number;
  interest_rate_pct?: number;
  exit_cap_rate_pct?: number;
}

export interface ShadowSnapshot {
  time: string;
  sun_azimuth_deg: number;
  sun_altitude_deg: number;
  shadow_polygons: [number, number][][];
  direct_sunlight_pct: number;
}

export interface ShadowResult {
  snapshots: ShadowSnapshot[];
  avg_sunlight_pct: number;
  worst_sunlight_pct: number;
  best_sunlight_pct: number;
}

// ============================================
// Floor Plan Types (Goldbeck Construction System)
// ============================================

export type WallType =
  | "bearing_cross" | "corridor" | "outer_long" | "gable_end"
  | "staircase" | "elevator_shaft" | "partition" | "apt_separation";

export type RoomType =
  | "living" | "bedroom" | "kitchen" | "bathroom" | "hallway"
  | "storage" | "balcony" | "corridor" | "staircase" | "elevator" | "shaft";

export type AccessType = "ganghaus" | "spaenner" | "laubengang";

export interface Point2D {
  x: number;
  y: number;
}

export interface WallSegment {
  id: string;
  wall_type: WallType;
  start: Point2D;
  end: Point2D;
  thickness_m: number;
  is_bearing: boolean;
  is_exterior: boolean;
}

export interface DoorPlacement {
  id: string;
  position: Point2D;
  wall_id: string;
  width_m: number;
  height_m: number;
  is_entrance: boolean;
  swing_direction: string;
}

export interface WindowPlacement {
  id: string;
  position: Point2D;
  wall_id: string;
  width_m: number;
  height_m: number;
  sill_height_m: number;
  is_floor_to_ceiling: boolean;
}

export interface FloorPlanRoom {
  id: string;
  room_type: RoomType;
  polygon: Point2D[];
  area_sqm: number;
  label: string;
  apartment_id?: string;
}

export interface FloorPlanBathroom {
  id: string;
  bathroom_type: string;
  position: Point2D;
  width_m: number;
  depth_m: number;
  area_sqm: number;
}

export interface FloorPlanApartment {
  id: string;
  apartment_type: string;
  unit_number: string;
  side: string;
  rooms: FloorPlanRoom[];
  bathroom: FloorPlanBathroom;
  total_area_sqm: number;
  bay_indices: number[];
  entrance_door_id: string;
  has_balcony: boolean;
}

export interface FloorPlanStaircase {
  id: string;
  staircase_type: string;
  position: Point2D;
  width_m: number;
  depth_m: number;
  has_elevator: boolean;
  bay_index: number;
}

export interface StructuralGrid {
  origin: Point2D;
  bay_widths: number[];
  building_depth_m: number;
  building_length_m: number;
  south_zone_depth_m: number;
  north_zone_depth_m: number;
  corridor_width_m: number;
  corridor_y_start_m: number;
  story_height_m: number;
  axis_positions_x: number[];
  outer_wall_south_y: number;
  outer_wall_north_y: number;
  gallery_side?: string | null;  // "north" or "south" — Laubengang only
}

export interface FloorPlan {
  floor_index: number;
  structural_grid: StructuralGrid;
  walls: WallSegment[];
  doors: DoorPlacement[];
  windows: WindowPlacement[];
  apartments: FloorPlanApartment[];
  staircases: FloorPlanStaircase[];
  rooms: FloorPlanRoom[];
  access_type: AccessType;
  gross_area_sqm: number;
  net_area_sqm: number;
  num_apartments: number;
}

export interface BuildingFloorPlans {
  building_id: string;
  construction_system: string;
  building_width_m: number;
  building_depth_m: number;
  num_stories: number;
  story_height_m: number;
  access_type: AccessType;
  structural_grid: StructuralGrid;
  floor_plans: FloorPlan[];
  total_apartments: number;
  apartment_summary: Record<string, number>;
}

export interface FloorPlanWeights {
  efficiency: number;
  livability: number;
  revenue: number;
  compliance: number;
}

export interface FloorPlanRequest {
  building_id: string;
  building_width_m: number;
  building_depth_m: number;
  stories: number;
  rotation_deg?: number;
  unit_mix?: UnitMix;
  construction_system?: string;
  story_height_m?: number;
  prefer_barrier_free?: boolean;
  access_type_override?: AccessType;
  generations?: number;
  population_size?: number;
  weights?: FloorPlanWeights;
  use_ai_generation?: boolean;
}

export interface FloorPlanVariant {
  rank: number;
  fitness_score: number;
  fitness_breakdown?: Record<string, number>;
  building_floor_plans: BuildingFloorPlans;
}

export interface FloorPlanResult {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  building_floor_plans?: BuildingFloorPlans;
  variants: FloorPlanVariant[];
  progress_pct: number;
  current_generation: number;
  total_generations: number;
  best_fitness: number;
  elapsed_seconds: number;
  estimated_remaining_seconds: number;
  fitness_history: FitnessHistoryEntry[];
  error?: string;
}
