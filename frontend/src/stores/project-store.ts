import { create } from "zustand";
import type {
  PlotAnalysis,
  RegulationSet,
  GermanRegulationSet,
  OptimizationResult,
  LayoutOption,
  FinancialAnalysis,
  BuildingFloorPlans,
  FloorPlanVariant,
} from "@/types/api";

// ── Undo/Redo snapshot ───────────────────────────────────────────────
// Only tracks the fields that represent meaningful user decisions.

interface UndoableSnapshot {
  selectedLayout: LayoutOption | null;
  floorPlans: Record<string, BuildingFloorPlans>;
  floorPlanVariants: Record<string, FloorPlanVariant[]>;
  selectedVariantIndex: number;
  selectedBuildingId: string | null;
  selectedFloorIndex: number;
  regulations: RegulationSet | null;
}

const MAX_HISTORY = 30;

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
  regulationMode: "german" | "international";
  setRegulationMode: (mode: "german" | "international") => void;
  germanRegulations: GermanRegulationSet | null;
  setGermanRegulations: (regs: GermanRegulationSet | null) => void;

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

  // Undo/Redo
  _undoStack: UndoableSnapshot[];
  _redoStack: UndoableSnapshot[];
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Manually push a snapshot before a significant change. Called automatically
   *  by setSelectedLayout, setFloorPlan, and setRegulations. */
  _pushSnapshot: () => void;

  // Reset
  reset: () => void;
}

function _takeSnapshot(state: ProjectState): UndoableSnapshot {
  return {
    selectedLayout: state.selectedLayout,
    floorPlans: { ...state.floorPlans },
    floorPlanVariants: { ...state.floorPlanVariants },
    selectedVariantIndex: state.selectedVariantIndex,
    selectedBuildingId: state.selectedBuildingId,
    selectedFloorIndex: state.selectedFloorIndex,
    regulations: state.regulations,
  };
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentStep: 0,
  setCurrentStep: (step) => set({ currentStep: step }),

  plotAnalysis: null,
  setPlotAnalysis: (analysis) => set({ plotAnalysis: analysis }),

  regulations: null,
  setRegulations: (regs) => {
    get()._pushSnapshot();
    set({ regulations: regs });
  },
  regulationMode: "german" as "german" | "international",
  setRegulationMode: (mode) => set({ regulationMode: mode }),
  germanRegulations: null,
  setGermanRegulations: (regs) => set({ germanRegulations: regs }),

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
    get()._pushSnapshot();
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
  setFloorPlan: (buildingId, plans) => {
    get()._pushSnapshot();
    set((state) => ({
      floorPlans: { ...state.floorPlans, [buildingId]: plans },
    }));
  },
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

  // ── Undo / Redo ────────────────────────────────────────────────────
  _undoStack: [],
  _redoStack: [],
  canUndo: false,
  canRedo: false,

  _pushSnapshot: () => {
    const state = get();
    const snapshot = _takeSnapshot(state);
    const newStack = [...state._undoStack, snapshot].slice(-MAX_HISTORY);
    set({ _undoStack: newStack, _redoStack: [], canUndo: true, canRedo: false });
  },

  undo: () => {
    const state = get();
    if (state._undoStack.length === 0) return;
    const current = _takeSnapshot(state);
    const prev = state._undoStack[state._undoStack.length - 1];
    const newUndo = state._undoStack.slice(0, -1);
    const newRedo = [...state._redoStack, current];
    set({
      ...prev,
      _undoStack: newUndo,
      _redoStack: newRedo,
      canUndo: newUndo.length > 0,
      canRedo: true,
    });
  },

  redo: () => {
    const state = get();
    if (state._redoStack.length === 0) return;
    const current = _takeSnapshot(state);
    const next = state._redoStack[state._redoStack.length - 1];
    const newRedo = state._redoStack.slice(0, -1);
    const newUndo = [...state._undoStack, current];
    set({
      ...next,
      _undoStack: newUndo,
      _redoStack: newRedo,
      canUndo: true,
      canRedo: newRedo.length > 0,
    });
  },

  reset: () =>
    set({
      currentStep: 0,
      plotAnalysis: null,
      regulations: null,
      regulationMode: "german" as "german" | "international",
      germanRegulations: null,
      optimizationResult: null,
      selectedLayout: null,
      financialAnalysis: null,
      floorPlans: {},
      floorPlanVariants: {},
      selectedVariantIndex: 0,
      selectedBuildingId: null,
      selectedFloorIndex: 0,
      activeTab: "site-plan",
      _undoStack: [],
      _redoStack: [],
      canUndo: false,
      canRedo: false,
    }),
}));
