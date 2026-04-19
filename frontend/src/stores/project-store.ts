import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  PlotAnalysis,
  RegulationSet,
  GermanRegulationSet,
  OptimizationResult,
  LayoutOption,
  FinancialAnalysis,
  BuildingFloorPlans,
  FloorPlanVariant,
  FloorPlan,
} from "@/types/api";

// ── Edited-floor-plan persistence (Phase 3.7b) ─────────────────────────────
// A user-edited copy of a generated FloorPlan, stored alongside the original
// plan's fingerprint so that regenerations can invalidate stale edits.
export interface EditedFloorPlanEntry {
  /** Stable fingerprint of the ORIGINAL (unedited) plan, computed once at
   *  save time. On rehydrate, the viewer compares this against a freshly-
   *  computed fingerprint of the current floorPlan prop; mismatch → discard. */
  originalFingerprint: string;
  /** The edited plan (top of the user's undo stack at the time of last save). */
  plan: FloorPlan;
  /** Unix millis at save time — for telemetry and conflict-resolution UX. */
  savedAt: number;
}

/** Key format for `editedFloorPlans`. Combines the building id + floor index
 *  so a building's floors don't clobber each other. */
export const editedPlanKey = (buildingId: string, floorIndex: number) =>
  `${buildingId}:${floorIndex}`;

/**
 * Storage wrapper for the Zustand `persist` middleware that transparently
 * evicts the oldest entries from `editedFloorPlans` (by `savedAt`) when
 * `localStorage.setItem` throws `QuotaExceededError`. Without this a user
 * who edits ~100+ floor plans in one browser would start losing NEW edits
 * silently once the 5 MB origin cap is hit.
 *
 * Strategy:
 *  1. Try the write as-is.
 *  2. On quota error: parse the persisted payload, drop the oldest
 *     `editedFloorPlans` entry, re-stringify, retry.
 *  3. Repeat until the write succeeds or the map is empty (in which
 *     case propagate the original error — something else is oversized).
 *
 * Phase 3.7b add.
 */
function quotaAwareStorage(): Storage {
  const base =
    typeof window !== "undefined" ? window.localStorage : undefined;
  if (!base) {
    // Return the noop storage Zustand falls back to when window is absent
    // (SSR). Persist middleware calls setItem/getItem, so both need stubs.
    return {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {},
    };
  }
  const isQuotaError = (err: unknown): boolean => {
    if (err instanceof DOMException) {
      // Covers "QuotaExceededError" on Chromium/WebKit and
      // "NS_ERROR_DOM_QUOTA_REACHED" on Firefox.
      return (
        err.code === 22 ||
        err.code === 1014 ||
        err.name === "QuotaExceededError" ||
        err.name === "NS_ERROR_DOM_QUOTA_REACHED"
      );
    }
    return false;
  };
  return {
    get length() {
      return base.length;
    },
    clear: () => base.clear(),
    getItem: (k) => base.getItem(k),
    key: (i) => base.key(i),
    removeItem: (k) => base.removeItem(k),
    setItem: (k, v) => {
      try {
        base.setItem(k, v);
        return;
      } catch (err) {
        if (!isQuotaError(err)) throw err;
      }
      // Quota hit — parse, evict oldest editedFloorPlans entry, retry.
      let payload: string = v;
      const MAX_EVICT = 50; // hard stop; each loop drops 1 entry
      for (let i = 0; i < MAX_EVICT; i++) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          throw new Error(
            "[project-store] quota exceeded and payload not JSON-parseable",
          );
        }
        const p = parsed as {
          state?: { editedFloorPlans?: Record<string, EditedFloorPlanEntry> };
        };
        const edits = p.state?.editedFloorPlans;
        if (!edits || Object.keys(edits).length === 0) {
          throw new Error(
            "[project-store] quota exceeded with no edits to evict — other slices too large",
          );
        }
        // Find oldest by savedAt
        let oldestKey: string | null = null;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [key, entry] of Object.entries(edits)) {
          if (entry.savedAt < oldestAt) {
            oldestAt = entry.savedAt;
            oldestKey = key;
          }
        }
        if (!oldestKey) break;
        delete edits[oldestKey];
        payload = JSON.stringify(parsed);
        try {
          base.setItem(k, payload);
          if (typeof console !== "undefined") {
            console.info(
              `[project-store] evicted stale edit "${oldestKey}" to free localStorage`,
            );
          }
          return;
        } catch (err) {
          if (!isQuotaError(err)) throw err;
          // Still over — loop evicts another entry.
        }
      }
      throw new Error(
        "[project-store] localStorage quota exceeded after evicting all edits",
      );
    },
  };
}

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

  // ── User edits to generated plans (Phase 3.7b) ─────────────────────────
  /** Edited floor plans keyed by `${buildingId}:${floorIndex}`. Persisted
   *  via the `persist` middleware so edits survive a page reload. */
  editedFloorPlans: Record<string, EditedFloorPlanEntry>;
  /** Save a user-edited plan. The viewer computes `originalFingerprint`
   *  from its `floorPlan` prop once and passes it in here. */
  setEditedFloorPlan: (
    key: string,
    entry: { originalFingerprint: string; plan: FloorPlan },
  ) => void;
  /** Remove the edited plan for a given key (Reset). */
  clearEditedFloorPlan: (key: string) => void;
  /** Remove all edited plans (invoked on project reset). */
  clearAllEditedFloorPlans: () => void;

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

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
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

  // ── Edited floor plans (Phase 3.7b) — survives page reload ──────────
  editedFloorPlans: {},
  setEditedFloorPlan: (key, entry) =>
    set((state) => ({
      editedFloorPlans: {
        ...state.editedFloorPlans,
        [key]: { ...entry, savedAt: Date.now() },
      },
    })),
  clearEditedFloorPlan: (key) =>
    set((state) => {
      if (!(key in state.editedFloorPlans)) return state;
      const next = { ...state.editedFloorPlans };
      delete next[key];
      return { editedFloorPlans: next };
    }),
  clearAllEditedFloorPlans: () => set({ editedFloorPlans: {} }),

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
      editedFloorPlans: {},
      selectedVariantIndex: 0,
      selectedBuildingId: null,
      selectedFloorIndex: 0,
      activeTab: "site-plan",
      _undoStack: [],
      _redoStack: [],
      canUndo: false,
      canRedo: false,
    }),
    }),
    {
      name: "goldbeck-project-store",
      // Wrap localStorage in an LRU-evicting shim so hitting the 5 MB
      // origin cap drops the oldest edited floor plans instead of
      // silently losing the new write.
      storage: createJSONStorage(() => quotaAwareStorage()),
      version: 1,
      // Only persist the slices a user wants to survive a page reload.
      // Skipped: large transient results (`optimizationResult`), UI-only
      // flags (`activeTab`, `currentStep`), and the in-memory undo stacks
      // (`_undoStack`, `_redoStack`, `canUndo`, `canRedo` — each session
      // gets a fresh undo history).
      partialize: (state) => ({
        plotAnalysis: state.plotAnalysis,
        regulations: state.regulations,
        regulationMode: state.regulationMode,
        germanRegulations: state.germanRegulations,
        selectedLayout: state.selectedLayout,
        financialAnalysis: state.financialAnalysis,
        floorPlans: state.floorPlans,
        floorPlanVariants: state.floorPlanVariants,
        editedFloorPlans: state.editedFloorPlans,
        selectedVariantIndex: state.selectedVariantIndex,
        selectedBuildingId: state.selectedBuildingId,
        selectedFloorIndex: state.selectedFloorIndex,
      }),
    },
  ),
);
