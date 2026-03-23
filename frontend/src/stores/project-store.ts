import { create } from "zustand";
import type {
  PlotAnalysis,
  RegulationSet,
  OptimizationResult,
  LayoutOption,
  FinancialAnalysis,
  BuildingFloorPlans,
  FloorPlanVariant,
} from "@/types/api";

interface ProjectState {
  // Step tracking
  currentStep: number;
  setCurrentStep: (step: number) => void;

  // Plot
  plotAnalysis: PlotAnalysis | null;
  setPlotAnalysis: (analysis: PlotAnalysis | null) => void;

  // Regulations
  regulations: RegulationSet | null;
  setRegulations: (regs: RegulationSet) => void;

  // Optimization
  optimizationResult: OptimizationResult | null;
  setOptimizationResult: (result: OptimizationResult | null) => void;

  // Selected layout
  selectedLayout: LayoutOption | null;
  setSelectedLayout: (layout: LayoutOption | null) => void;

  // Financial
  financialAnalysis: FinancialAnalysis | null;
  setFinancialAnalysis: (analysis: FinancialAnalysis | null) => void;

  // Floor plans
  floorPlans: Record<string, BuildingFloorPlans>;
  setFloorPlan: (buildingId: string, plans: BuildingFloorPlans) => void;
  floorPlanVariants: Record<string, FloorPlanVariant[]>;
  setFloorPlanVariants: (buildingId: string, variants: FloorPlanVariant[]) => void;
  selectedVariantIndex: number;
  setSelectedVariantIndex: (index: number) => void;
  clearFloorPlans: (buildingId?: string) => void;
  selectedBuildingId: string | null;
  setSelectedBuildingId: (id: string | null) => void;
  selectedFloorIndex: number;
  setSelectedFloorIndex: (index: number) => void;

  // UI state
  activeTab: string;
  setActiveTab: (tab: string) => void;

  // Reset
  reset: () => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentStep: 0,
  setCurrentStep: (step) => set({ currentStep: step }),

  plotAnalysis: null,
  setPlotAnalysis: (analysis) => set({ plotAnalysis: analysis }),

  regulations: null,
  setRegulations: (regs) => set({ regulations: regs }),

  optimizationResult: null,
  setOptimizationResult: (result) => {
    // If combined mode, auto-populate floor plans from layouts
    const newFloorPlans: Record<string, BuildingFloorPlans> = {};
    const newVariants: Record<string, FloorPlanVariant[]> = {};

    if (result?.layouts) {
      // Use the first (selected) layout's floor plans
      const firstLayout = result.layouts[0];
      if (firstLayout?.floor_plans?.length > 0) {
        for (const fp of firstLayout.floor_plans) {
          if (fp.best_floor_plan) {
            newFloorPlans[fp.building_id] = fp.best_floor_plan;
          }
          if (fp.variants?.length > 0) {
            newVariants[fp.building_id] = fp.variants;
          }
        }
      }
    }

    set({
      optimizationResult: result,
      ...(Object.keys(newFloorPlans).length > 0 ? { floorPlans: newFloorPlans } : {}),
      ...(Object.keys(newVariants).length > 0 ? { floorPlanVariants: newVariants } : {}),
    });
  },

  selectedLayout: null,
  setSelectedLayout: (layout) => {
    // When selecting a layout, populate floor plans if available (combined mode)
    const newFloorPlans: Record<string, BuildingFloorPlans> = {};
    const newVariants: Record<string, FloorPlanVariant[]> = {};

    if (layout?.floor_plans && layout.floor_plans.length > 0) {
      for (const fp of layout.floor_plans) {
        if (fp.best_floor_plan) {
          newFloorPlans[fp.building_id] = fp.best_floor_plan;
        }
        if (fp.variants?.length > 0) {
          newVariants[fp.building_id] = fp.variants;
        }
      }
    }

    set({
      selectedLayout: layout,
      selectedBuildingId: null,
      selectedFloorIndex: 0,
      selectedVariantIndex: 0,
      // Always reset floor plans when switching layouts — old building data must not persist
      floorPlans: newFloorPlans,
      floorPlanVariants: newVariants,
    });
  },

  financialAnalysis: null,
  setFinancialAnalysis: (analysis) => set({ financialAnalysis: analysis }),

  floorPlans: {},
  setFloorPlan: (buildingId, plans) =>
    set((state) => ({
      floorPlans: { ...state.floorPlans, [buildingId]: plans },
    })),
  floorPlanVariants: {},
  setFloorPlanVariants: (buildingId, variants) =>
    set((state) => ({
      floorPlanVariants: { ...state.floorPlanVariants, [buildingId]: variants },
    })),
  clearFloorPlans: (buildingId) =>
    set((state) => {
      if (buildingId) {
        const fp = { ...state.floorPlans };
        const fv = { ...state.floorPlanVariants };
        delete fp[buildingId];
        delete fv[buildingId];
        return { floorPlans: fp, floorPlanVariants: fv, selectedVariantIndex: 0 };
      }
      return { floorPlans: {}, floorPlanVariants: {}, selectedVariantIndex: 0 };
    }),
  selectedVariantIndex: 0,
  setSelectedVariantIndex: (index) => set({ selectedVariantIndex: index }),
  selectedBuildingId: null,
  setSelectedBuildingId: (id) => set({ selectedBuildingId: id }),
  selectedFloorIndex: 0,
  setSelectedFloorIndex: (index) => set({ selectedFloorIndex: index }),

  activeTab: "site-plan",
  setActiveTab: (tab) => set({ activeTab: tab }),

  reset: () =>
    set({
      currentStep: 0,
      plotAnalysis: null,
      regulations: null,
      optimizationResult: null,
      selectedLayout: null,
      financialAnalysis: null,
      floorPlans: {},
      floorPlanVariants: {},
      selectedVariantIndex: 0,
      selectedBuildingId: null,
      selectedFloorIndex: 0,
      activeTab: "site-plan",
    }),
}));
