"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type {
  FloorPlan,
  FloorPlanApartment,
  Point2D,
  WallSegment,
  WindowPlacement,
  DoorPlacement,
  FloorPlanRoom,
} from "@/types/api";
import { useProjectStore, editedPlanKey } from "@/stores/project-store";
import {
  fetchOverride,
  putOverride,
  deleteOverride,
} from "@/lib/floorplan-overrides";
import {
  placeFurnitureForPlan,
  FURNITURE_COLORS,
  type FurniturePlacement,
  type RoomFurnitureResult,
} from "@/lib/furniture-layouts";
import { downloadFloorPlanPdf, downloadMultiPlanPdf, type ExportPdfOptions } from "@/lib/floorplan-pdf";
import { analyzeEgress } from "@/lib/fire-egress";
import { analyzeBarrierFree } from "@/lib/barrier-free";
import { analyzeBesonnung } from "@/lib/besonnung";

/** Props for the 2D canvas floor plan renderer.
 * @property floorPlan - Single-storey floor plan data (rooms, walls, doors, windows).
 * @property width - Canvas width in px (default: container width).
 * @property height - Canvas height in px (default: container height).
 * @property selectedApartmentId - Highlights the apartment with this ID.
 * @property onApartmentSelect - Fires when user clicks an apartment (null = deselect).
 */
interface FloorPlanViewerProps {
  floorPlan: FloorPlan;
  width?: number;
  height?: number;
  selectedApartmentId?: string | null;
  onApartmentSelect?: (apt: FloorPlanApartment | null) => void;
  /** When both `buildingId` and `floorIndex` are provided, user edits are
   *  persisted to the Zustand store (localStorage-backed) under the key
   *  `${buildingId}:${floorIndex}`. Page reload restores the saved edits
   *  if the plan's fingerprint still matches (Phase 3.7b). */
  buildingId?: string;
  floorIndex?: number;
  /** All floor plans of the current building. When provided, the toolbar
   *  gains an "Alle Geschosse PDF" button that batch-exports every floor
   *  to a single multi-page A3 PDF (Phase 5b). */
  allFloors?: FloorPlan[];
  /** Plot latitude in decimal degrees — enables DIN 5034 Besonnung
   *  check. Skipped when undefined. */
  latitude?: number;
  longitude?: number;
  /** Building rotation (CCW about +z, degrees). Plan +y = north when 0. */
  buildingRotationDeg?: number;
}

/**
 * Professional architectural color palette for floor plan rooms.
 * Colors follow DIN 1356 conventions: warm tones for living spaces,
 * cool tones for wet rooms, neutral for circulation/service areas.
 */
const ROOM_COLORS: Record<string, string> = {
  living: "#e8dcc8",      // Warm beige — primary living space
  bedroom: "#d4e4d0",     // Soft sage green — sleeping/private rooms
  kitchen: "#dbe4c8",     // Light olive — food preparation
  bathroom: "#d9e4f0",    // Soft blue-gray — wet rooms
  hallway: "#f0ebe5",     // Light neutral — internal circulation
  storage: "#d9d0c8",     // Warm gray — Abstellraum
  balcony: "#f5f5e8",     // Very light cream — outdoor space
  corridor: "#e8e5e0",    // Light gray — common circulation (Ganghaus/Laubengang)
  staircase: "#d4d0c8",   // Medium taupe — vertical circulation
  elevator: "#d4d0c8",    // Medium taupe — vertical circulation
  shaft: "#c4c0b8",       // Neutral gray — TGA shafts
};

const ROOM_BORDER_COLORS: Record<string, string> = {
  living: "#8b7d70",
  bedroom: "#6b8866",
  kitchen: "#7a8866",
  bathroom: "#667a8b",
  hallway: "#998877",
  storage: "#8b8277",
  corridor: "#8b8277",
  staircase: "#7a7066",
  elevator: "#7a7066",
  shaft: "#6b6661",
};

/**
 * Snap radius for the measurement tool, in plan coordinates (meters).
 * 0.3m (~30cm) is roughly one Goldbeck grid half-unit (GRID_UNIT = 0.625m / 2).
 * This gives a comfortable snap zone without being too "grabby" at typical zoom.
 */
const SNAP_RADIUS = 0.3;

/**
 * Goldbeck structural grid unit — partition walls snap to 62.5cm increments
 * during interactive drag. Matches Schottwand panel spacing.
 */
const GRID_UNIT_M = 0.625;

/**
 * DIN 18011 / Wohnflächenverordnung minimum room areas (m²) — mirrors
 * `ApartmentRules.MIN_ROOM_AREAS` in the backend. Used to validate
 * partition-wall drags: if a drag would shrink a room below its minimum,
 * the preview turns red and the drag is rejected on release.
 */
const MIN_ROOM_AREA_SQM: Record<string, number> = {
  living: 14.0,
  bedroom: 8.0,
  kitchen: 4.0,
  bathroom: 2.5,
  hallway: 1.5,
  storage: 0.5,
};

/** Tolerance for matching room polygon vertices to a wall axis (meters). */
const VERTEX_MATCH_TOL = 0.05;

/** Maximum skew (meters) to still treat a wall as axis-aligned. */
const AXIS_ALIGN_TOL = 0.01;

type WallAxis = "x" | "y";

/**
 * Kinds of wall drag — each applies different validation + snap behaviour.
 *   • "partition"    — single non-bearing partition, 62.5cm grid snap,
 *                      DIN minimum area check only (Phase 3.6a).
 *   • "apt_boundary" — bearing_cross wall sitting between two apartments,
 *                      all co-axis segments drag together, snaps to
 *                      structural-grid bay axis positions, adds minimum
 *                      apartment-width check (Phase 3.6b).
 */
type WallDragKind = "partition" | "apt_boundary";

interface WallDragState {
  wallId: string;              // id of the wall the cursor picked up
  kind: WallDragKind;
  axis: WallAxis;              // which plan axis the wall moves along
  original: number;            // original wall position on that axis
  current: number;             // snapped current position (updated during drag)
  minPos: number;              // min allowed position (from adjacent rooms)
  maxPos: number;              // max allowed position
  affectedWallIds: string[];   // all walls that move together (co-axis group)
  affectedRoomIds: string[];   // rooms whose vertices move with the wall
  valid: boolean;              // false if validation fails (DIN / apt width)
  invalidReason?: string;      // human-readable reason for overlay tooltip
}

/** Minimum apartment width (m) — apartments must keep ≥ this span along
 *  the building length when an apt-boundary wall is dragged. */
const MIN_APARTMENT_WIDTH_M = 3.125;  // narrowest Goldbeck bay

// ── Opening drag (Phase 3.6c) ─────────────────────────────────────────────
/** Minimum distance (m) from an opening edge to the end of its host wall. */
const MIN_OPENING_EDGE_M = 0.15;
/** Minimum gap (m) between two openings on the same host wall. */
const MIN_OPENING_GAP_M = 0.10;
/** Snap increment (m) while dragging/resizing openings — 6.25cm = 1/10 grid. */
const OPENING_SNAP_M = 0.0625;
/** Window width range (m) — enforced on resize. */
const MIN_WINDOW_WIDTH_M = 0.60;
const MAX_WINDOW_WIDTH_M = 4.00;
/** Defaults for newly-placed openings (Phase 3.6c add). Windows: 1.20×1.50m
 *  with a 0.90m sill (DIN 5034 typical). Doors: 0.95m barrier-free leaf,
 *  2.00m head height (BauO NRW §50). */
const DEFAULT_WINDOW_WIDTH_M = 1.20;
const DEFAULT_WINDOW_HEIGHT_M = 1.50;
const DEFAULT_WINDOW_SILL_M = 0.90;
const DEFAULT_DOOR_WIDTH_M = 0.95;
const DEFAULT_DOOR_HEIGHT_M = 2.00;
/** Hit-test tolerance (m) perpendicular to a wall for opening pick. */
const OPENING_HIT_TOL_PERP_M = 0.30;
/** Hit-test radius (screen px) for window resize handles. */
const RESIZE_HANDLE_RADIUS_PX = 7;

type OpeningKind = "door" | "window";

// ── Room reassignment (Phase 3.6d) ────────────────────────────────────────
/** Room types the user can assign via the reassignment popover. Structural
 *  / common-area types (corridor, staircase, elevator, shaft, balcony) are
 *  intentionally omitted — they carry positional / architectural semantics
 *  that aren't meaningful to flip arbitrarily. */
const REASSIGNABLE_ROOM_TYPES: ReadonlyArray<
  "living" | "bedroom" | "kitchen" | "bathroom" | "hallway" | "storage"
> = ["living", "bedroom", "kitchen", "bathroom", "hallway", "storage"];

/** Mapping of the reassignable types to their German-leaning display labels
 *  (the popover UI uses these). */
const ROOM_TYPE_LABELS: Record<(typeof REASSIGNABLE_ROOM_TYPES)[number], string> = {
  living: "Wohnen",
  bedroom: "Schlafen",
  kitchen: "Küche",
  bathroom: "Bad",
  hallway: "Flur",
  storage: "Abstellraum",
};

// ── Undo/redo history (Phase 3.7a) ────────────────────────────────────────
/** Maximum number of commits retained in the undo/redo stack. Older entries
 *  are evicted from the front when the stack would exceed this. */
const MAX_HISTORY = 20;

// ── Edit persistence (Phase 3.7b) ─────────────────────────────────────────
/**
 * Stable fingerprint of a FloorPlan's structural identity — the set of
 * UUIDs the backend generated for rooms / walls / openings, plus the
 * building dimensions. Edits do not change these IDs, so the fingerprint
 * stays constant through an edit session. A re-run of the optimizer
 * produces new UUIDs and thus a different fingerprint, which invalidates
 * any stored edits (so the user sees the fresh generation, not a stale
 * edit stack applied on top).
 *
 * Uses a 32-bit FNV-1a hash — fast, no crypto import, stable across
 * reloads and browsers.
 */
function fingerprintPlan(plan: FloorPlan): string {
  const parts: string[] = [
    String(plan.floor_index),
    plan.structural_grid.building_length_m.toFixed(3),
    plan.structural_grid.building_depth_m.toFixed(3),
    String(plan.rooms.length),
    String(plan.walls.length),
    String(plan.doors.length),
    String(plan.windows.length),
    ...plan.rooms.map((r) => r.id).sort(),
    ...plan.walls.map((w) => w.id).sort(),
    ...plan.doors.map((d) => d.id).sort(),
    ...plan.windows.map((w) => w.id).sort(),
  ];
  const s = parts.join("|");
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0; // FNV prime, keep as uint32
  }
  return hash.toString(16).padStart(8, "0");
}

// ── Real-time validation (Phase 3.6e) ─────────────────────────────────────

/** Habitable room types — require natural light, relaxed aspect ratio rules,
 *  and contribute to the apartment's room count. */
const HABITABLE_ROOM_TYPES: ReadonlyArray<string> = ["living", "bedroom", "kitchen"];

/** Maximum aspect ratio (long / short) for habitable rooms before a warning
 *  is raised — corridor-shaped rooms are uncomfortable to furnish. */
const MAX_HABITABLE_ASPECT_RATIO = 3.0;

type IssueSeverity = "error" | "warn";

interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** Present for room-scoped issues. */
  roomId?: string;
  /** Present for apartment-scoped issues. */
  apartmentId?: string;
}

interface ValidationResult {
  issues: ValidationIssue[];
  /** Room id → issues on this room. */
  byRoom: Map<string, ValidationIssue[]>;
  /** Apartment id → issues attached directly to the apartment. */
  byApartment: Map<string, ValidationIssue[]>;
  /** Apartment id → union of apartment-level + all its rooms' issues
   *  (used to colour the apartment indicator). */
  byApartmentAll: Map<string, ValidationIssue[]>;
  /** Counts for the summary badge. */
  errorCount: number;
  warnCount: number;
}

interface OpeningDragState {
  kind: OpeningKind;
  id: string;
  /** "move" translates along wall; "resize_left"/"resize_right" scale width
   *  by moving one edge of a window. Doors never use resize modes. */
  mode: "move" | "resize_left" | "resize_right";
  hostWallId: string;
  /** Axis the wall runs along (openings move along this). */
  axis: WallAxis;
  /** Along-axis extent of the host wall (min, max). */
  wallMin: number;
  wallMax: number;
  /** Snapshot of opening's center position and width at drag start. */
  originalPos: number;
  originalWidth: number;
  /** Live values after snap/clamp/validate. */
  currentPos: number;
  currentWidth: number;
  /** Forbidden zones from other openings on the same wall — pairs [min, max]
   *  of along-axis intervals (including MIN_OPENING_GAP_M padding). */
  forbidden: Array<[number, number]>;
  valid: boolean;
  invalidReason?: string;
}

export function FloorPlanViewer({
  floorPlan,
  width = 900,
  height = 600,
  selectedApartmentId,
  onApartmentSelect,
  buildingId,
  floorIndex,
  allFloors,
  latitude,
  longitude,
  buildingRotationDeg,
}: FloorPlanViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredAptId, setHoveredAptId] = useState<string | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<Point2D[]>([]);
  const [snapPoint, setSnapPoint] = useState<Point2D | null>(null);
  const rafRef = useRef<number | null>(null);

  // ── User view state (Phase 7) ──────────────────────────────────────
  // Sits on top of the fit-to-canvas base transform. zoom = 1, pan = 0
  // means "fit". Wheel + button zoom is anchored at the cursor; pan is a
  // free screen-space translation driven by middle-button drag, space +
  // left-drag, or the toolbar arrow keys.
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  // Pan drag bookkeeping. Only set while a middle-button or
  // space-modified drag is in progress; mutated through the existing
  // mouse-move/up handlers.
  const panDragRef = useRef<{
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);
  // Track whether the space bar is currently held — used to convert a
  // primary-button drag into a pan gesture (Photoshop / Figma idiom).
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Wrapper container ref so we can request fullscreen on it.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 16;

  // Layer visibility — each architectural category can be toggled independently
  const [layers, setLayers] = useState({
    grid: true,
    rooms: true,
    walls: true,
    openings: true,    // windows + doors
    labels: true,
    dimensions: true,
    annotations: true, // north arrow, scale bar, title
    validation: true,  // per-room/apartment issue badges (Phase 3.6e)
    furniture: false,  // DIN-compliant furniture silhouettes (Phase 4.1)
  });
  const [showLayerPanel, setShowLayerPanel] = useState(false);
  const toggleLayer = (k: keyof typeof layers) =>
    setLayers((p) => ({ ...p, [k]: !p[k] }));

  // Inspected element — set by click; shows a property readout
  type Inspected =
    | { kind: "wall"; data: WallSegment }
    | { kind: "window"; data: WindowPlacement }
    | { kind: "door"; data: DoorPlacement }
    | { kind: "room"; data: FloorPlanRoom }
    | null;
  const [inspected, setInspected] = useState<Inspected>(null);

  // ── Edit mode (Phase 3.6a: partition wall dragging) ──────────────────────
  // When editMode is "wall", partition walls become drag-highlighted on hover
  // and can be dragged along their perpendicular axis.
  // When editMode is "opening", doors and windows become selectable/draggable
  // along their host wall (3.6c).
  // When editMode is "room", reassignable rooms get a subtle tint and a click
  // opens a popover to change the room type (3.6d).
  // Edits live in a local copy of the FloorPlan; the prop is never mutated.
  const [editMode, setEditMode] = useState<"none" | "wall" | "opening" | "room">("none");

  // ── Persistence (Phase 3.7b) ─────────────────────────────────────────────
  // When buildingId + floorIndex are both provided, edits are persisted to
  // the Zustand store (localStorage-backed). Survives page reload so long
  // as the original plan's fingerprint still matches.
  const persistKey = useMemo(
    () =>
      buildingId && floorIndex !== undefined
        ? editedPlanKey(buildingId, floorIndex)
        : null,
    [buildingId, floorIndex],
  );
  const originalFingerprint = useMemo(() => fingerprintPlan(floorPlan), [floorPlan]);
  const setEditedFloorPlan = useProjectStore((s) => s.setEditedFloorPlan);
  const clearEditedFloorPlan = useProjectStore((s) => s.clearEditedFloorPlan);

  const [editedPlan, setEditedPlan] = useState<FloorPlan>(floorPlan);
  // ── Undo/redo history (Phase 3.7a) ───────────────────────────────────────
  // A bounded stack of FloorPlan snapshots, one per discrete commit (wall
  // drag, opening drag, opening delete, room type change). Intermediate drag
  // frames never push — only the final post-commit plan does. The effect
  // below syncs `editedPlan` when the index moves (undo/redo/reset).
  //
  // Lazy initializer: if the store has a saved edit for this plan AND the
  // original's fingerprint still matches, hydrate the history from the
  // saved plan (single-entry stack — prior undo history is not persisted).
  // Otherwise start fresh from the server-provided plan.
  const [history, setHistory] = useState<{ stack: FloorPlan[]; index: number }>(() => {
    if (persistKey) {
      // Can't read from hook here; grab once from the store directly.
      const entry = useProjectStore.getState().editedFloorPlans[persistKey];
      if (entry && entry.originalFingerprint === originalFingerprint) {
        return { stack: [entry.plan], index: 0 };
      }
    }
    return { stack: [floorPlan], index: 0 };
  });
  /** True on first render iff the initial history was hydrated from localStorage.
   *  Used to surface a "wiederhergestellt" pill in the toolbar so the user
   *  knows they're looking at persisted edits rather than the fresh plan. */
  const [restoredFromStore, setRestoredFromStore] = useState<boolean>(() => {
    if (!persistKey) return false;
    const entry = useProjectStore.getState().editedFloorPlans[persistKey];
    return !!(entry && entry.originalFingerprint === originalFingerprint);
  });
  useEffect(() => {
    setEditedPlan(history.stack[history.index]);
  }, [history]);
  /** Always points at the latest editedPlan — used by mouseup commit handlers
   *  so the useCallback doesn't have to re-bind on every drag frame. */
  const editedPlanRef = useRef(editedPlan);
  useEffect(() => {
    editedPlanRef.current = editedPlan;
  }, [editedPlan]);
  const commitEdit = useCallback((plan: FloorPlan) => {
    setHistory((prev) => {
      const truncated = prev.stack.slice(0, prev.index + 1);
      const appended = [...truncated, plan];
      if (appended.length > MAX_HISTORY) {
        return { stack: appended.slice(-MAX_HISTORY), index: MAX_HISTORY - 1 };
      }
      return { stack: appended, index: appended.length - 1 };
    });
  }, []);

  // Persist the current history tip (after any commit/undo/redo) to the
  // store. Debounced implicitly by React's batching — each state update
  // triggers one effect run. Only writes when persistKey is present AND
  // the current plan is actually a user edit (not the pristine original).
  //
  // Also mirrors to the backend via fire-and-forget HTTP (Phase 3.7c) so
  // edits survive localStorage wipes and sync across devices. Backend
  // errors are swallowed — localStorage is the primary cache.
  const backendSyncTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!persistKey) return;
    const current = history.stack[history.index];
    if (current === floorPlan) {
      // Back at the original — remove any stored edit so next mount
      // doesn't show a stale "wiederhergestellt" pill.
      clearEditedFloorPlan(persistKey);
      // Fire-and-forget backend delete too.
      if (buildingId && floorIndex !== undefined) {
        deleteOverride(buildingId, floorIndex).catch((err) => {
          console.debug("[override-delete] failed (ignored):", err);
        });
      }
      return;
    }
    // The store adds `savedAt` internally.
    setEditedFloorPlan(persistKey, {
      originalFingerprint,
      plan: current,
    });
    // Debounced backend PUT — coalesce rapid-fire commits (drag chains)
    // into one request every 400ms.
    if (buildingId && floorIndex !== undefined) {
      if (backendSyncTimerRef.current !== null) {
        window.clearTimeout(backendSyncTimerRef.current);
      }
      backendSyncTimerRef.current = window.setTimeout(() => {
        putOverride(buildingId, floorIndex, {
          original_fingerprint: originalFingerprint,
          plan: current,
        }).catch((err) => {
          console.debug("[override-put] failed (ignored):", err);
        });
      }, 400);
    }
  }, [
    history,
    persistKey,
    floorPlan,
    originalFingerprint,
    setEditedFloorPlan,
    clearEditedFloorPlan,
    buildingId,
    floorIndex,
  ]);
  // Flush any pending backend sync on unmount so a tab close doesn't
  // lose the last edit.
  useEffect(() => {
    return () => {
      if (backendSyncTimerRef.current !== null) {
        window.clearTimeout(backendSyncTimerRef.current);
        backendSyncTimerRef.current = null;
      }
    };
  }, []);

  // ── Backend hydration (Phase 3.7c) ───────────────────────────────────────
  // On mount (and whenever the persistKey changes), ask the backend if it
  // has a stored override for this (building, floor). If so AND the
  // fingerprint matches the current plan AND localStorage doesn't already
  // have a fresher edit, hydrate history from the server copy.
  // localStorage always wins when both exist (it's where the user was most
  // recently typing), so the net effect is:
  //   - Fresh device, server has edit: hydrate from server.
  //   - Same device as last session: localStorage already hydrated, no-op.
  //   - Server edit is stale (regenerated plan): fingerprint mismatch, ignored.
  useEffect(() => {
    if (!persistKey || !buildingId || floorIndex === undefined) return;
    const localEntry = useProjectStore.getState().editedFloorPlans[persistKey];
    if (localEntry && localEntry.originalFingerprint === originalFingerprint) {
      // Local cache is authoritative this session; skip the fetch.
      return;
    }
    let cancelled = false;
    fetchOverride(buildingId, floorIndex)
      .then((override) => {
        if (cancelled || !override) return;
        if (override.original_fingerprint !== originalFingerprint) return;
        // Only hydrate if the user hasn't already started editing locally
        // between dispatch and response.
        const nowLocal =
          useProjectStore.getState().editedFloorPlans[persistKey];
        if (nowLocal && nowLocal.originalFingerprint === originalFingerprint) {
          return;
        }
        setHistory({ stack: [override.plan], index: 0 });
        setRestoredFromStore(true);
      })
      .catch((err) => {
        console.debug("[override-fetch] failed (ignored):", err);
      });
    return () => {
      cancelled = true;
    };
  }, [persistKey, buildingId, floorIndex, originalFingerprint]);
  const undo = useCallback(() => {
    setHistory((prev) => (prev.index === 0 ? prev : { ...prev, index: prev.index - 1 }));
  }, []);
  const redo = useCallback(() => {
    setHistory((prev) =>
      prev.index >= prev.stack.length - 1 ? prev : { ...prev, index: prev.index + 1 },
    );
  }, []);
  const canUndo = history.index > 0;
  const canRedo = history.index < history.stack.length - 1;
  const [wallDrag, setWallDrag] = useState<WallDragState | null>(null);
  const [hoveredWallId, setHoveredWallId] = useState<string | null>(null);
  /** Snapshot of editedPlan taken at drag start, used to revert on invalid/cancel. */
  const preDragPlanRef = useRef<FloorPlan | null>(null);

  // ── Opening edit state (Phase 3.6c) ──────────────────────────────────────
  const [selectedOpening, setSelectedOpening] = useState<
    { kind: OpeningKind; id: string } | null
  >(null);
  const [hoveredOpening, setHoveredOpening] = useState<
    { kind: OpeningKind; id: string } | null
  >(null);
  const [openingDrag, setOpeningDrag] = useState<OpeningDragState | null>(null);
  /** When non-"none" in opening edit mode, a click on empty space along a
   *  wall places a NEW window/door instead of just deselecting. Toggled by
   *  the "+ Fenster" / "+ Tür" sub-toolbar buttons. Phase 3.6c add. */
  const [openingAddMode, setOpeningAddMode] = useState<"none" | "window" | "door">("none");

  // ── Room edit state (Phase 3.6d) ─────────────────────────────────────────
  // When `roomEditor` is set, a popover is rendered at (screenX, screenY)
  // anchored near the clicked room, offering reassignment options.
  const [roomEditor, setRoomEditor] = useState<
    { roomId: string; screenX: number; screenY: number } | null
  >(null);
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null);

  // Re-sync local copy whenever a new plan arrives from the server. Done
  // during render (React's recommended "reset state on prop change" pattern)
  // rather than in an effect to avoid a cascading re-render.
  const [lastSyncedPlan, setLastSyncedPlan] = useState<FloorPlan>(floorPlan);
  if (floorPlan !== lastSyncedPlan) {
    setLastSyncedPlan(floorPlan);
    // A newly-arrived server plan — check the store for a matching saved
    // edit (by the NEW fingerprint, not the outgoing one). This handles the
    // common case where a user navigates away and back without the plan
    // regenerating. If the fingerprint differs (e.g. the optimizer just
    // produced a fresh plan), fall back to a clean single-entry stack.
    const newFingerprint = fingerprintPlan(floorPlan);
    let nextHistory: { stack: FloorPlan[]; index: number } = {
      stack: [floorPlan],
      index: 0,
    };
    let nextRestored = false;
    if (persistKey) {
      const entry = useProjectStore.getState().editedFloorPlans[persistKey];
      if (entry && entry.originalFingerprint === newFingerprint) {
        nextHistory = { stack: [entry.plan], index: 0 };
        nextRestored = true;
      }
    }
    setHistory(nextHistory);
    setRestoredFromStore(nextRestored);
    setWallDrag(null);
    setHoveredWallId(null);
    setSelectedOpening(null);
    setHoveredOpening(null);
    setOpeningDrag(null);
    setRoomEditor(null);
    setHoveredRoomId(null);
  }

  // Every render-path below reads `plan`, not the raw prop, so edits are live.
  const plan = editedPlan;

  // ── Live validation (Phase 3.6e) ─────────────────────────────────────────
  // Recomputed on every plan change (incl. every drag commit / room type
  // flip). Cheap — O(rooms + apartments) for a handful of each per floor.
  // ── Furniture placement (Phase 4.1) ──────────────────────────────────────
  // Computed once per plan change and cached. Only *drawn* when the
  // `furniture` layer is enabled, but always computed so the validator
  // can emit a "room doesn't furnish" warning regardless of layer state.
  const furnitureByRoom = useMemo(() => placeFurnitureForPlan(plan), [plan]);

  const validation = useMemo(
    () =>
      validatePlan(plan, furnitureByRoom, {
        latitude,
        longitude,
        buildingRotationDeg,
      }),
    [plan, furnitureByRoom, latitude, longitude, buildingRotationDeg],
  );
  const [validationPanelOpen, setValidationPanelOpen] = useState(false);
  const [focusedRoomId, setFocusedRoomId] = useState<string | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  /** Focus a room: flash its outline, open the inspector on it. */
  const focusRoom = useCallback((roomId: string) => {
    setFocusedRoomId(roomId);
    const room = plan.rooms.find((r) => r.id === roomId);
    if (room) setInspected({ kind: "room", data: room });
    if (focusTimerRef.current !== null) {
      window.clearTimeout(focusTimerRef.current);
    }
    focusTimerRef.current = window.setTimeout(() => {
      setFocusedRoomId(null);
      focusTimerRef.current = null;
    }, 1800);
  }, [plan]);

  // View mode — Architect (technical, all layers, crisp black linework) vs
  // Presentation (client-facing, hides grid/dimensions, clean white background).
  const [viewMode, setViewMode] = useState<"architect" | "presentation">("architect");
  const applyViewMode = (mode: "architect" | "presentation") => {
    setViewMode(mode);
    if (mode === "architect") {
      setLayers((prev) => ({
        grid: true, rooms: true, walls: true, openings: true,
        labels: true, dimensions: true, annotations: true, validation: true,
        furniture: prev.furniture,
      }));
    } else {
      // Presentation: hide technical layers, keep rooms + walls + openings + labels
      setLayers((prev) => ({
        grid: false, rooms: true, walls: true, openings: true,
        labels: true, dimensions: false, annotations: true, validation: false,
        furniture: prev.furniture,
      }));
    }
  };

  // Precompute transform.
  //
  // When the building has a Staffelgeschoss its top floor's grid is smaller
  // than the floors below it AND its origin is offset (the SG is centered
  // inside the base footprint). If we sized the canvas to the SG's own grid
  // length, walls drawn at `origin.x .. origin.x + length` would render
  // outside the visible area on the right.
  //
  // Solution: size the canvas to the union extent across `allFloors` so every
  // floor shares the same plan-space → screen-space mapping. The SG then
  // draws naturally inset within the building outline. When `allFloors` is
  // not supplied we fall back to the current plan's grid only.
  const getTransform = useCallback(() => {
    const grid = plan.structural_grid;
    let minX = grid.origin?.x ?? 0;
    let minY = grid.origin?.y ?? 0;
    let maxX = minX + grid.building_length_m;
    let maxY = minY + grid.building_depth_m;
    if (allFloors && allFloors.length > 0) {
      for (const fp of allFloors) {
        const g = fp.structural_grid;
        const ox = g.origin?.x ?? 0;
        const oy = g.origin?.y ?? 0;
        if (ox < minX) minX = ox;
        if (oy < minY) minY = oy;
        if (ox + g.building_length_m > maxX) maxX = ox + g.building_length_m;
        if (oy + g.building_depth_m > maxY) maxY = oy + g.building_depth_m;
      }
    }
    const bldgW = Math.max(1, maxX - minX);
    const bldgH = Math.max(1, maxY - minY);

    const padding = 50;
    const scaleX = (width - 2 * padding) / bldgW;
    const scaleY = (height - 2 * padding) / bldgH;
    const scale = Math.min(scaleX, scaleY);

    const baseOffsetX =
      padding + ((width - 2 * padding) - bldgW * scale) / 2 - minX * scale;
    const baseOffsetY =
      padding + ((height - 2 * padding) - bldgH * scale) / 2 - minY * scale;

    // Apply user view (Phase 7): zoom around the canvas centre, then
    // translate by (panX, panY). Reduces back to the fit transform when
    // zoom = 1 and pan = 0.
    const { zoom, panX, panY } = view;
    const cx = width / 2;
    const cy = height / 2;
    const finalScale = scale * zoom;
    const offsetX = panX + cx * (1 - zoom) + zoom * baseOffsetX;
    const offsetY = (1 - zoom) * cy + zoom * baseOffsetY - panY;

    return {
      scale: finalScale,
      offsetX,
      offsetY,
      tx: (x: number) => offsetX + x * finalScale,
      ty: (y: number) => height - (offsetY + y * finalScale),
      ts: (s: number) => s * finalScale,
      // Inverse transforms: convert screen coordinates to plan coordinates
      invTx: (screenX: number) => (screenX - offsetX) / finalScale,
      invTy: (screenY: number) => (height - screenY - offsetY) / finalScale,
    };
  }, [plan, allFloors, width, height, view]);

  // ── Wall drag helpers (Phase 3.6a partition + Phase 3.6b apt boundary) ───

  /**
   * Classify a wall for drag purposes. Returns:
   *   • "partition"    — non-bearing interior partition (3.6a)
   *   • "apt_boundary" — bearing cross wall separating two different
   *                      apartments; identified by looking at the rooms
   *                      whose vertices touch the wall axis (3.6b)
   *   • null           — not draggable
   */
  const getWallDragKind = useCallback(
    (wall: WallSegment): WallDragKind | null => {
      if (wall.is_exterior) return null;

      if (!wall.is_bearing && wall.wall_type === "partition") {
        return "partition";
      }

      if (wall.is_bearing && wall.wall_type === "bearing_cross") {
        // Only draggable if it separates two different apartments.
        // Classify axis and check rooms on either side.
        const dx = Math.abs(wall.end.x - wall.start.x);
        const dy = Math.abs(wall.end.y - wall.start.y);
        const axis: WallAxis | null =
          dx < AXIS_ALIGN_TOL && dy > AXIS_ALIGN_TOL ? "x" :
          dy < AXIS_ALIGN_TOL && dx > AXIS_ALIGN_TOL ? "y" : null;
        if (!axis) return null;
        const pos = axis === "x"
          ? (wall.start.x + wall.end.x) / 2
          : (wall.start.y + wall.end.y) / 2;
        const perpMin = axis === "x"
          ? Math.min(wall.start.y, wall.end.y)
          : Math.min(wall.start.x, wall.end.x);
        const perpMax = axis === "x"
          ? Math.max(wall.start.y, wall.end.y)
          : Math.max(wall.start.x, wall.end.x);

        const leftApts = new Set<string>();
        const rightApts = new Set<string>();
        for (const apt of plan.apartments) {
          for (const room of apt.rooms) {
            if (room.polygon.length < 3) continue;
            const alongVals = axis === "x"
              ? room.polygon.map((p) => p.x)
              : room.polygon.map((p) => p.y);
            const perpVals = axis === "x"
              ? room.polygon.map((p) => p.y)
              : room.polygon.map((p) => p.x);
            const pMin = Math.min(...perpVals);
            const pMax = Math.max(...perpVals);
            if (pMax < perpMin - VERTEX_MATCH_TOL) continue;
            if (pMin > perpMax + VERTEX_MATCH_TOL) continue;
            const aMin = Math.min(...alongVals);
            const aMax = Math.max(...alongVals);
            if (Math.abs(aMax - pos) < VERTEX_MATCH_TOL) leftApts.add(apt.id);
            if (Math.abs(aMin - pos) < VERTEX_MATCH_TOL) rightApts.add(apt.id);
          }
        }
        // Apt boundary if the two sides are non-overlapping, non-empty sets.
        const overlap = [...leftApts].some((id) => rightApts.has(id));
        if (!overlap && leftApts.size > 0 && rightApts.size > 0) {
          return "apt_boundary";
        }
      }

      return null;
    },
    [plan.apartments]
  );

  /** Back-compat shim: any wall that has a drag kind is draggable. */
  const isDraggablePartition = useCallback(
    (wall: WallSegment): boolean => getWallDragKind(wall) !== null,
    [getWallDragKind]
  );

  /** Axis-classify an axis-aligned wall; returns null if the wall is skewed. */
  const classifyWallAxis = useCallback(
    (wall: WallSegment): { axis: WallAxis; pos: number; min: number; max: number } | null => {
      const dx = Math.abs(wall.end.x - wall.start.x);
      const dy = Math.abs(wall.end.y - wall.start.y);
      if (dx < AXIS_ALIGN_TOL && dy > AXIS_ALIGN_TOL) {
        // Vertical wall — moves along X
        return {
          axis: "x",
          pos: (wall.start.x + wall.end.x) / 2,
          min: Math.min(wall.start.y, wall.end.y),
          max: Math.max(wall.start.y, wall.end.y),
        };
      }
      if (dy < AXIS_ALIGN_TOL && dx > AXIS_ALIGN_TOL) {
        // Horizontal wall — moves along Y
        return {
          axis: "y",
          pos: (wall.start.y + wall.end.y) / 2,
          min: Math.min(wall.start.x, wall.end.x),
          max: Math.max(wall.start.x, wall.end.x),
        };
      }
      return null;
    },
    []
  );

  /**
   * Hit-test: given plan-space cursor coords, return the topmost draggable
   * partition wall under the cursor (within thickness/2 + 0.08m tolerance).
   */
  const wallAtPoint = useCallback(
    (planX: number, planY: number): WallSegment | null => {
      for (const wall of plan.walls) {
        if (!isDraggablePartition(wall)) continue;
        const sx = wall.start.x, sy = wall.start.y;
        const ex = wall.end.x, ey = wall.end.y;
        const dx = ex - sx, dy = ey - sy;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((planX - sx) * dx + (planY - sy) * dy) / lenSq));
        const projX = sx + t * dx, projY = sy + t * dy;
        const dist = Math.hypot(planX - projX, planY - projY);
        const tol = (wall.thickness_m || 0.08) / 2 + 0.08;
        if (dist <= tol) return wall;
      }
      return null;
    },
    [plan.walls, isDraggablePartition]
  );

  /**
   * Begin a wall drag. Identifies rooms whose polygons share a vertex on
   * the wall axis (within VERTEX_MATCH_TOL), groups co-axis sibling walls
   * together (important for apt-boundary drags, which cross the corridor
   * and so are split into two WallSegments), and precomputes the allowed
   * drag range.
   */
  const startWallDrag = useCallback(
    (wall: WallSegment): WallDragState | null => {
      const cls = classifyWallAxis(wall);
      if (!cls) return null;
      const kind = getWallDragKind(wall);
      if (!kind) return null;

      // Grouping: apt-boundary drags co-move every bearing_cross wall on
      // the same axis position (Ganghaus splits them at the corridor).
      const affectedWallIds: string[] = [wall.id];
      const groupMin: number[] = [cls.min];
      const groupMax: number[] = [cls.max];
      if (kind === "apt_boundary") {
        for (const w of plan.walls) {
          if (w.id === wall.id) continue;
          if (w.wall_type !== "bearing_cross") continue;
          const c2 = classifyWallAxis(w);
          if (!c2 || c2.axis !== cls.axis) continue;
          if (Math.abs(c2.pos - cls.pos) > VERTEX_MATCH_TOL) continue;
          affectedWallIds.push(w.id);
          groupMin.push(c2.min);
          groupMax.push(c2.max);
        }
      }
      // Perpendicular coverage = union of all grouped segments
      const perpMin = Math.min(...groupMin);
      const perpMax = Math.max(...groupMax);

      const affectedRoomIds: string[] = [];
      let leftNeighborMinEdge = -Infinity;
      let rightNeighborMaxEdge = Infinity;

      for (const room of plan.rooms) {
        if (room.polygon.length < 3) continue;
        const perp = cls.axis === "x" ? room.polygon.map((p) => p.y) : room.polygon.map((p) => p.x);
        const rPerpMin = Math.min(...perp);
        const rPerpMax = Math.max(...perp);
        if (rPerpMax < perpMin - VERTEX_MATCH_TOL) continue;
        if (rPerpMin > perpMax + VERTEX_MATCH_TOL) continue;

        const alongRoom = cls.axis === "x" ? room.polygon.map((p) => p.x) : room.polygon.map((p) => p.y);
        const alongMin = Math.min(...alongRoom);
        const alongMax = Math.max(...alongRoom);

        const onRightSide = Math.abs(alongMin - cls.pos) < VERTEX_MATCH_TOL;
        const onLeftSide = Math.abs(alongMax - cls.pos) < VERTEX_MATCH_TOL;

        if (onLeftSide) {
          affectedRoomIds.push(room.id);
          if (alongMin > leftNeighborMinEdge) leftNeighborMinEdge = alongMin;
        } else if (onRightSide) {
          affectedRoomIds.push(room.id);
          if (alongMax < rightNeighborMaxEdge) rightNeighborMaxEdge = alongMax;
        }
      }

      if (affectedRoomIds.length === 0) return null;

      // Pad: partition leaves 1m for DIN; apt boundary must leave at least
      // one minimum-width bay (3.125m) on each side of the wall.
      const pad = kind === "apt_boundary" ? MIN_APARTMENT_WIDTH_M : 1.0;
      const minPos = Number.isFinite(leftNeighborMinEdge) ? leftNeighborMinEdge + pad : cls.pos - 10;
      const maxPos = Number.isFinite(rightNeighborMaxEdge) ? rightNeighborMaxEdge - pad : cls.pos + 10;

      return {
        wallId: wall.id,
        kind,
        axis: cls.axis,
        original: cls.pos,
        current: cls.pos,
        minPos,
        maxPos,
        affectedWallIds,
        affectedRoomIds,
        valid: true,
      };
    },
    [plan.walls, plan.rooms, classifyWallAxis, getWallDragKind]
  );

  // applyWallDragOnPlan is a pure helper defined at module scope (below).

  /** Snap a plan-space position according to the drag kind. Partition
   *  walls snap to the 62.5cm Goldbeck grid; apt-boundary walls snap to
   *  the nearest structural bay-axis position (never the building edges). */
  const snapForDrag = useCallback(
    (pos: number, drag: WallDragState): number => {
      if (drag.kind === "apt_boundary" && drag.axis === "x") {
        const axes = plan.structural_grid.axis_positions_x ?? [];
        // Allowed snap targets exclude the first and last axis (outer walls).
        const interior = axes.slice(1, -1);
        if (interior.length === 0) {
          return Math.round(pos / GRID_UNIT_M) * GRID_UNIT_M;
        }
        let best = interior[0];
        let bestD = Math.abs(pos - best);
        for (const a of interior) {
          const d = Math.abs(pos - a);
          if (d < bestD) { best = a; bestD = d; }
        }
        return best;
      }
      return Math.round(pos / GRID_UNIT_M) * GRID_UNIT_M;
    },
    [plan.structural_grid.axis_positions_x]
  );

  // ── Opening drag helpers (Phase 3.6c) ────────────────────────────────────

  /** Axis-classify the host wall's running direction. All Goldbeck walls are
   *  axis-aligned, so we return just the axis + along-axis extent. */
  const classifyHostWall = useCallback(
    (wall: WallSegment): { axis: WallAxis; min: number; max: number } | null => {
      const dx = Math.abs(wall.end.x - wall.start.x);
      const dy = Math.abs(wall.end.y - wall.start.y);
      if (dy < AXIS_ALIGN_TOL && dx > AXIS_ALIGN_TOL) {
        // Horizontal wall — openings move along X
        return { axis: "x", min: Math.min(wall.start.x, wall.end.x), max: Math.max(wall.start.x, wall.end.x) };
      }
      if (dx < AXIS_ALIGN_TOL && dy > AXIS_ALIGN_TOL) {
        // Vertical wall — openings move along Y
        return { axis: "y", min: Math.min(wall.start.y, wall.end.y), max: Math.max(wall.start.y, wall.end.y) };
      }
      return null;
    },
    []
  );

  /**
   * Hit-test an opening. In opening-edit mode, returns the opening whose
   * on-wall footprint contains (planX, planY) within a perpendicular
   * tolerance. Windows are prioritised over doors (same convention as the
   * regular inspection click handler). Returns null if none.
   */
  const openingAtPoint = useCallback(
    (planX: number, planY: number): { kind: OpeningKind; id: string; hostWall: WallSegment } | null => {
      const testOne = (
        kind: OpeningKind,
        id: string,
        position: Point2D,
        width_m: number,
      ): { kind: OpeningKind; id: string; hostWall: WallSegment } | null => {
        const hostWall = findNearestWall2D(position, plan.walls);
        if (!hostWall) return null;
        const cls = classifyHostWall(hostWall);
        if (!cls) return null;
        // Along-axis distance from cursor projected onto wall to opening center
        const alongCursor = cls.axis === "x" ? planX : planY;
        const alongCenter = cls.axis === "x" ? position.x : position.y;
        const perpCursor = cls.axis === "x" ? planY : planX;
        const perpCenter = cls.axis === "x" ? position.y : position.x;
        if (Math.abs(alongCursor - alongCenter) > width_m / 2) return null;
        if (Math.abs(perpCursor - perpCenter) > OPENING_HIT_TOL_PERP_M) return null;
        return { kind, id, hostWall };
      };
      // Windows first (same priority as element inspection)
      for (const win of plan.windows) {
        const r = testOne("window", win.id, win.position, win.width_m);
        if (r) return r;
      }
      for (const door of plan.doors) {
        const r = testOne("door", door.id, door.position, door.width_m);
        if (r) return r;
      }
      return null;
    },
    [plan.walls, plan.windows, plan.doors, classifyHostWall]
  );

  /**
   * Return "resize_left" / "resize_right" if (planX, planY) is inside a
   * resize handle of the currently selected window (rendered at its two
   * along-axis edges). Doors have no resize handles. Uses screen-space
   * radius so the hit zone stays stable across zoom levels.
   */
  const resizeHandleAtPoint = useCallback(
    (planX: number, planY: number): "resize_left" | "resize_right" | null => {
      if (!selectedOpening || selectedOpening.kind !== "window") return null;
      const win = plan.windows.find((w) => w.id === selectedOpening.id);
      if (!win) return null;
      const hostWall = findNearestWall2D(win.position, plan.walls);
      if (!hostWall) return null;
      const cls = classifyHostWall(hostWall);
      if (!cls) return null;
      const { scale } = getTransform();
      const tolPlan = RESIZE_HANDLE_RADIUS_PX / Math.max(scale, 1e-6);
      const half = win.width_m / 2;
      const cx = win.position.x;
      const cy = win.position.y;
      if (cls.axis === "x") {
        const perpOk = Math.abs(planY - cy) <= tolPlan + 0.1;
        if (!perpOk) return null;
        if (Math.abs(planX - (cx - half)) <= tolPlan) return "resize_left";
        if (Math.abs(planX - (cx + half)) <= tolPlan) return "resize_right";
      } else {
        const perpOk = Math.abs(planX - cx) <= tolPlan + 0.1;
        if (!perpOk) return null;
        if (Math.abs(planY - (cy - half)) <= tolPlan) return "resize_left";
        if (Math.abs(planY - (cy + half)) <= tolPlan) return "resize_right";
      }
      return null;
    },
    [selectedOpening, plan.windows, plan.walls, classifyHostWall, getTransform]
  );

  /** Build a drag state for an opening. */
  const startOpeningDrag = useCallback(
    (
      kind: OpeningKind,
      id: string,
      mode: "move" | "resize_left" | "resize_right",
    ): OpeningDragState | null => {
      const opening =
        kind === "window"
          ? plan.windows.find((w) => w.id === id)
          : plan.doors.find((d) => d.id === id);
      if (!opening) return null;
      const hostWall = findNearestWall2D(opening.position, plan.walls);
      if (!hostWall) return null;
      const cls = classifyHostWall(hostWall);
      if (!cls) return null;

      const originalPos = cls.axis === "x" ? opening.position.x : opening.position.y;
      const originalWidth = opening.width_m;

      // Collect along-axis forbidden intervals from other openings on same
      // host wall (padded by MIN_OPENING_GAP_M so widths don't abut).
      const forbidden: Array<[number, number]> = [];
      const collect = (
        ownId: string,
        items: Array<{ id: string; position: Point2D; width_m: number }>,
      ) => {
        for (const it of items) {
          if (it.id === ownId) continue;
          const hw = findNearestWall2D(it.position, plan.walls);
          if (!hw || hw.id !== hostWall.id) continue;
          const p = cls.axis === "x" ? it.position.x : it.position.y;
          forbidden.push([p - it.width_m / 2 - MIN_OPENING_GAP_M, p + it.width_m / 2 + MIN_OPENING_GAP_M]);
        }
      };
      collect(kind === "window" ? id : "__none__", plan.windows);
      collect(kind === "door" ? id : "__none__", plan.doors);

      return {
        kind,
        id,
        mode,
        hostWallId: hostWall.id,
        axis: cls.axis,
        wallMin: cls.min,
        wallMax: cls.max,
        originalPos,
        originalWidth,
        currentPos: originalPos,
        currentWidth: originalWidth,
        forbidden,
        valid: true,
      };
    },
    [plan.walls, plan.windows, plan.doors, classifyHostWall]
  );

  /** Snap an opening along-axis coordinate to OPENING_SNAP_M. */
  const snapOpeningCoord = useCallback(
    (v: number): number => Math.round(v / OPENING_SNAP_M) * OPENING_SNAP_M,
    []
  );

  // Handle click
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { invTx, invTy } = getTransform();

      // Handle measurement mode
      if (measureMode) {
        const planX = invTx(mx);
        const planY = invTy(my);

        // Use snap point if available, otherwise use raw click point
        const point = snapPoint || { x: planX, y: planY };
        setMeasurePoints([...measurePoints, point]);
        setSnapPoint(null);
        return;
      }

      // In edit modes, clicks are absorbed — drag/selection is handled by
      // mousedown/up (or by the room-edit popover).
      if (editMode === "wall" || editMode === "opening" || editMode === "room") return;

      // --- Element inspection (priority: opening → wall → room) ---
      const planX = invTx(mx);
      const planY = invTy(my);

      // 1. Windows / doors — hit if within half-width along the host wall + ~0.35m across
      const OPENING_TOL = 0.35;
      for (const win of plan.windows) {
        const d = Math.hypot(planX - win.position.x, planY - win.position.y);
        if (d <= Math.max(win.width_m / 2, OPENING_TOL)) {
          setInspected({ kind: "window", data: win });
          return;
        }
      }
      for (const door of plan.doors) {
        const d = Math.hypot(planX - door.position.x, planY - door.position.y);
        if (d <= Math.max(door.width_m / 2, OPENING_TOL)) {
          setInspected({ kind: "door", data: door });
          return;
        }
      }

      // 2. Walls — hit if perpendicular distance to segment < thickness/2 + 0.08m tolerance
      for (const wall of plan.walls) {
        const sx = wall.start.x, sy = wall.start.y;
        const ex = wall.end.x, ey = wall.end.y;
        const dx = ex - sx, dy = ey - sy;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((planX - sx) * dx + (planY - sy) * dy) / lenSq));
        const projX = sx + t * dx;
        const projY = sy + t * dy;
        const dist = Math.hypot(planX - projX, planY - projY);
        const tol = (wall.thickness_m || 0.12) / 2 + 0.08;
        if (dist <= tol) {
          setInspected({ kind: "wall", data: wall });
          return;
        }
      }

      // 3. Room / apartment — point-in-polygon
      let selectedApt: FloorPlanApartment | null = null;
      let selectedRoom: FloorPlanRoom | null = null;
      let smallestArea = Infinity;
      for (const apt of plan.apartments) {
        for (const room of apt.rooms) {
          if (isPointInPolygon(mx, my, room.polygon, invTx, invTy)) {
            const aptArea = apt.rooms.reduce((sum, r) => sum + r.area_sqm, 0);
            if (aptArea < smallestArea) {
              selectedApt = apt;
              selectedRoom = room;
              smallestArea = aptArea;
            }
            break;
          }
        }
      }

      if (selectedRoom) {
        setInspected({ kind: "room", data: selectedRoom });
      } else {
        setInspected(null);
      }

      if (onApartmentSelect) {
        onApartmentSelect(selectedApt);
      }
    },
    [plan, onApartmentSelect, getTransform, measureMode, measurePoints, snapPoint, editMode]
  );

  // ── Mouse down — start a partition wall drag or opening drag ──────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();

      // Pan gesture (Phase 7): middle button always pans; primary
      // button pans when space is held. Prevents the gesture from
      // falling through to wall/opening hit-test below.
      if (e.button === 1 || (e.button === 0 && spaceHeld)) {
        panDragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startPanX: viewRef.current.panX,
          startPanY: viewRef.current.panY,
        };
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const { invTx, invTy } = getTransform();
      const planX = invTx(e.clientX - rect.left);
      const planY = invTy(e.clientY - rect.top);

      if (editMode === "wall") {
        const wall = wallAtPoint(planX, planY);
        if (!wall) return;
        const drag = startWallDrag(wall);
        if (!drag) return;
        preDragPlanRef.current = editedPlan;
        setWallDrag(drag);
        setInspected(null);
        e.preventDefault();
        return;
      }

      if (editMode === "opening") {
        // Priority 1: if a window is already selected, test its resize handles
        const handle = resizeHandleAtPoint(planX, planY);
        if (handle && selectedOpening && selectedOpening.kind === "window") {
          const drag = startOpeningDrag("window", selectedOpening.id, handle);
          if (drag) {
            preDragPlanRef.current = editedPlan;
            setOpeningDrag(drag);
            e.preventDefault();
            return;
          }
        }
        // Priority 2: any opening under cursor → select + start move drag
        const hit = openingAtPoint(planX, planY);
        if (hit) {
          setSelectedOpening({ kind: hit.kind, id: hit.id });
          const drag = startOpeningDrag(hit.kind, hit.id, "move");
          if (drag) {
            preDragPlanRef.current = editedPlan;
            setOpeningDrag(drag);
            e.preventDefault();
            return;
          }
          return;
        }
        // Priority 3: add-new mode — click on empty part of a wall places a
        // new opening at the projected point. (Phase 3.6c add.)
        if (openingAddMode !== "none") {
          const { plan: nextPlan, valid, invalidReason, newId } = applyNewOpeningOnPlan(
            editedPlan,
            openingAddMode,
            planX,
            planY,
            snapOpeningCoord,
          );
          if (valid && newId) {
            commitEdit(nextPlan);
            setSelectedOpening({ kind: openingAddMode, id: newId });
            setOpeningAddMode("none"); // one-shot — re-click button for next
          } else if (invalidReason) {
            // Keep add-mode active so the user can try again; we could
            // surface a toast here but for now the footer hint suffices.
            console.warn("[opening-add]", invalidReason);
          }
          e.preventDefault();
          return;
        }
        // Priority 4: click empty space → deselect
        setSelectedOpening(null);
        return;
      }

      if (editMode === "room") {
        // Click inside a reassignable room → anchor the popover here.
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hitRoom = findRoomAtClick(plan, mx, my, invTx, invTy);
        if (hitRoom && isRoomReassignable(hitRoom)) {
          setRoomEditor({
            roomId: hitRoom.id,
            screenX: mx,
            screenY: my,
          });
        } else {
          setRoomEditor(null);
        }
        e.preventDefault();
        return;
      }
    },
    [
      editMode,
      getTransform,
      wallAtPoint,
      startWallDrag,
      editedPlan,
      resizeHandleAtPoint,
      selectedOpening,
      startOpeningDrag,
      openingAtPoint,
      plan,
      openingAddMode,
      snapOpeningCoord,
      commitEdit,
      spaceHeld,
    ]
  );

  // ── Mouse up — commit (valid) or revert (invalid) a drag ──────────────────
  const handleMouseUp = useCallback(() => {
    // Phase 7: terminate any active pan gesture first; pan never
    // produces a wall/opening edit so it must short-circuit.
    if (panDragRef.current) {
      panDragRef.current = null;
      return;
    }
    if (wallDrag) {
      // editedPlan is already live-updated during mousemove; revert if
      // invalid or if the wall never moved off its original position.
      const moved = Math.abs(wallDrag.current - wallDrag.original) > 0.001;
      if (!wallDrag.valid || !moved) {
        if (preDragPlanRef.current) setEditedPlan(preDragPlanRef.current);
      } else {
        // Valid & moved → push the final plan onto the undo/redo stack.
        commitEdit(editedPlanRef.current);
      }
      preDragPlanRef.current = null;
      setWallDrag(null);
      return;
    }
    if (openingDrag) {
      const posMoved = Math.abs(openingDrag.currentPos - openingDrag.originalPos) > 0.001;
      const widthChanged = Math.abs(openingDrag.currentWidth - openingDrag.originalWidth) > 0.001;
      const changed = posMoved || widthChanged;
      if (!openingDrag.valid || !changed) {
        if (preDragPlanRef.current) setEditedPlan(preDragPlanRef.current);
      } else {
        commitEdit(editedPlanRef.current);
      }
      preDragPlanRef.current = null;
      setOpeningDrag(null);
    }
  }, [wallDrag, openingDrag, commitEdit]);

  // Handle mouse move for hover and snap detection (rAF-throttled)
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (rafRef.current !== null) return;
      const clientX = e.clientX;
      const clientY = e.clientY;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left;
        const my = clientY - rect.top;

        // Phase 7: pan gesture in progress → translate the view and
        // exit before any hit-test runs.
        if (panDragRef.current) {
          const pd = panDragRef.current;
          setView({
            zoom: viewRef.current.zoom,
            panX: pd.startPanX + (clientX - pd.startX),
            panY: pd.startPanY + (clientY - pd.startY),
          });
          return;
        }

      const { invTx, invTy } = getTransform();

      const planX = invTx(mx);
      const planY = invTy(my);

      // Active wall drag — live-update editedPlan so the preview redraws
      if (wallDrag) {
        const base = preDragPlanRef.current ?? plan;
        const raw = wallDrag.axis === "x" ? planX : planY;
        const clamped = Math.max(wallDrag.minPos, Math.min(wallDrag.maxPos, raw));
        const snapped = snapForDrag(clamped, wallDrag);
        if (Math.abs(snapped - wallDrag.current) > 1e-6) {
          const { plan: nextPlan, valid, invalidReason } = applyWallDragOnPlan(base, wallDrag, snapped);
          setEditedPlan(nextPlan);
          setWallDrag({ ...wallDrag, current: snapped, valid, invalidReason });
        }
        canvas.style.cursor = wallDrag.axis === "x" ? "ew-resize" : "ns-resize";
        return;
      }

      // Active opening drag — live-update editedPlan and validate against
      // host-wall edges, width limits, and other openings' forbidden intervals
      if (openingDrag) {
        const base = preDragPlanRef.current ?? plan;
        const along = openingDrag.axis === "x" ? planX : planY;
        const {
          plan: nextPlan,
          currentPos,
          currentWidth,
          valid,
          invalidReason,
        } = applyOpeningDragOnPlan(base, openingDrag, along, snapOpeningCoord);
        if (
          Math.abs(currentPos - openingDrag.currentPos) > 1e-6 ||
          Math.abs(currentWidth - openingDrag.currentWidth) > 1e-6 ||
          valid !== openingDrag.valid
        ) {
          setEditedPlan(nextPlan);
          setOpeningDrag({ ...openingDrag, currentPos, currentWidth, valid, invalidReason });
        }
        canvas.style.cursor =
          openingDrag.mode === "move"
            ? (openingDrag.axis === "x" ? "ew-resize" : "ns-resize")
            : (openingDrag.axis === "x" ? "ew-resize" : "ns-resize");
        return;
      }

      // Edit-mode hover — highlight draggable partition under cursor
      if (editMode === "wall") {
        const w = wallAtPoint(planX, planY);
        const id = w ? w.id : null;
        if (id !== hoveredWallId) setHoveredWallId(id);
        canvas.style.cursor = w
          ? (classifyWallAxis(w)?.axis === "x" ? "ew-resize" : "ns-resize")
          : "default";
        return;
      }

      // Opening-edit hover — highlight openings under cursor + resize handles
      if (editMode === "opening") {
        const handle = resizeHandleAtPoint(planX, planY);
        if (handle) {
          canvas.style.cursor = "ew-resize";
          if (hoveredOpening) setHoveredOpening(null);
          return;
        }
        const hit = openingAtPoint(planX, planY);
        const nextHover = hit ? { kind: hit.kind, id: hit.id } : null;
        const differs =
          (nextHover?.id ?? null) !== (hoveredOpening?.id ?? null) ||
          (nextHover?.kind ?? null) !== (hoveredOpening?.kind ?? null);
        if (differs) setHoveredOpening(nextHover);
        canvas.style.cursor = hit ? "grab" : "default";
        return;
      }

      // Room-edit hover — highlight reassignable rooms
      if (editMode === "room") {
        const hit = findRoomAtClick(plan, mx, my, invTx, invTy);
        const id = hit && isRoomReassignable(hit) ? hit.id : null;
        if (id !== hoveredRoomId) setHoveredRoomId(id);
        canvas.style.cursor = id ? "pointer" : "default";
        return;
      }

      if (measureMode) {
        canvas.style.cursor = "crosshair";

        // Find snap points: wall endpoints, grid intersections, room corners
        let closestSnap: Point2D | null = null;
        let closestDist = SNAP_RADIUS;

        // Check wall endpoints
        for (const wall of plan.walls) {
          const dist1 = Math.hypot(planX - wall.start.x, planY - wall.start.y);
          if (dist1 < closestDist) {
            closestSnap = wall.start;
            closestDist = dist1;
          }
          const dist2 = Math.hypot(planX - wall.end.x, planY - wall.end.y);
          if (dist2 < closestDist) {
            closestSnap = wall.end;
            closestDist = dist2;
          }
        }

        // Check room corners
        for (const room of plan.rooms) {
          for (const pt of room.polygon) {
            const dist = Math.hypot(planX - pt.x, planY - pt.y);
            if (dist < closestDist) {
              closestSnap = pt;
              closestDist = dist;
            }
          }
        }

        // Check grid intersections
        const grid = plan.structural_grid;
        const yPositions = grid.axis_positions_y || [
          grid.outer_wall_south_y || 0,
          grid.corridor_y_start_m || 0,
          (grid.corridor_y_start_m || 0) + (grid.corridor_width_m || 0),
          grid.outer_wall_north_y || grid.building_depth_m,
        ].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
        for (const gx of grid.axis_positions_x || []) {
          for (const gy of yPositions) {
            const dist = Math.hypot(planX - gx, planY - gy);
            if (dist < closestDist) {
              closestSnap = { x: gx, y: gy };
              closestDist = dist;
            }
          }
        }

        setSnapPoint(closestSnap);
        return;
      }

      setSnapPoint(null);

      // Find hovered apartment (prefer most specific match)
      let hoveredApt: FloorPlanApartment | null = null;
      let smallestArea = Infinity;

      for (const apt of plan.apartments) {
        for (const room of apt.rooms) {
          if (isPointInPolygon(mx, my, room.polygon, invTx, invTy)) {
            const aptArea = apt.rooms.reduce((sum, r) => sum + r.area_sqm, 0);
            if (aptArea < smallestArea) {
              hoveredApt = apt;
              smallestArea = aptArea;
            }
            break;
          }
        }
      }

      if (hoveredApt) {
        if (hoveredAptId !== hoveredApt.id) setHoveredAptId(hoveredApt.id);
        canvas.style.cursor = "pointer";
      } else {
        if (hoveredAptId !== null) setHoveredAptId(null);
        canvas.style.cursor = "default";
      }
      }); // end rAF callback
    },
    [
      plan,
      hoveredAptId,
      getTransform,
      measureMode,
      editMode,
      wallDrag,
      hoveredWallId,
      wallAtPoint,
      classifyWallAxis,
      snapForDrag,
      openingDrag,
      hoveredOpening,
      openingAtPoint,
      resizeHandleAtPoint,
      snapOpeningCoord,
      hoveredRoomId,
    ]
  );

  // ── Phase 7: zoom helpers ──────────────────────────────────────
  // Cursor-anchored zoom: when the user wheels over a point, that point
  // stays fixed in screen space. Toolbar/keyboard zoom anchors at the
  // canvas centre.
  const zoomAt = useCallback(
    (factor: number, screenX: number, screenY: number) => {
      const v = viewRef.current;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor));
      if (Math.abs(newZoom - v.zoom) < 1e-6) return;
      // Recompute base transform parameters (without view) so we can
      // solve for the pan that pins (screenX, screenY) to its current
      // world coordinate.
      const grid = plan.structural_grid;
      let minX = grid.origin?.x ?? 0;
      let minY = grid.origin?.y ?? 0;
      let maxX = minX + grid.building_length_m;
      let maxY = minY + grid.building_depth_m;
      if (allFloors && allFloors.length > 0) {
        for (const fp of allFloors) {
          const g = fp.structural_grid;
          const ox = g.origin?.x ?? 0;
          const oy = g.origin?.y ?? 0;
          if (ox < minX) minX = ox;
          if (oy < minY) minY = oy;
          if (ox + g.building_length_m > maxX) maxX = ox + g.building_length_m;
          if (oy + g.building_depth_m > maxY) maxY = oy + g.building_depth_m;
        }
      }
      const bldgW = Math.max(1, maxX - minX);
      const bldgH = Math.max(1, maxY - minY);
      const padding = 50;
      const baseScale = Math.min(
        (width - 2 * padding) / bldgW,
        (height - 2 * padding) / bldgH,
      );
      const baseOffsetX =
        padding + ((width - 2 * padding) - bldgW * baseScale) / 2 - minX * baseScale;
      const baseOffsetY =
        padding + ((height - 2 * padding) - bldgH * baseScale) / 2 - minY * baseScale;
      const cx = width / 2;
      const cy = height / 2;
      // World point under cursor at the *current* view.
      const oldFinalScale = baseScale * v.zoom;
      const oldOffsetX = v.panX + cx * (1 - v.zoom) + v.zoom * baseOffsetX;
      const oldOffsetY = (1 - v.zoom) * cy + v.zoom * baseOffsetY - v.panY;
      const wx = (screenX - oldOffsetX) / oldFinalScale;
      const wy = (height - screenY - oldOffsetY) / oldFinalScale;
      // Solve new pan so the same world point lands at (screenX, screenY)
      // under the new zoom.
      const newFinalScale = baseScale * newZoom;
      const newPanX =
        screenX - cx * (1 - newZoom) - newZoom * baseOffsetX - wx * newFinalScale;
      const newPanY =
        (1 - newZoom) * cy + newZoom * baseOffsetY + wy * newFinalScale - (height - screenY);
      setView({ zoom: newZoom, panX: newPanX, panY: newPanY });
    },
    [plan, allFloors, width, height],
  );

  const fitView = useCallback(() => {
    setView({ zoom: 1, panX: 0, panY: 0 });
  }, []);

  // Wheel handler must be attached non-passive so preventDefault stops
  // the page from scrolling. React's onWheel is passive in modern
  // browsers, hence the manual addEventListener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const listener = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    canvas.addEventListener("wheel", listener, { passive: false });
    return () => canvas.removeEventListener("wheel", listener);
  }, [zoomAt]);

  // ── Phase 7: fullscreen ────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen?.();
    } else {
      void el.requestFullscreen?.();
    }
  }, []);
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === wrapperRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Keyboard shortcuts (L10)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Phase 7: ignore zoom/pan shortcuts while typing in form inputs.
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // Space-held → enables hand-tool pan on primary button drag.
      if (e.code === "Space" && !isTyping) {
        if (!e.repeat) setSpaceHeld(true);
        e.preventDefault();
      }

      // Zoom & fit shortcuts (Phase 7)
      if (!isTyping && !e.ctrlKey && !e.metaKey) {
        const cx = (canvasRef.current?.width ?? width) / 2;
        const cy = (canvasRef.current?.height ?? height) / 2;
        if (e.key === "0") {
          fitView();
          return;
        }
        if (e.key === "+" || e.key === "=") {
          zoomAt(1.2, cx, cy);
          return;
        }
        if (e.key === "-" || e.key === "_") {
          zoomAt(1 / 1.2, cx, cy);
          return;
        }
        if (e.key === "f" || e.key === "F") {
          if (e.shiftKey) {
            toggleFullscreen();
            return;
          }
        }
      }

      if (e.key === "Escape") {
        if (wallDrag) {
          // Cancel active drag — revert to pre-drag snapshot
          if (preDragPlanRef.current) setEditedPlan(preDragPlanRef.current);
          preDragPlanRef.current = null;
          setWallDrag(null);
        } else if (openingDrag) {
          if (preDragPlanRef.current) setEditedPlan(preDragPlanRef.current);
          preDragPlanRef.current = null;
          setOpeningDrag(null);
        } else if (editMode === "wall") {
          setEditMode("none");
          setHoveredWallId(null);
        } else if (editMode === "opening") {
          if (openingAddMode !== "none") {
            setOpeningAddMode("none");
          } else if (selectedOpening) {
            setSelectedOpening(null);
          } else {
            setEditMode("none");
            setHoveredOpening(null);
          }
        } else if (editMode === "room") {
          if (roomEditor) {
            setRoomEditor(null);
          } else {
            setEditMode("none");
            setHoveredRoomId(null);
          }
        } else if (measureMode) {
          setMeasureMode(false);
          setMeasurePoints([]);
        } else if (onApartmentSelect) {
          onApartmentSelect(null); // Deselect apartment
        }
      }
      // Delete selected opening
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        editMode === "opening" &&
        selectedOpening &&
        !openingDrag
      ) {
        e.preventDefault();
        const prev = editedPlanRef.current;
        const next: FloorPlan =
          selectedOpening.kind === "window"
            ? { ...prev, windows: prev.windows.filter((w) => w.id !== selectedOpening.id) }
            : { ...prev, doors: prev.doors.filter((d) => d.id !== selectedOpening.id) };
        commitEdit(next);
        setSelectedOpening(null);
        setHoveredOpening(null);
      }
      if (e.key === "m" || e.key === "M") {
        setMeasureMode((prev) => !prev);
        setMeasurePoints([]);
      }
      if (e.key === "c" || e.key === "C") {
        setMeasurePoints([]);
      }
      // Undo / redo (Phase 3.7a) — only when no drag is active. Ctrl+Shift+Z
      // also triggers redo to match most editors' expectation.
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !wallDrag && !openingDrag) {
        if (e.key === "z" || e.key === "Z") {
          e.preventDefault();
          if (e.shiftKey) {
            redo();
          } else {
            undo();
          }
        } else if (e.key === "y" || e.key === "Y") {
          e.preventDefault();
          redo();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    measureMode, onApartmentSelect, editMode, wallDrag, openingDrag,
    selectedOpening, roomEditor, undo, redo, commitEdit, openingAddMode,
    fitView, zoomAt, toggleFullscreen, width, height,
  ]);

  // Main draw effect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const { tx, ty, ts, scale } = getTransform();
    const grid = plan.structural_grid;
    const bldgW = grid.building_length_m;
    const bldgH = grid.building_depth_m;

    const isPresentation = viewMode === "presentation";

    // --- 1. Background ---
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = isPresentation ? "#ffffff" : "#fafaf8";
    ctx.fillRect(0, 0, width, height);

    // --- 2. Building shadow/depth effect (Architect mode only) ---
    if (!isPresentation) {
      ctx.fillStyle = "#e8e4df";
      const shadowOffset = 2;
      ctx.fillRect(tx(0) + shadowOffset, ty(bldgH) + shadowOffset, ts(bldgW), ts(bldgH));
    }

    // --- 3. Building outline ---
    ctx.strokeStyle = "#2b2520";
    ctx.lineWidth = isPresentation ? 1.8 : 2.5;
    ctx.strokeRect(tx(0), ty(bldgH), ts(bldgW), ts(bldgH));

    // --- 4. Structural grid with axis labels ---
    if (layers.grid) {
      drawStructuralGrid(ctx, grid, tx, ty, ts, bldgH);
    }

    // --- 5. Rooms (filled polygons) ---
    const allRooms = [...plan.rooms];
    if (layers.rooms) {
      for (const room of allRooms) {
        drawRoom(ctx, room, tx, ty, hoveredAptId, selectedApartmentId);
      }
    }

    // --- 6. Apartment outlines (trace actual apartment boundary) ---
    if (layers.rooms) {
      for (const apt of plan.apartments) {
        const isSelected = apt.id === selectedApartmentId;
        const isHovered = apt.id === hoveredAptId;
        if (isSelected || isHovered) {
          drawApartmentOutline(ctx, apt, tx, ty, ts, isSelected);
        }
      }
    }

    // --- 7. Walls (filled rectangles with proper thickness) ---
    if (layers.walls) {
      for (const wall of plan.walls) {
        drawWall(ctx, wall, tx, ty, ts);
      }
    }

    // --- 8. Windows (architectural symbols — oriented along host wall) ---
    if (layers.openings) {
      for (const win of plan.windows) {
        const hostWall = findNearestWall2D(win.position, plan.walls);
        drawWindow(ctx, win, hostWall, tx, ty, ts);
      }

      // --- 9. Doors (architectural swing arcs — oriented along host wall) ---
      for (const door of plan.doors) {
        const hostWall = findNearestWall2D(door.position, plan.walls);
        drawDoor(ctx, door, hostWall, tx, ty, ts);
      }
    }

    // --- 9b. Furniture silhouettes (Phase 4.1) ---
    //   Drawn BEFORE labels so room names stay on top of the furniture layer.
    if (layers.furniture) {
      drawFurnitureLayer(ctx, plan.rooms, furnitureByRoom, tx, ty, ts);
    }

    // --- 10. Room labels (professional typography) ---
    if (layers.labels) {
      drawRoomLabels(ctx, allRooms, tx, ty, ts);
    }

    // --- 11. Dimension lines with architectural style ---
    if (layers.dimensions) {
      drawDimensionLines(ctx, grid, tx, ty, ts, bldgW, bldgH);
    }

    // --- 12. Scale bar ---
    if (layers.annotations) {
      drawScaleBar(ctx, width, height, scale);

      // --- 13. North arrow ---
      drawNorthArrow(ctx, width, height);
    }

    // --- 14. Measurement visualization (enhanced) ---
    if (measurePoints.length > 0) {
      drawMeasurements(ctx, measurePoints, snapPoint, tx, ty, ts);
    }

    // --- 15. Snap point indicator ---
    if (snapPoint && measureMode) {
      ctx.fillStyle = "#d97706";
      ctx.beginPath();
      ctx.arc(tx(snapPoint.x), ty(snapPoint.y), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- 15b. Edit-mode overlays (draggable partitions + drag preview) ---
    if (editMode === "wall") {
      drawEditOverlay(ctx, plan, wallDrag, hoveredWallId, tx, ty);
    }

    // --- 15c. Opening-edit overlay (Phase 3.6c) ---
    if (editMode === "opening") {
      drawOpeningEditOverlay(
        ctx,
        plan,
        openingDrag,
        hoveredOpening,
        selectedOpening,
        tx,
        ty,
        ts,
      );
    }

    // --- 15d. Room-edit overlay (Phase 3.6d) ---
    if (editMode === "room") {
      drawRoomEditOverlay(
        ctx,
        plan,
        hoveredRoomId,
        roomEditor,
        tx,
        ty,
      );
    }

    // --- 15e. Validation overlay (Phase 3.6e) ---
    if (layers.validation && validation.issues.length > 0) {
      drawValidationOverlay(ctx, plan, validation, tx, ty);
    }
    // Focused room flash (triggered by clicking a validation panel row)
    if (focusedRoomId) {
      const r = plan.rooms.find((x) => x.id === focusedRoomId);
      if (r && r.polygon.length >= 3) {
        ctx.save();
        ctx.beginPath();
        r.polygon.forEach((p, i) => {
          if (i === 0) ctx.moveTo(tx(p.x), ty(p.y));
          else ctx.lineTo(tx(p.x), ty(p.y));
        });
        ctx.closePath();
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // --- 16. Title and metadata ---
    if (!layers.annotations) return;
    ctx.fillStyle = "#2b2520";
    ctx.font = "bold 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      `${plan.floor_index === 0 ? "EG" : `${plan.floor_index}. OG`} \u2022 ${plan.num_apartments} Wohnungen \u2022 ${
        plan.access_type === "ganghaus"
          ? "Central Corridor"
          : plan.access_type === "laubengang"
            ? "External Gallery"
            : "Direct Access"
      }`,
      12,
      18
    );

    ctx.fillStyle = "#7a7066";
    ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      `Gross: ${plan.gross_area_sqm.toFixed(1)}m\u00B2 | Net: ${plan.net_area_sqm.toFixed(1)}m\u00B2`,
      12,
      height - 8
    );
  }, [
    plan,
    width,
    height,
    hoveredAptId,
    selectedApartmentId,
    getTransform,
    measurePoints,
    snapPoint,
    measureMode,
    layers,
    viewMode,
    editMode,
    wallDrag,
    hoveredWallId,
    openingDrag,
    hoveredOpening,
    selectedOpening,
    hoveredRoomId,
    roomEditor,
    validation,
    focusedRoomId,
    furnitureByRoom,
  ]);

  const handleMeasureToggle = () => {
    setMeasureMode(!measureMode);
    setMeasurePoints([]);
  };

  const handleClearMeasurements = () => {
    setMeasurePoints([]);
  };

  // Phase 4.2 — DIN A3 PDF export. Rasterizes the plan at the chosen
  // architectural scale (auto-picked 1:50/100/200/500) on an offscreen
  // canvas using the same module-scope draw helpers the viewer uses,
  // then embeds it into a landscape A3 sheet with a title block.
  // Factory: builds an ExportPdfOptions for any FloorPlan, reusing the
  // exact screen-draw helpers so single + batch exports share linework.
  const buildPdfOptions = useCallback(
    (p: FloorPlan): ExportPdfOptions => {
      const floorLabel =
        p.floor_type === "staffelgeschoss"
          ? "SG"
          : p.floor_index === 0
            ? "EG"
            : `${p.floor_index}. OG`;
      const furnitureForP =
        p === plan ? furnitureByRoom : placeFurnitureForPlan(p);
      return {
        plan: p,
        title: {
          projectName: "Goldbeck Residential",
          buildingName: buildingId ?? undefined,
          floorLabel,
          notes: "Auto-generated layout — architectural draft",
          author: "Goldbeck Optimizer",
        },
        drawPlan: (ctx, pxW, pxH, pxPerM) => {
          const grid = p.structural_grid;
          const bldgW = grid.building_length_m;
          const bldgH = grid.building_depth_m;
          const paddingPx = (pxW - bldgW * pxPerM) / 2;
          const tx = (x: number) => paddingPx + x * pxPerM;
          const ty = (y: number) => pxH - paddingPx - y * pxPerM;
          const ts = (s: number) => s * pxPerM;

          ctx.strokeStyle = "#2b2520";
          ctx.lineWidth = 2.0;
          ctx.strokeRect(tx(0), ty(bldgH), ts(bldgW), ts(bldgH));

          for (const room of p.rooms) {
            drawRoom(ctx, room, tx, ty, null, null);
          }
          for (const wall of p.walls) {
            drawWall(ctx, wall, tx, ty, ts);
          }
          for (const win of p.windows) {
            const host = findNearestWall2D(win.position, p.walls);
            drawWindow(ctx, win, host, tx, ty, ts);
          }
          for (const door of p.doors) {
            const host = findNearestWall2D(door.position, p.walls);
            drawDoor(ctx, door, host, tx, ty, ts);
          }
          if (layers.furniture) {
            drawFurnitureLayer(ctx, p.rooms, furnitureForP, tx, ty, ts);
          }
          drawRoomLabels(ctx, p.rooms, tx, ty, ts);
          drawDimensionLines(ctx, grid, tx, ty, ts, bldgW, bldgH);
          drawNorthArrow(ctx, pxW, pxH);
          drawScaleBar(ctx, pxW, pxH, pxPerM);
        },
      };
    },
    [plan, buildingId, layers.furniture, furnitureByRoom],
  );

  const handleExportPdf = useCallback(() => {
    try {
      downloadFloorPlanPdf(buildPdfOptions(plan));
    } catch (err) {
      console.error("[pdf-export] failed:", err);
      alert("PDF-Export fehlgeschlagen — siehe Konsole");
    }
  }, [plan, buildPdfOptions]);

  // Phase 5b — multi-floor batch export. Iterates every floor of the
  // current building and emits a single multi-page A3 PDF.
  const handleExportAllFloorsPdf = useCallback(() => {
    if (!allFloors || allFloors.length === 0) return;
    try {
      downloadMultiPlanPdf({
        pages: allFloors.map((fp) => buildPdfOptions(fp)),
      });
    } catch (err) {
      console.error("[pdf-export-batch] failed:", err);
      alert("Batch-PDF-Export fehlgeschlagen — siehe Konsole");
    }
  }, [allFloors, buildPdfOptions]);

  // Phase 7: cursor reflects the active gesture so the user knows when
  // a pan is available (space held / middle button capable) vs the
  // default cursor used for clicks and edit modes.
  const canvasCursor = panDragRef.current
    ? "grabbing"
    : spaceHeld
      ? "grab"
      : "default";

  return (
    <div
      ref={wrapperRef}
      className={`relative inline-block ${
        isFullscreen ? "w-screen h-screen bg-white" : ""
      }`}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: isFullscreen ? "100vw" : width,
          height: isFullscreen ? "100vh" : height,
          cursor: canvasCursor,
        }}
        className={`border rounded-lg bg-white ${isFullscreen ? "" : ""}`}
        tabIndex={0}
        role="img"
        aria-label={`Grundriss ${plan.floor_index === 0 ? "EG" : `${plan.floor_index}. OG`} — ${plan.apartments.length} Wohnungen`}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onMouseMove={handleMouseMove}
        onContextMenu={(e) => {
          // Right-click traditionally pans in CAD apps; suppress the
          // browser menu so the gesture is usable. We don't yet wire
          // right-button drag to pan (middle button + space already
          // cover the use cases) but suppressing the menu keeps it
          // available as a future affordance.
          if (spaceHeld) e.preventDefault();
        }}
      />
      <div className="absolute top-2 right-2 flex gap-2">
        {/* View mode segmented toggle */}
        {/* Phase 7: view controls — zoom +/-, fit, fullscreen */}
        <div className="inline-flex rounded overflow-hidden border border-neutral-300 text-sm font-medium bg-white">
          <button
            type="button"
            onClick={() => {
              const cv = canvasRef.current;
              if (!cv) return;
              zoomAt(1 / 1.2, cv.width / 2, cv.height / 2);
            }}
            className="px-2.5 py-1.5 text-gray-700 hover:bg-gray-100 transition-colors"
            title="Verkleinern (−)"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={fitView}
            className="px-2.5 py-1.5 text-gray-700 hover:bg-gray-100 border-l border-neutral-300 transition-colors font-mono text-xs"
            title="An Inhalt anpassen (0)"
            aria-label="Zoom to fit"
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => {
              const cv = canvasRef.current;
              if (!cv) return;
              zoomAt(1.2, cv.width / 2, cv.height / 2);
            }}
            className="px-2.5 py-1.5 text-gray-700 hover:bg-gray-100 border-l border-neutral-300 transition-colors"
            title="Vergrößern (+)"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className={`px-2.5 py-1.5 border-l border-neutral-300 transition-colors ${
              isFullscreen
                ? "bg-neutral-900 text-white hover:bg-neutral-800"
                : "text-gray-700 hover:bg-gray-100"
            }`}
            title={isFullscreen ? "Vollbild verlassen (Shift+F)" : "Vollbild (Shift+F)"}
            aria-label="Toggle fullscreen"
          >
            {isFullscreen ? "⤡" : "⤢"}
          </button>
        </div>

        <div className="inline-flex rounded overflow-hidden border border-neutral-300 text-sm font-medium">
          <button
            onClick={() => applyViewMode("architect")}
            className={`px-3 py-1.5 transition-colors ${
              viewMode === "architect"
                ? "bg-neutral-900 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
            title="Technical drawing — all layers, grid, dimensions"
          >
            Architect
          </button>
          <button
            onClick={() => applyViewMode("presentation")}
            className={`px-3 py-1.5 transition-colors border-l border-neutral-300 ${
              viewMode === "presentation"
                ? "bg-neutral-900 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
            title="Client-facing — clean layout, no grid or dimensions"
          >
            Presentation
          </button>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowLayerPanel((v) => !v)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              showLayerPanel
                ? "bg-neutral-900 text-white hover:bg-neutral-800"
                : "bg-gray-200 text-gray-800 hover:bg-gray-300"
            }`}
            title="Ebenen ein-/ausblenden"
          >
            Layers
          </button>
          {showLayerPanel && (
            <div className="absolute top-full right-0 mt-1 w-48 bg-white border rounded-lg shadow-lg p-2 z-10 text-sm">
              {([
                ["grid", "Structural grid"],
                ["rooms", "Rooms"],
                ["walls", "Walls"],
                ["openings", "Doors & Windows"],
                ["labels", "Room labels"],
                ["dimensions", "Dimensions"],
                ["annotations", "North / scale / title"],
                ["validation", "Validation issues"],
                ["furniture", "Möblierung (DIN)"],
              ] as const).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={layers[key]}
                    onChange={() => toggleLayer(key)}
                    className="accent-neutral-900"
                  />
                  <span className="text-neutral-700">{label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        {/* Undo / Redo (Phase 3.7a) */}
        <div className="inline-flex rounded overflow-hidden border border-neutral-300 text-sm font-medium">
          <button
            onClick={undo}
            disabled={!canUndo || !!wallDrag || !!openingDrag}
            className={`px-2.5 py-1.5 transition-colors ${
              canUndo && !wallDrag && !openingDrag
                ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                : "bg-gray-50 text-gray-300 cursor-not-allowed"
            }`}
            title={`Rückgängig (Ctrl+Z)${canUndo ? ` — ${history.index} Schritt${history.index === 1 ? "" : "e"} verfügbar` : ""}`}
            aria-label="Undo"
          >
            {/* Undo arrow glyph */}
            <span aria-hidden>↶</span>
          </button>
          <button
            onClick={redo}
            disabled={!canRedo || !!wallDrag || !!openingDrag}
            className={`px-2.5 py-1.5 transition-colors border-l border-neutral-300 ${
              canRedo && !wallDrag && !openingDrag
                ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                : "bg-gray-50 text-gray-300 cursor-not-allowed"
            }`}
            title={`Wiederherstellen (Ctrl+Y / Ctrl+Shift+Z)${canRedo ? ` — ${history.stack.length - 1 - history.index} Schritt${history.stack.length - 1 - history.index === 1 ? "" : "e"} verfügbar` : ""}`}
            aria-label="Redo"
          >
            <span aria-hidden>↷</span>
          </button>
        </div>
        {/* "Restored from localStorage" pill (Phase 3.7b) — only while
            current history tip still differs from the original plan, so
            the pill disappears after a user hits Reset or undoes all. */}
        {restoredFromStore && editedPlan !== floorPlan && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-300"
            title="Änderungen wurden aus dem lokalen Speicher wiederhergestellt"
          >
            <span aria-hidden>◍</span>
            wiederhergestellt
          </span>
        )}
        <button
          onClick={() => {
            setEditMode((prev) => {
              const next = prev === "wall" ? "none" : "wall";
              if (next === "wall" && measureMode) {
                setMeasureMode(false);
                setMeasurePoints([]);
              }
              return next;
            });
            setWallDrag(null);
            setHoveredWallId(null);
            // Mutually exclusive with other edit modes
            setSelectedOpening(null);
            setHoveredOpening(null);
            setOpeningDrag(null);
            setRoomEditor(null);
            setHoveredRoomId(null);
          }}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            editMode === "wall"
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "bg-gray-200 text-gray-800 hover:bg-gray-300"
          }`}
          title="Trennwände verschieben — Rasterung 62.5cm (Esc zum Beenden)"
        >
          {editMode === "wall" ? "Editing..." : "Edit"}
        </button>
        <button
          onClick={() => {
            setEditMode((prev) => {
              const next = prev === "opening" ? "none" : "opening";
              if (next === "opening" && measureMode) {
                setMeasureMode(false);
                setMeasurePoints([]);
              }
              return next;
            });
            // Mutually exclusive with other edit modes
            setWallDrag(null);
            setHoveredWallId(null);
            setSelectedOpening(null);
            setHoveredOpening(null);
            setOpeningDrag(null);
            setRoomEditor(null);
            setHoveredRoomId(null);
            setOpeningAddMode("none");
          }}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            editMode === "opening"
              ? "bg-sky-600 text-white hover:bg-sky-700"
              : "bg-gray-200 text-gray-800 hover:bg-gray-300"
          }`}
          title="Türen & Fenster bearbeiten — verschieben, Breite ändern, Entf-Taste zum Löschen"
        >
          {editMode === "opening" ? "Openings..." : "Openings"}
        </button>
        {/* Add-new opening sub-toolbar — only in opening edit mode (Phase 3.6c add) */}
        {editMode === "opening" && (
          <div className="inline-flex rounded overflow-hidden border border-sky-300 text-sm font-medium">
            <button
              onClick={() => setOpeningAddMode((p) => (p === "window" ? "none" : "window"))}
              className={`px-2.5 py-1.5 transition-colors ${
                openingAddMode === "window"
                  ? "bg-sky-500 text-white"
                  : "bg-sky-50 text-sky-800 hover:bg-sky-100"
              }`}
              title="Neues Fenster platzieren — auf Außenwand klicken (1.20 × 1.50 m Standard)"
            >
              + Fenster
            </button>
            <button
              onClick={() => setOpeningAddMode((p) => (p === "door" ? "none" : "door"))}
              className={`px-2.5 py-1.5 border-l border-sky-300 transition-colors ${
                openingAddMode === "door"
                  ? "bg-sky-500 text-white"
                  : "bg-sky-50 text-sky-800 hover:bg-sky-100"
              }`}
              title="Neue Tür platzieren — auf beliebige Wand klicken (0.95 m barrierefrei)"
            >
              + Tür
            </button>
          </div>
        )}
        <button
          onClick={() => {
            setEditMode((prev) => {
              const next = prev === "room" ? "none" : "room";
              if (next === "room" && measureMode) {
                setMeasureMode(false);
                setMeasurePoints([]);
              }
              return next;
            });
            // Mutually exclusive with other edit modes
            setWallDrag(null);
            setHoveredWallId(null);
            setSelectedOpening(null);
            setHoveredOpening(null);
            setOpeningDrag(null);
            setRoomEditor(null);
            setHoveredRoomId(null);
          }}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            editMode === "room"
              ? "bg-violet-600 text-white hover:bg-violet-700"
              : "bg-gray-200 text-gray-800 hover:bg-gray-300"
          }`}
          title="Räume umwidmen — auf einen Raum klicken, um den Typ zu ändern"
        >
          {editMode === "room" ? "Rooms..." : "Rooms"}
        </button>
        {editedPlan !== floorPlan && (
          <button
            onClick={() => {
              setHistory({ stack: [floorPlan], index: 0 });
              setRestoredFromStore(false);
              setWallDrag(null);
              setHoveredWallId(null);
              // Store entry is also cleared by the persistence effect
              // when it sees history tip === floorPlan again, but clear
              // eagerly here so the pill disappears immediately.
              if (persistKey) clearEditedFloorPlan(persistKey);
              // Fire-and-forget backend delete so the override doesn't
              // resurrect on the next mount via the hydration fetch.
              if (buildingId && floorIndex !== undefined) {
                deleteOverride(buildingId, floorIndex).catch((err) => {
                  console.debug("[override-delete] failed (ignored):", err);
                });
              }
            }}
            className="px-3 py-1.5 rounded text-sm font-medium bg-gray-200 text-gray-800 hover:bg-gray-300 transition-colors"
            title="Alle Änderungen verwerfen (Verlauf löschen)"
          >
            Reset
          </button>
        )}
        <button
          onClick={handleMeasureToggle}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            measureMode
              ? "bg-amber-600 text-white hover:bg-amber-700"
              : "bg-gray-200 text-gray-800 hover:bg-gray-300"
          }`}
          title="Measure tool (Esc to exit)"
        >
          {measureMode ? "Measuring..." : "Measure"}
        </button>
        <button
          onClick={() => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const link = document.createElement("a");
            link.download = `grundriss_${plan.floor_index === 0 ? "EG" : `${plan.floor_index}OG`}.png`;
            link.href = canvas.toDataURL("image/png");
            link.click();
          }}
          className="px-3 py-1.5 rounded text-sm font-medium bg-gray-200 text-gray-800 hover:bg-gray-300 transition-colors"
          title="Grundriss als PNG exportieren"
        >
          PNG
        </button>
        <button
          onClick={handleExportPdf}
          className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
          title="Grundriss als DIN A3 PDF (1:100 oder auto) exportieren"
        >
          PDF
        </button>
        {allFloors && allFloors.length > 1 && (
          <button
            onClick={handleExportAllFloorsPdf}
            className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-700 text-white hover:bg-neutral-600 transition-colors"
            title={`Alle ${allFloors.length} Geschosse als mehrseitiges DIN A3 PDF exportieren`}
          >
            PDF ×{allFloors.length}
          </button>
        )}
        <button
          className="w-7 h-7 rounded-full bg-gray-200 text-gray-600 hover:bg-gray-300 text-xs font-bold transition-colors"
          title="M = Messen, C = Löschen, Esc = Abwählen"
        >
          ?
        </button>
        {measurePoints.length > 0 && (
          <button
            onClick={handleClearMeasurements}
            className="px-3 py-1.5 rounded text-sm font-medium bg-gray-200 text-gray-800 hover:bg-gray-300 transition-colors"
            title="Clear all measurements"
          >
            Clear
          </button>
        )}
      </div>
      {inspected && (
        <InspectorPanel inspected={inspected} onClose={() => setInspected(null)} />
      )}
      {editMode === "room" && roomEditor && (() => {
        const room = plan.rooms.find((r) => r.id === roomEditor.roomId);
        if (!room) return null;
        // Topology eligibility (Phase 3.6d add). canSplit: living room,
        // rectangular, ≥ 20m². canMerge: living with an adjacent kitchen
        // in the same apartment sharing a full edge.
        const canSplit =
          room.room_type === "living" &&
          room.polygon.length === 4 &&
          room.area_sqm >= MIN_WOHNKUECHE_SPLIT_AREA_SQM;
        let canMerge = false;
        if (room.room_type === "living" && room.polygon.length === 4) {
          const owningApt = plan.apartments.find((a) =>
            a.rooms.some((r) => r.id === room.id),
          );
          if (owningApt) {
            canMerge = owningApt.rooms.some(
              (r) =>
                r.room_type === "kitchen" &&
                r.polygon.length === 4 &&
                !!findSharedEdge(room.polygon, r.polygon),
            );
          }
        }
        return (
          <RoomTypePopover
            room={room}
            anchorX={roomEditor.screenX}
            anchorY={roomEditor.screenY}
            canSplit={canSplit}
            canMerge={canMerge}
            onClose={() => setRoomEditor(null)}
            onApply={(newType) => {
              const nextPlan = applyRoomTypeChangeOnPlan(editedPlan, room.id, newType);
              commitEdit(nextPlan);
              setRoomEditor(null);
            }}
            onSplit={() => {
              const nextPlan = applyWohnkuecheSplit(editedPlan, room.id);
              if (nextPlan) {
                commitEdit(nextPlan);
                setRoomEditor(null);
              } else {
                console.warn("[room-split] operation not valid");
              }
            }}
            onMerge={() => {
              const nextPlan = applyKitchenMerge(editedPlan, room.id);
              if (nextPlan) {
                commitEdit(nextPlan);
                setRoomEditor(null);
              } else {
                console.warn("[room-merge] no mergeable kitchen found");
              }
            }}
          />
        );
      })()}
      {layers.validation && (
        <ValidationPanel
          plan={plan}
          validation={validation}
          open={validationPanelOpen}
          onToggle={() => setValidationPanelOpen((v) => !v)}
          onFocusRoom={focusRoom}
          onFocusApartment={(aptId) => {
            const apt = plan.apartments.find((a) => a.id === aptId);
            if (apt && onApartmentSelect) onApartmentSelect(apt);
          }}
        />
      )}
    </div>
  );
}

// ── Element inspector overlay ─────────────────────────────────────────────

function InspectorPanel({
  inspected,
  onClose,
}: {
  inspected:
    | { kind: "wall"; data: WallSegment }
    | { kind: "window"; data: WindowPlacement }
    | { kind: "door"; data: DoorPlacement }
    | { kind: "room"; data: FloorPlanRoom };
  onClose: () => void;
}) {
  let title = "";
  const rows: [string, string][] = [];

  if (inspected.kind === "wall") {
    const w = inspected.data;
    const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    title = w.is_bearing
      ? w.is_exterior ? "Tragende Außenwand" : "Tragende Innenwand"
      : "Nichttragende Wand";
    rows.push(["ID", w.id]);
    rows.push(["Type", w.wall_type]);
    rows.push(["Length", `${len.toFixed(2)} m`]);
    rows.push(["Thickness", `${(w.thickness_m * 100).toFixed(0)} cm`]);
    rows.push(["Bearing", w.is_bearing ? "Yes" : "No"]);
    rows.push(["Exterior", w.is_exterior ? "Yes" : "No"]);
  } else if (inspected.kind === "window") {
    const win = inspected.data;
    title = win.is_floor_to_ceiling ? "Bodentiefes Fenster" : "Fenster";
    rows.push(["ID", win.id]);
    rows.push(["Width", `${win.width_m.toFixed(2)} m`]);
    rows.push(["Height", `${win.height_m.toFixed(2)} m`]);
    rows.push(["Sill height", `${win.sill_height_m.toFixed(2)} m`]);
    rows.push(["Position", `x=${win.position.x.toFixed(2)}, y=${win.position.y.toFixed(2)}`]);
  } else if (inspected.kind === "door") {
    const d = inspected.data;
    title = d.is_entrance ? "Wohnungseingangstür" : "Innentür";
    rows.push(["ID", d.id]);
    rows.push(["Width", `${d.width_m.toFixed(2)} m`]);
    rows.push(["Height", `${d.height_m.toFixed(2)} m`]);
    rows.push(["Swing", d.swing_direction]);
    rows.push(["Entrance", d.is_entrance ? "Yes" : "No"]);
  } else {
    const r = inspected.data;
    title = r.label || r.room_type;
    rows.push(["ID", r.id]);
    rows.push(["Type", r.room_type]);
    rows.push(["Area", `${r.area_sqm.toFixed(2)} m²`]);
    if (r.apartment_id) rows.push(["Apartment", r.apartment_id]);
  }

  return (
    <div className="absolute bottom-2 left-2 w-64 bg-white/95 backdrop-blur border rounded-lg shadow-lg text-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-neutral-50 rounded-t-lg">
        <span className="font-semibold text-neutral-800 text-xs uppercase tracking-wide">
          {title}
        </span>
        <button
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-700 leading-none text-lg"
          title="Close inspector"
        >
          ×
        </button>
      </div>
      <div className="px-3 py-2 space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-neutral-500">{k}</span>
            <span className="text-xs font-medium text-neutral-800 text-right break-all">
              {v}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Room-type reassignment popover (Phase 3.6d) ───────────────────────────

/**
 * Floating popover anchored near the clicked room. Offers the six reassignable
 * room types; disables any whose DIN minimum area exceeds the clicked room's
 * area. The currently-assigned type is marked with a violet ring and skipped
 * on apply (closes without change). Auto-closes on outside click via the
 * parent's canvas mouse handler (which resets `roomEditor` when the click
 * doesn't hit a reassignable room).
 */
function RoomTypePopover({
  room,
  anchorX,
  anchorY,
  canSplit,
  canMerge,
  onClose,
  onApply,
  onSplit,
  onMerge,
}: {
  room: FloorPlanRoom;
  anchorX: number;
  anchorY: number;
  /** True when this room is eligible for the Wohnküche-split operation
   *  (living room, ≥ 20 m², rectangular). Phase 3.6d add. */
  canSplit: boolean;
  /** True when this room is eligible to merge an adjacent kitchen into
   *  itself (living room with a kitchen next door in the same apt). */
  canMerge: boolean;
  onClose: () => void;
  onApply: (newType: (typeof REASSIGNABLE_ROOM_TYPES)[number]) => void;
  onSplit: () => void;
  onMerge: () => void;
}) {
  // Popover card size: ~ 200 × 200 px. Nudge anchor so the card doesn't
  // overflow the canvas on right / bottom edges — we clamp by subtracting
  // from the anchor when the click is too close to the edge.
  const CARD_W = 216;
  const CARD_H = canSplit || canMerge ? 320 : 250;
  const PAD = 8;
  const offsetX = 14;  // a bit to the right of the cursor
  const offsetY = 14;  // and below it

  // Rough clamp against canvas wrapper: we don't know the wrapper size here,
  // so simply shift left/up if the anchor + offset would clearly overflow a
  // minimum viewport assumption. This is best-effort; the card still renders
  // even if partially clipped.
  let left = anchorX + offsetX;
  let top = anchorY + offsetY;
  if (left + CARD_W + PAD > window.innerWidth) {
    left = Math.max(PAD, anchorX - CARD_W - offsetX);
  }
  if (top + CARD_H + PAD > window.innerHeight) {
    top = Math.max(PAD, anchorY - CARD_H - offsetY);
  }

  return (
    <div
      className="absolute bg-white/98 backdrop-blur border-2 border-violet-400 rounded-lg shadow-xl text-sm z-20"
      style={{ left, top, width: CARD_W }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-violet-200 bg-violet-50 rounded-t-lg">
        <span className="font-semibold text-violet-900 text-xs uppercase tracking-wide">
          Raumtyp ändern
        </span>
        <button
          onClick={onClose}
          className="text-violet-400 hover:text-violet-700 leading-none text-lg"
          title="Schließen (Esc)"
        >
          ×
        </button>
      </div>
      <div className="px-3 py-2 border-b border-violet-100 bg-white">
        <div className="text-[11px] text-neutral-500">Aktuell</div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-neutral-800 truncate">
            {room.label || room.room_type}
          </span>
          <span className="text-[11px] font-mono text-neutral-500 shrink-0">
            {room.area_sqm.toFixed(1)} m²
          </span>
        </div>
      </div>
      <div className="p-2 grid grid-cols-2 gap-1.5">
        {REASSIGNABLE_ROOM_TYPES.map((t) => {
          const isCurrent = room.room_type === t;
          const minReq = MIN_ROOM_AREA_SQM[t] ?? 0;
          const disabled = !isCurrent && room.area_sqm < minReq;
          const title = disabled
            ? `DIN-Minimum ${minReq.toFixed(1)} m² — Raum ist zu klein (${room.area_sqm.toFixed(1)} m²)`
            : isCurrent
              ? "Bereits zugewiesen"
              : `Als ${ROOM_TYPE_LABELS[t]} markieren (min ${minReq.toFixed(1)} m²)`;
          return (
            <button
              key={t}
              onClick={() => {
                if (disabled) return;
                if (isCurrent) {
                  onClose();
                  return;
                }
                onApply(t);
              }}
              disabled={disabled}
              title={title}
              className={`px-2 py-1.5 rounded text-xs font-medium transition-colors border ${
                isCurrent
                  ? "bg-violet-600 text-white border-violet-600 ring-2 ring-violet-300 cursor-default"
                  : disabled
                    ? "bg-neutral-50 text-neutral-300 border-neutral-200 cursor-not-allowed"
                    : "bg-white text-neutral-800 border-neutral-300 hover:bg-violet-50 hover:border-violet-400 cursor-pointer"
              }`}
            >
              <div className="truncate">{ROOM_TYPE_LABELS[t]}</div>
              <div
                className={`text-[10px] font-mono ${
                  isCurrent
                    ? "text-violet-100"
                    : disabled
                      ? "text-neutral-300"
                      : "text-neutral-400"
                }`}
              >
                ≥ {minReq.toFixed(1)} m²
              </div>
            </button>
          );
        })}
      </div>
      {/* Topology operations — split/merge (Phase 3.6d add) */}
      {(canSplit || canMerge) && (
        <div className="border-t border-violet-100 bg-violet-50/50 p-2 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-violet-700 px-1">
            Topologie
          </div>
          {canSplit && (
            <button
              onClick={onSplit}
              title="Wohnraum in Wohnen + Küche teilen (neue Trennwand, 70/30)"
              className="w-full px-2 py-1.5 rounded text-xs font-medium bg-white text-violet-800 border border-violet-300 hover:bg-violet-100 hover:border-violet-400 transition-colors text-left"
            >
              <div className="flex items-center gap-1.5">
                <span aria-hidden>◨</span>
                <span>Wohnküche teilen</span>
              </div>
              <div className="text-[10px] font-normal text-violet-500 mt-0.5">
                → Wohnen + Küche (neue Trennwand)
              </div>
            </button>
          )}
          {canMerge && (
            <button
              onClick={onMerge}
              title="Angrenzende Küche einbeziehen (Trennwand entfällt → Wohnküche)"
              className="w-full px-2 py-1.5 rounded text-xs font-medium bg-white text-violet-800 border border-violet-300 hover:bg-violet-100 hover:border-violet-400 transition-colors text-left"
            >
              <div className="flex items-center gap-1.5">
                <span aria-hidden>◫</span>
                <span>Mit Küche vereinen</span>
              </div>
              <div className="text-[10px] font-normal text-violet-500 mt-0.5">
                → Wohnküche (Trennwand entfällt)
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Validation summary panel (Phase 3.6e) ─────────────────────────────────

/**
 * Collapsible panel anchored bottom-right. Collapsed: shows a single pill
 * with the error + warning counts, colour-coded (green when all-clear).
 * Expanded: scrollable list of issues grouped by apartment, click a row to
 * focus (flash) the offending room on the canvas and open the inspector.
 */
function ValidationPanel({
  plan,
  validation,
  open,
  onToggle,
  onFocusRoom,
  onFocusApartment,
}: {
  plan: FloorPlan;
  validation: ValidationResult;
  open: boolean;
  onToggle: () => void;
  onFocusRoom: (roomId: string) => void;
  onFocusApartment: (apartmentId: string) => void;
}) {
  const { errorCount, warnCount, issues } = validation;
  const total = errorCount + warnCount;
  const allClear = total === 0;

  // Collapsed pill
  if (!open) {
    const pillColor = allClear
      ? "bg-emerald-600 hover:bg-emerald-700"
      : errorCount > 0
        ? "bg-rose-600 hover:bg-rose-700"
        : "bg-amber-500 hover:bg-amber-600";
    return (
      <button
        onClick={onToggle}
        className={`absolute bottom-2 right-2 flex items-center gap-2 px-3 py-1.5 rounded-full shadow-lg text-white text-sm font-medium transition-colors z-20 ${pillColor}`}
        title={
          allClear
            ? "Validierung: Alle Prüfungen bestanden"
            : `${errorCount} Fehler, ${warnCount} Hinweise — klicken für Details`
        }
      >
        <span
          className="inline-block w-2 h-2 rounded-full bg-white"
          aria-hidden
        />
        <span>
          {allClear
            ? "Validierung OK"
            : `${errorCount > 0 ? `${errorCount} Fehler` : ""}${
                errorCount > 0 && warnCount > 0 ? " · " : ""
              }${warnCount > 0 ? `${warnCount} Hinweise` : ""}`}
        </span>
      </button>
    );
  }

  // Grouped by apartment, with an "unassigned" bucket for rooms with no apt
  const grouped: { apartmentId: string | null; issues: ValidationIssue[] }[] = [];
  const byApt = new Map<string | null, ValidationIssue[]>();
  for (const i of issues) {
    const key = i.apartmentId ?? null;
    const arr = byApt.get(key) ?? [];
    arr.push(i);
    byApt.set(key, arr);
  }
  for (const [apartmentId, list] of byApt) {
    grouped.push({ apartmentId, issues: list });
  }
  // Sort: error-first apartments on top
  grouped.sort((a, b) => {
    const aErr = a.issues.some((i) => i.severity === "error") ? 0 : 1;
    const bErr = b.issues.some((i) => i.severity === "error") ? 0 : 1;
    if (aErr !== bErr) return aErr - bErr;
    return b.issues.length - a.issues.length;
  });

  const aptLabel = (apartmentId: string | null) => {
    if (apartmentId === null) return "Nicht zugeordnet";
    const apt = plan.apartments.find((a) => a.id === apartmentId);
    return apt ? `Wohnung ${apt.unit_number} (${apt.apartment_type})` : apartmentId;
  };

  return (
    <div
      className="absolute bottom-2 right-2 w-80 max-h-[60%] bg-white/98 backdrop-blur border rounded-lg shadow-xl text-sm z-20 flex flex-col"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b bg-neutral-50 rounded-t-lg">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${
              allClear
                ? "bg-emerald-500"
                : errorCount > 0
                  ? "bg-rose-500"
                  : "bg-amber-500"
            }`}
          />
          <span className="font-semibold text-neutral-800 text-xs uppercase tracking-wide">
            {allClear
              ? "Validierung"
              : `${errorCount} Fehler · ${warnCount} Hinweise`}
          </span>
        </div>
        <button
          onClick={onToggle}
          className="text-neutral-400 hover:text-neutral-700 leading-none text-lg"
          title="Schließen"
        >
          ×
        </button>
      </div>
      <div className="overflow-y-auto flex-1">
        {allClear ? (
          <div className="px-3 py-4 text-center text-neutral-500 text-xs">
            Alle DIN-Minimalwerte eingehalten, Zusammensetzung schlüssig.
          </div>
        ) : (
          grouped.map(({ apartmentId, issues: aptIssues }) => (
            <div key={apartmentId ?? "_unassigned"} className="border-b last:border-b-0">
              <button
                onClick={() => apartmentId && onFocusApartment(apartmentId)}
                className="w-full px-3 py-1.5 bg-neutral-50 text-left text-[11px] font-semibold text-neutral-600 uppercase tracking-wide hover:bg-neutral-100 transition-colors"
                disabled={!apartmentId}
                title={apartmentId ? "Zur Wohnung springen" : undefined}
              >
                {aptLabel(apartmentId)}
              </button>
              <ul>
                {aptIssues.map((issue, idx) => (
                  <li key={idx}>
                    <button
                      onClick={() => {
                        if (issue.roomId) onFocusRoom(issue.roomId);
                        else if (issue.apartmentId) onFocusApartment(issue.apartmentId);
                      }}
                      className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-amber-50 transition-colors"
                      title={issue.roomId ? "Raum markieren" : "Wohnung auswählen"}
                    >
                      <span
                        className={`mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                          issue.severity === "error" ? "bg-rose-500" : "bg-amber-500"
                        }`}
                      />
                      <span
                        className={`text-xs ${
                          issue.severity === "error"
                            ? "text-rose-800"
                            : "text-amber-800"
                        }`}
                      >
                        {issue.message}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// --- Nearest wall finder (for orienting windows/doors) ---

function findNearestWall2D(
  position: Point2D,
  walls: WallSegment[],
): WallSegment | null {
  let best: WallSegment | null = null;
  let bestDist = Infinity;
  const px = position.x;
  const py = position.y;

  for (const wall of walls) {
    const sx = wall.start.x, sy = wall.start.y;
    const ex = wall.end.x, ey = wall.end.y;
    const dx = ex - sx, dy = ey - sy;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 0.001) continue;

    const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lenSq));
    const projX = sx + t * dx;
    const projY = sy + t * dy;
    const dist = Math.hypot(px - projX, py - projY);
    if (dist < bestDist) {
      bestDist = dist;
      best = wall;
    }
  }
  return best;
}

// --- Drawing helpers ---

function drawRoom(
  ctx: CanvasRenderingContext2D,
  room: FloorPlanRoom,
  tx: (x: number) => number,
  ty: (y: number) => number,
  hoveredAptId: string | null,
  selectedAptId: string | null | undefined,
) {
  if (room.polygon.length < 3) return;

  const isHighlighted = room.apartment_id != null && (
    room.apartment_id === hoveredAptId ||
    room.apartment_id === selectedAptId
  );

  ctx.beginPath();
  room.polygon.forEach((p, i) => {
    if (i === 0) ctx.moveTo(tx(p.x), ty(p.y));
    else ctx.lineTo(tx(p.x), ty(p.y));
  });
  ctx.closePath();

  const baseColor = ROOM_COLORS[room.room_type] || "#f0ebe5";
  ctx.fillStyle = isHighlighted ? adjustBrightness(baseColor, -25) : baseColor;
  ctx.fill();

  // Add architectural patterns for specific room types
  if (room.room_type === "bathroom") {
    drawDiagonalHatch(ctx, room.polygon, tx, ty, 3, "#d9e4f0", 0.3);
  } else if (room.room_type === "corridor") {
    drawCrossHatch(ctx, room.polygon, tx, ty, 3, "#e8e5e0", 0.2);
  }

  ctx.strokeStyle = ROOM_BORDER_COLORS[room.room_type] || "#8b8277";
  ctx.lineWidth = 0.6;
  ctx.stroke();

  // Balconies get a dashed border
  if (room.room_type === "balcony") {
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = "#c4b5a0";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawWall(
  ctx: CanvasRenderingContext2D,
  wall: WallSegment,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
) {
  const startX = tx(wall.start.x);
  const startY = ty(wall.start.y);
  const endX = tx(wall.end.x);
  const endY = ty(wall.end.y);

  // Calculate wall direction and perpendicular
  const dx = endX - startX;
  const dy = endY - startY;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;

  const perpX = -dy / len;
  const perpY = dx / len;

  let wallThickness: number;
  let fillColor: string;
  let strokeColor: string | null = null;
  let pocheHatch = false;

  if (wall.is_bearing) {
    if (wall.is_exterior) {
      // Exterior bearing — solid black (DIN 1356 "tragende Außenwand")
      wallThickness = ts(wall.thickness_m || 0.25);
      fillColor = "#1a1612";
    } else {
      // Interior bearing — dark fill + diagonal poché hatch
      wallThickness = ts(wall.thickness_m || 0.2);
      fillColor = "#2e2822";
      pocheHatch = true;
    }
  } else if (wall.is_exterior) {
    wallThickness = ts(wall.thickness_m || 0.15);
    fillColor = "#4a453f";
  } else {
    // Non-bearing partition — light fill + crisp outline (DIN 1356 "nichttragende Wand")
    wallThickness = ts(wall.thickness_m || 0.08);
    fillColor = "#d4cfc6";
    strokeColor = "#2b2520";
  }

  // Wall rectangle corners
  const offset = wallThickness / 2;
  const c1x = startX + perpX * offset, c1y = startY + perpY * offset;
  const c2x = endX + perpX * offset,   c2y = endY + perpY * offset;
  const c3x = endX - perpX * offset,   c3y = endY - perpY * offset;
  const c4x = startX - perpX * offset, c4y = startY - perpY * offset;

  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.moveTo(c1x, c1y);
  ctx.lineTo(c2x, c2y);
  ctx.lineTo(c3x, c3y);
  ctx.lineTo(c4x, c4y);
  ctx.closePath();
  ctx.fill();

  // Poché hatch overlay for interior bearing walls
  if (pocheHatch) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c1x, c1y);
    ctx.lineTo(c2x, c2y);
    ctx.lineTo(c3x, c3y);
    ctx.lineTo(c4x, c4y);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 0.6;
    const minX = Math.min(c1x, c2x, c3x, c4x);
    const maxX = Math.max(c1x, c2x, c3x, c4x);
    const minY = Math.min(c1y, c2y, c3y, c4y);
    const maxY = Math.max(c1y, c2y, c3y, c4y);
    const step = 4;
    const range = (maxX - minX) + (maxY - minY);
    ctx.beginPath();
    for (let d = -range; d <= range; d += step) {
      ctx.moveTo(minX + d, minY);
      ctx.lineTo(minX + d + (maxY - minY), maxY);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Thin outline for non-bearing partitions
  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(c1x, c1y);
    ctx.lineTo(c2x, c2y);
    ctx.moveTo(c4x, c4y);
    ctx.lineTo(c3x, c3y);
    ctx.stroke();
  }
}

function drawWindow(
  ctx: CanvasRenderingContext2D,
  win: WindowPlacement,
  hostWall: WallSegment | null,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
) {
  const x = tx(win.position.x);
  const y = ty(win.position.y);
  const w = ts(win.width_m);

  // Compute screen-space angle from host wall
  let screenAngle = 0;
  if (hostWall) {
    const sx = tx(hostWall.start.x);
    const sy = ty(hostWall.start.y);
    const ex = tx(hostWall.end.x);
    const ey = ty(hostWall.end.y);
    screenAngle = Math.atan2(ey - sy, ex - sx);
  }

  // Wall-thickness band for window (two parallel face lines with glass in between)
  const wallTh = ts((hostWall?.thickness_m ?? 0.25));
  const halfT = wallTh / 2;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(screenAngle);

  // 1. Erase the wall fill under the opening (so we sit cleanly inside the wall)
  ctx.fillStyle = "#fafaf8";
  ctx.fillRect(-w / 2, -halfT, w, wallTh);

  // 2. Outer + inner wall face lines through the opening (DIN 1356)
  ctx.strokeStyle = "#2b2520";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -halfT);
  ctx.lineTo(w / 2, -halfT);
  ctx.moveTo(-w / 2, halfT);
  ctx.lineTo(w / 2, halfT);
  ctx.stroke();

  // 3. Frame end-caps (jambs)
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -halfT);
  ctx.lineTo(-w / 2, halfT);
  ctx.moveTo(w / 2, -halfT);
  ctx.lineTo(w / 2, halfT);
  ctx.stroke();

  // 4. Glass pane — single centered line along the wall axis
  ctx.strokeStyle = "#4a9fd8";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.lineTo(w / 2, 0);
  ctx.stroke();

  // 5. Sill tick on the interior face (assume interior = positive side)
  ctx.strokeStyle = "#7a7066";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 1, halfT + 1.5);
  ctx.lineTo(w / 2 - 1, halfT + 1.5);
  ctx.stroke();

  ctx.restore();
}

function drawDoor(
  ctx: CanvasRenderingContext2D,
  door: DoorPlacement,
  hostWall: WallSegment | null,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
) {
  const x = tx(door.position.x);
  const y = ty(door.position.y);
  const doorW = ts(door.width_m);

  // Compute screen-space angle from host wall
  let screenAngle = 0;
  if (hostWall) {
    const sx = tx(hostWall.start.x);
    const sy = ty(hostWall.start.y);
    const ex = tx(hostWall.end.x);
    const ey = ty(hostWall.end.y);
    screenAngle = Math.atan2(ey - sy, ex - sx);
  }

  const color = door.is_entrance ? "#c96e28" : "#8b6914";
  const wallTh = ts((hostWall?.thickness_m ?? 0.12));
  const halfT = wallTh / 2;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(screenAngle);

  // 1. Erase the wall fill under the opening so the door doesn't sit on top of hatch
  ctx.fillStyle = "#fafaf8";
  ctx.fillRect(-doorW / 2, -halfT, doorW, wallTh);

  // 2. Jambs (short frame lines at both ends, across wall thickness)
  ctx.strokeStyle = "#2b2520";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-doorW / 2, -halfT);
  ctx.lineTo(-doorW / 2, halfT);
  ctx.moveTo(doorW / 2, -halfT);
  ctx.lineTo(doorW / 2, halfT);
  ctx.stroke();

  // 3. Door leaf at 90° (drawn in the open position, hinged at left jamb)
  //    Leaf swings to the interior side (positive Y in local frame).
  ctx.strokeStyle = color;
  ctx.lineWidth = door.is_entrance ? 2.2 : 1.6;
  ctx.beginPath();
  ctx.moveTo(-doorW / 2, 0);
  ctx.lineTo(-doorW / 2, doorW);
  ctx.stroke();

  // 4. Swing arc — quarter circle from open leaf tip to closed (right jamb)
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(-doorW / 2, 0, doorW, 0, Math.PI / 2, false);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 5. Hinge dot
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(-doorW / 2, 0, 1.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// --- Utility functions ---

function isPointInPolygon(
  px: number, py: number,
  polygon: Point2D[],
  invTx: (x: number) => number,
  invTy: (y: number) => number,
): boolean {
  const pts = polygon.map((p) => [p.x, p.y]);
  let inside = false;
  const planX = invTx(px);
  const planY = invTy(py);

  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if (
      (yi > planY) !== (yj > planY) &&
      planX < ((xj - xi) * (planY - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

/**
 * Edit-mode overlay. Draws:
 *   • a soft emerald band along every draggable partition wall (hint that
 *     the wall is grabbable)
 *   • a brighter emerald band on the hovered wall
 *   • during an active drag: red/green tinted rectangles over the affected
 *     rooms with live area badges (value + DIN-minimum threshold)
 *   • a solid ghost line at the wall's current snapped position
 */
function drawEditOverlay(
  ctx: CanvasRenderingContext2D,
  plan: FloorPlan,
  wallDrag: WallDragState | null,
  hoveredWallId: string | null,
  tx: (x: number) => number,
  ty: (y: number) => number,
) {
  ctx.save();

  // Precompute the set of apt-boundary wall ids so we can colour them
  // differently from plain partitions.
  const aptBoundaryIds = new Set<string>();
  for (const w of plan.walls) {
    if (!w.is_bearing || w.is_exterior) continue;
    if (w.wall_type !== "bearing_cross") continue;
    const dx = Math.abs(w.end.x - w.start.x);
    const dy = Math.abs(w.end.y - w.start.y);
    const axis: "x" | "y" | null =
      dx < 0.01 && dy > 0.01 ? "x" :
      dy < 0.01 && dx > 0.01 ? "y" : null;
    if (!axis) continue;
    const pos = axis === "x" ? (w.start.x + w.end.x) / 2 : (w.start.y + w.end.y) / 2;
    const leftApts = new Set<string>();
    const rightApts = new Set<string>();
    for (const apt of plan.apartments) {
      for (const room of apt.rooms) {
        if (room.polygon.length < 3) continue;
        const alongVals = axis === "x" ? room.polygon.map((p) => p.x) : room.polygon.map((p) => p.y);
        const aMin = Math.min(...alongVals), aMax = Math.max(...alongVals);
        if (Math.abs(aMax - pos) < VERTEX_MATCH_TOL) leftApts.add(apt.id);
        if (Math.abs(aMin - pos) < VERTEX_MATCH_TOL) rightApts.add(apt.id);
      }
    }
    const overlap = [...leftApts].some((id) => rightApts.has(id));
    if (!overlap && leftApts.size > 0 && rightApts.size > 0) aptBoundaryIds.add(w.id);
  }

  // Highlight all draggable walls — partitions in emerald, apt boundaries
  // in amber (user reads: thick amber = rearrange apartments)
  for (const wall of plan.walls) {
    const isPartition =
      !wall.is_bearing && !wall.is_exterior && wall.wall_type === "partition";
    const isAptBoundary = aptBoundaryIds.has(wall.id);
    if (!isPartition && !isAptBoundary) continue;

    const sx = tx(wall.start.x), sy = ty(wall.start.y);
    const ex = tx(wall.end.x),   ey = ty(wall.end.y);
    const isHover = wall.id === hoveredWallId;
    const isDragging = wallDrag?.affectedWallIds.includes(wall.id) ?? false;

    // Colour palette: emerald for partitions, amber for apt boundaries
    const palette = isAptBoundary
      ? { base: "#f59e0b66", hover: "#f59e0b", active: "#b45309" }
      : { base: "#10b98166", hover: "#10b981", active: "#059669" };
    const stroke = isDragging ? palette.active : isHover ? palette.hover : palette.base;

    ctx.strokeStyle = stroke;
    ctx.lineWidth = isHover || isDragging ? 3 : 2;
    ctx.setLineDash(isDragging ? [] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Active drag preview — tint affected rooms + show area badges
  if (wallDrag) {
    const affected = new Set(wallDrag.affectedRoomIds);
    const tint = wallDrag.valid ? "rgba(16,185,129,0.18)" : "rgba(220,38,38,0.22)";
    const stroke = wallDrag.valid ? "#059669" : "#dc2626";

    for (const room of plan.rooms) {
      if (!affected.has(room.id)) continue;
      if (room.polygon.length < 3) continue;

      ctx.fillStyle = tint;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      room.polygon.forEach((p, i) => {
        if (i === 0) ctx.moveTo(tx(p.x), ty(p.y));
        else ctx.lineTo(tx(p.x), ty(p.y));
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Area badge centered on the room
      const cx = room.polygon.reduce((a, p) => a + p.x, 0) / room.polygon.length;
      const cy = room.polygon.reduce((a, p) => a + p.y, 0) / room.polygon.length;
      const minArea = MIN_ROOM_AREA_SQM[room.room_type] ?? 0;
      const ok = room.area_sqm >= minArea - 0.001;
      const text = `${room.area_sqm.toFixed(1)} m² ${ok ? "✓" : `< ${minArea.toFixed(1)}`}`;

      ctx.font = "bold 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const metrics = ctx.measureText(text);
      const padX = 6;
      const boxW = metrics.width + 2 * padX;
      const boxH = 18;
      const boxX = tx(cx) - boxW / 2;
      const boxY = ty(cy) - boxH / 2;

      ctx.fillStyle = ok ? "#059669" : "#dc2626";
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, tx(cx), ty(cy) + 1);
    }

    // Ghost line along every wall in the drag group (for apt-boundary
    // drags this draws both the south-of-corridor and north-of-corridor
    // segments so the user sees the whole boundary sweeping together).
    const groupSet = new Set(wallDrag.affectedWallIds);
    const groupWalls = plan.walls.filter((w) => groupSet.has(w.id));
    for (const w of groupWalls) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(tx(w.start.x), ty(w.start.y));
      ctx.lineTo(tx(w.end.x), ty(w.end.y));
      ctx.stroke();
    }

    // Label — Δm and, on failure, the reason
    const primary = groupWalls[0] ?? plan.walls.find((w) => w.id === wallDrag.wallId);
    if (primary) {
      const mx = (primary.start.x + primary.end.x) / 2;
      const my = (primary.start.y + primary.end.y) / 2;
      const delta = wallDrag.current - wallDrag.original;
      const sign = delta > 0 ? "+" : "";
      const kindTag = wallDrag.kind === "apt_boundary" ? "Apt-Grenze" : "Trennwand";
      const base = `${kindTag}  ${sign}${delta.toFixed(3)} m`;
      const label = !wallDrag.valid && wallDrag.invalidReason
        ? `${base}  ✗ ${wallDrag.invalidReason}`
        : base;
      ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = stroke;
      const lm = ctx.measureText(label);
      const lbx = tx(mx) - lm.width / 2 - 4;
      const lby = ty(my) - 9;
      ctx.fillRect(lbx, lby, lm.width + 8, 18);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, tx(mx), ty(my));
    }
  }

  ctx.restore();
}

/**
 * Pure version of opening-drag application (Phase 3.6c). Takes a base
 * FloorPlan and produces a new one with the opening's position and/or width
 * updated, plus a validity flag and reason string.
 *
 * The semantics depend on `drag.mode`:
 *  - "move": newCenter = clamp(snap(alongCursor), …); width unchanged
 *  - "resize_right": right edge follows the cursor; width = 2 *
 *    (newRightEdge - originalCenter). The opening stays centred on its
 *    original center while one side grows.
 *  - "resize_left": mirror of resize_right for the left edge.
 *
 * Validation:
 *  - Opening extent [center - w/2, center + w/2] must fit inside
 *    [wallMin + MIN_OPENING_EDGE_M, wallMax - MIN_OPENING_EDGE_M].
 *  - Window width clamped to [MIN_WINDOW_WIDTH_M, MAX_WINDOW_WIDTH_M].
 *  - Opening must not overlap any `forbidden` interval.
 */
function applyOpeningDragOnPlan(
  basePlan: FloorPlan,
  drag: OpeningDragState,
  alongCursor: number,
  snap: (v: number) => number,
): {
  plan: FloorPlan;
  currentPos: number;
  currentWidth: number;
  valid: boolean;
  invalidReason?: string;
} {
  let currentPos = drag.originalPos;
  let currentWidth = drag.originalWidth;

  const innerMin = drag.wallMin + MIN_OPENING_EDGE_M;
  const innerMax = drag.wallMax - MIN_OPENING_EDGE_M;

  if (drag.mode === "move") {
    const half = currentWidth / 2;
    const lo = innerMin + half;
    const hi = innerMax - half;
    const snapped = snap(alongCursor);
    currentPos = Math.max(lo, Math.min(hi, snapped));
  } else {
    // Resize — hold originalPos fixed, move one edge to follow the cursor.
    const snapped = snap(alongCursor);
    const center = drag.originalPos;
    let halfWidth: number;
    if (drag.mode === "resize_right") {
      halfWidth = snapped - center;
    } else {
      halfWidth = center - snapped;
    }
    // Clamp half-width so the opening stays within wall interior + width range
    const maxHalf = Math.min(center - innerMin, innerMax - center, MAX_WINDOW_WIDTH_M / 2);
    const minHalf = MIN_WINDOW_WIDTH_M / 2;
    halfWidth = Math.max(minHalf, Math.min(maxHalf, halfWidth));
    currentPos = center;
    currentWidth = halfWidth * 2;
  }

  // Validate against forbidden intervals from other openings.
  let valid = true;
  let invalidReason: string | undefined;
  const half = currentWidth / 2;
  const openLo = currentPos - half;
  const openHi = currentPos + half;
  for (const [fLo, fHi] of drag.forbidden) {
    // Overlap if intervals intersect
    if (openHi > fLo && openLo < fHi) {
      valid = false;
      invalidReason = "Kollision mit anderer Öffnung";
      break;
    }
  }
  if (valid && (openLo < innerMin - 0.001 || openHi > innerMax + 0.001)) {
    valid = false;
    invalidReason = "Zu nah am Wandende";
  }
  if (valid && drag.kind === "window") {
    if (currentWidth < MIN_WINDOW_WIDTH_M - 0.001) {
      valid = false;
      invalidReason = `Breite < ${MIN_WINDOW_WIDTH_M.toFixed(2)} m`;
    } else if (currentWidth > MAX_WINDOW_WIDTH_M + 0.001) {
      valid = false;
      invalidReason = `Breite > ${MAX_WINDOW_WIDTH_M.toFixed(2)} m`;
    }
  }

  // Apply to the plan
  const newPosPoint: Point2D =
    drag.axis === "x"
      ? { x: currentPos, y: basePlanOpeningPerp(basePlan, drag) }
      : { x: basePlanOpeningPerp(basePlan, drag), y: currentPos };

  let nextPlan: FloorPlan = basePlan;
  if (drag.kind === "window") {
    nextPlan = {
      ...basePlan,
      windows: basePlan.windows.map((w) =>
        w.id === drag.id
          ? { ...w, position: newPosPoint, width_m: currentWidth }
          : w,
      ),
    };
  } else {
    nextPlan = {
      ...basePlan,
      doors: basePlan.doors.map((d) =>
        d.id === drag.id
          ? { ...d, position: newPosPoint, width_m: currentWidth }
          : d,
      ),
    };
  }

  return { plan: nextPlan, currentPos, currentWidth, valid, invalidReason };
}

/** Generate a UUID. Uses `crypto.randomUUID()` where supported (all modern
 *  browsers + Node 19+) and falls back to a decent pseudorandom string so
 *  headless/test environments don't crash. Good enough for client-side
 *  IDs — the backend never sees these until a save round-trip. */
function genUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Place a NEW opening (door or window) on the plan at the clicked point
 * (Phase 3.6c add). The click is projected onto the nearest valid host
 * wall; the placement is validated against the standard opening rules
 * (min edge distance, gap from other openings on the same wall, window
 * width range). Windows additionally require an exterior wall (DIN 5034
 * natural-light convention).
 *
 * Returns the next plan + validity + optional reason. An invalid
 * placement leaves the plan unchanged (callers shouldn't commit).
 */
function applyNewOpeningOnPlan(
  basePlan: FloorPlan,
  kind: OpeningKind,
  planX: number,
  planY: number,
  snap: (v: number) => number,
): { plan: FloorPlan; valid: boolean; invalidReason?: string; newId?: string } {
  const hostWall = findNearestWall2D({ x: planX, y: planY } as Point2D, basePlan.walls);
  if (!hostWall) return { plan: basePlan, valid: false, invalidReason: "Keine Wand in der Nähe" };

  // Axis classification (inline — same logic as classifyHostWall but
  // pure/outside a hook).
  const dx = Math.abs(hostWall.end.x - hostWall.start.x);
  const dy = Math.abs(hostWall.end.y - hostWall.start.y);
  const AXIS_TOL = 0.01;
  let axis: WallAxis;
  let wallMin: number;
  let wallMax: number;
  let perpCoord: number;
  if (dy < AXIS_TOL && dx > AXIS_TOL) {
    axis = "x";
    wallMin = Math.min(hostWall.start.x, hostWall.end.x);
    wallMax = Math.max(hostWall.start.x, hostWall.end.x);
    perpCoord = hostWall.start.y;
  } else if (dx < AXIS_TOL && dy > AXIS_TOL) {
    axis = "y";
    wallMin = Math.min(hostWall.start.y, hostWall.end.y);
    wallMax = Math.max(hostWall.start.y, hostWall.end.y);
    perpCoord = hostWall.start.x;
  } else {
    return { plan: basePlan, valid: false, invalidReason: "Wand nicht achsparallel" };
  }

  // Windows only on exterior walls (natural-light requirement). Doors can
  // go on any wall — entrance doors on exterior, interior doors on partitions.
  if (kind === "window" && !hostWall.is_exterior) {
    return { plan: basePlan, valid: false, invalidReason: "Fenster nur an Außenwänden" };
  }

  const alongCursor = axis === "x" ? planX : planY;
  const width = kind === "window" ? DEFAULT_WINDOW_WIDTH_M : DEFAULT_DOOR_WIDTH_M;
  const half = width / 2;
  const innerMin = wallMin + MIN_OPENING_EDGE_M;
  const innerMax = wallMax - MIN_OPENING_EDGE_M;
  if (innerMax - innerMin < width) {
    return { plan: basePlan, valid: false, invalidReason: "Wand zu kurz" };
  }
  const lo = innerMin + half;
  const hi = innerMax - half;
  const centerRaw = Math.max(lo, Math.min(hi, snap(alongCursor)));

  // Collect forbidden intervals from other openings on the same wall.
  const forbidden: Array<[number, number]> = [];
  for (const d of basePlan.doors) {
    if (d.wall_id !== hostWall.id) continue;
    const c = axis === "x" ? d.position.x : d.position.y;
    forbidden.push([
      c - d.width_m / 2 - MIN_OPENING_GAP_M,
      c + d.width_m / 2 + MIN_OPENING_GAP_M,
    ]);
  }
  for (const w of basePlan.windows) {
    if (w.wall_id !== hostWall.id) continue;
    const c = axis === "x" ? w.position.x : w.position.y;
    forbidden.push([
      c - w.width_m / 2 - MIN_OPENING_GAP_M,
      c + w.width_m / 2 + MIN_OPENING_GAP_M,
    ]);
  }
  const openLo = centerRaw - half;
  const openHi = centerRaw + half;
  for (const [fLo, fHi] of forbidden) {
    if (openHi > fLo && openLo < fHi) {
      return { plan: basePlan, valid: false, invalidReason: "Kollision mit anderer Öffnung" };
    }
  }

  const position: Point2D =
    axis === "x"
      ? { x: centerRaw, y: perpCoord }
      : { x: perpCoord, y: centerRaw };
  const newId = genUuid();

  if (kind === "window") {
    const window: WindowPlacement = {
      id: newId,
      position,
      wall_id: hostWall.id,
      width_m: width,
      height_m: DEFAULT_WINDOW_HEIGHT_M,
      sill_height_m: DEFAULT_WINDOW_SILL_M,
      is_floor_to_ceiling: false,
    };
    return {
      plan: { ...basePlan, windows: [...basePlan.windows, window] },
      valid: true,
      newId,
    };
  } else {
    const door: DoorPlacement = {
      id: newId,
      position,
      wall_id: hostWall.id,
      width_m: width,
      height_m: DEFAULT_DOOR_HEIGHT_M,
      is_entrance: hostWall.is_exterior,
      swing_direction: "inward",
    };
    return {
      plan: { ...basePlan, doors: [...basePlan.doors, door] },
      valid: true,
      newId,
    };
  }
}

/** Helper: look up the opening's perpendicular coordinate from the base
 *  plan (the along-axis coord is being updated by the drag). */
function basePlanOpeningPerp(plan: FloorPlan, drag: OpeningDragState): number {
  const src =
    drag.kind === "window"
      ? plan.windows.find((w) => w.id === drag.id)
      : plan.doors.find((d) => d.id === drag.id);
  if (!src) return 0;
  return drag.axis === "x" ? src.position.y : src.position.x;
}

/**
 * Opening-edit overlay (Phase 3.6c). Renders:
 *  - a soft sky-blue halo around every opening (hint that they're grabbable)
 *  - a brighter halo on the hovered opening
 *  - a selection ring (amber) around the selected opening
 *  - for selected windows: two circular resize handles at the opening edges
 *  - during an active drag: invalid/valid tint + reason label
 */
function drawOpeningEditOverlay(
  ctx: CanvasRenderingContext2D,
  plan: FloorPlan,
  openingDrag: OpeningDragState | null,
  hoveredOpening: { kind: OpeningKind; id: string } | null,
  selectedOpening: { kind: OpeningKind; id: string } | null,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
) {
  ctx.save();

  const drawHalo = (
    center: Point2D,
    widthM: number,
    hostWall: WallSegment,
    color: string,
    lineWidth: number,
    dashed: boolean,
  ) => {
    const sx = tx(hostWall.start.x);
    const sy = ty(hostWall.start.y);
    const ex = tx(hostWall.end.x);
    const ey = ty(hostWall.end.y);
    const angle = Math.atan2(ey - sy, ex - sx);
    const cx = tx(center.x);
    const cy = ty(center.y);
    const w = ts(widthM);
    const wallTh = ts((hostWall.thickness_m ?? 0.2));
    const h = wallTh + 6;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashed ? [3, 3] : []);
    ctx.strokeRect(-w / 2 - 2, -h / 2, w + 4, h);
    ctx.setLineDash([]);
    ctx.restore();
  };

  const allOpenings: Array<
    { kind: OpeningKind; id: string; position: Point2D; width_m: number }
  > = [
    ...plan.windows.map((w) => ({ kind: "window" as OpeningKind, id: w.id, position: w.position, width_m: w.width_m })),
    ...plan.doors.map((d) => ({ kind: "door" as OpeningKind, id: d.id, position: d.position, width_m: d.width_m })),
  ];

  // 1. Soft base halo on every opening (always visible in edit mode)
  for (const op of allOpenings) {
    const host = findNearestWall2D(op.position, plan.walls);
    if (!host) continue;
    const isHover = hoveredOpening?.kind === op.kind && hoveredOpening?.id === op.id;
    const isSel = selectedOpening?.kind === op.kind && selectedOpening?.id === op.id;
    const isDrag = openingDrag?.kind === op.kind && openingDrag?.id === op.id;
    if (isSel || isDrag) continue;   // drawn later with stronger style
    drawHalo(
      op.position,
      op.width_m,
      host,
      isHover ? "#0ea5e9" : "#0ea5e966",
      isHover ? 2 : 1.2,
      true,
    );
  }

  // 2. Selected opening — amber ring
  if (selectedOpening && (!openingDrag || openingDrag.id !== selectedOpening.id)) {
    const list = selectedOpening.kind === "window" ? plan.windows : plan.doors;
    const sel = list.find((o) => o.id === selectedOpening.id);
    if (sel) {
      const host = findNearestWall2D(sel.position, plan.walls);
      if (host) {
        drawHalo(sel.position, sel.width_m, host, "#f59e0b", 2.4, false);
        // Resize handles (windows only)
        if (selectedOpening.kind === "window") {
          drawResizeHandles(ctx, sel.position, sel.width_m, host, tx, ty);
        }
      }
    }
  }

  // 3. Active drag — valid green / invalid red ghost + reason label
  if (openingDrag) {
    const list = openingDrag.kind === "window" ? plan.windows : plan.doors;
    const op = list.find((o) => o.id === openingDrag.id);
    if (op) {
      const host = plan.walls.find((w) => w.id === openingDrag.hostWallId)
        ?? findNearestWall2D(op.position, plan.walls);
      if (host) {
        const color = openingDrag.valid ? "#059669" : "#dc2626";
        drawHalo(op.position, op.width_m, host, color, 2.6, false);
        if (openingDrag.kind === "window") {
          drawResizeHandles(ctx, op.position, op.width_m, host, tx, ty);
        }

        // Reason label above the opening
        const kindTag = openingDrag.kind === "window" ? "Fenster" : "Tür";
        const modeTag =
          openingDrag.mode === "move"
            ? "verschieben"
            : "Breite ändern";
        const delta = openingDrag.currentPos - openingDrag.originalPos;
        const sign = delta > 0 ? "+" : "";
        const dims =
          openingDrag.mode === "move"
            ? `${sign}${delta.toFixed(3)} m`
            : `${openingDrag.currentWidth.toFixed(2)} m`;
        const base = `${kindTag} ${modeTag}  ${dims}`;
        const label =
          !openingDrag.valid && openingDrag.invalidReason
            ? `${base}  ✗ ${openingDrag.invalidReason}`
            : base;
        ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lm = ctx.measureText(label);
        const lbx = tx(op.position.x) - lm.width / 2 - 4;
        const lby = ty(op.position.y) - 22;
        ctx.fillStyle = color;
        ctx.fillRect(lbx, lby, lm.width + 8, 18);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, tx(op.position.x), lby + 9);
      }
    }
  }

  // Hint for empty selection — "Click an opening" (only if nothing selected)
  if (!selectedOpening && !openingDrag) {
    ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#0369a1";
    ctx.fillText(
      "Öffnungen bearbeiten — anklicken, ziehen, Breite mit Handles ändern, Entf zum Löschen",
      12,
      38,
    );
  }

  ctx.restore();
}

/** Draw two circular resize handles at the along-axis edges of a window. */
function drawResizeHandles(
  ctx: CanvasRenderingContext2D,
  center: Point2D,
  widthM: number,
  hostWall: WallSegment,
  tx: (x: number) => number,
  ty: (y: number) => number,
) {
  const dx = hostWall.end.x - hostWall.start.x;
  const dy = hostWall.end.y - hostWall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const half = widthM / 2;
  const leftPlan: Point2D = { x: center.x - ux * half, y: center.y - uy * half };
  const rightPlan: Point2D = { x: center.x + ux * half, y: center.y + uy * half };
  for (const p of [leftPlan, rightPlan]) {
    ctx.fillStyle = "#f59e0b";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(tx(p.x), ty(p.y), RESIZE_HANDLE_RADIUS_PX, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// ── Room reassignment helpers (Phase 3.6d) ────────────────────────────────

/** Hit-test: screen-space click → innermost containing room (if any). */
function findRoomAtClick(
  plan: FloorPlan,
  screenX: number,
  screenY: number,
  invTx: (x: number) => number,
  invTy: (y: number) => number,
): FloorPlanRoom | null {
  let hit: FloorPlanRoom | null = null;
  let smallest = Infinity;
  for (const r of plan.rooms) {
    if (r.polygon.length < 3) continue;
    if (!isPointInPolygon(screenX, screenY, r.polygon, invTx, invTy)) continue;
    if (r.area_sqm < smallest) {
      smallest = r.area_sqm;
      hit = r;
    }
  }
  return hit;
}

/** A room is reassignable iff its current type appears in the allow-list
 *  (excludes balcony / corridor / staircase / elevator / shaft). */
function isRoomReassignable(room: FloorPlanRoom): boolean {
  return (REASSIGNABLE_ROOM_TYPES as readonly string[]).includes(room.room_type);
}

/**
 * Pure application of a room type change. Returns a new plan with:
 *   - room.room_type = newType
 *   - room.label regenerated to match the new type, re-numbering bedrooms
 *     inside the owning apartment (Bedroom, Bedroom 1, Bedroom 2, …)
 *   - apartment.apartment_type recomputed from the edited room mix
 */
function applyRoomTypeChangeOnPlan(
  basePlan: FloorPlan,
  roomId: string,
  newType: (typeof REASSIGNABLE_ROOM_TYPES)[number],
): FloorPlan {
  // 1. Update room_type + provisional label on the raw rooms list
  const target = basePlan.rooms.find((r) => r.id === roomId);
  if (!target) return basePlan;

  const updateRoom = (r: FloorPlanRoom): FloorPlanRoom =>
    r.id === roomId ? { ...r, room_type: newType, label: defaultLabelFor(newType) } : r;

  const roomsNext = basePlan.rooms.map(updateRoom);
  const apartmentsNext = basePlan.apartments.map((apt) => {
    const aptRoomsUpdated = apt.rooms.map(updateRoom);
    // Re-number bedrooms inside this apartment for deterministic labels
    const bedrooms = aptRoomsUpdated.filter((r) => r.room_type === "bedroom");
    // Sort bedrooms left-to-right along their centroid X so numbering is stable
    const bedroomOrder = [...bedrooms].sort((a, b) => {
      const ax = a.polygon.reduce((s, p) => s + p.x, 0) / Math.max(a.polygon.length, 1);
      const bx = b.polygon.reduce((s, p) => s + p.x, 0) / Math.max(b.polygon.length, 1);
      return ax - bx;
    });
    const bedIndex = new Map<string, number>();
    bedroomOrder.forEach((b, i) => bedIndex.set(b.id, i + 1));
    const relabeled = aptRoomsUpdated.map((r) => {
      if (r.room_type !== "bedroom") return r;
      const idx = bedIndex.get(r.id) ?? 1;
      const label = bedrooms.length > 1 ? `Bedroom ${idx}` : "Bedroom";
      return { ...r, label };
    });
    // Recompute apartment_type from the new bedroom count (+1 for Wohnküche)
    const bedroomCount = relabeled.filter((r) => r.room_type === "bedroom").length;
    const hasLiving = relabeled.some((r) => r.room_type === "living");
    const zimmerCount = Math.max(1, Math.min(5, bedroomCount + (hasLiving ? 1 : 0)));
    const apartment_type = `${zimmerCount}_room`;
    return { ...apt, rooms: relabeled, apartment_type };
  });

  // Mirror the per-apartment renumbering onto the flat rooms list so the
  // viewer's label rendering (which reads from `plan.rooms`) stays in sync.
  const relabelMap = new Map<string, string>();
  for (const apt of apartmentsNext) {
    for (const r of apt.rooms) relabelMap.set(r.id, r.label);
  }
  const roomsNextLabeled = roomsNext.map((r) =>
    relabelMap.has(r.id) ? { ...r, label: relabelMap.get(r.id)! } : r,
  );

  return { ...basePlan, rooms: roomsNextLabeled, apartments: apartmentsNext };
}

// ── Topology-changing room operations (Phase 3.6d add) ───────────────────

/** Area slack beyond the sum of DIN minimums required before a split is
 *  offered — prevents creating rooms that are exactly at min and can't be
 *  adjusted later. 14m² (living) + 4m² (kitchen) + 2m² slack = 20m². */
const MIN_WOHNKUECHE_SPLIT_AREA_SQM = 20.0;
/** Kitchen portion of the split, 0–1 along the longer axis. 0.30 is
 *  a typical German Wohnküche ratio. */
const WOHNKUECHE_SPLIT_KITCHEN_FRAC = 0.30;
/** Tolerance (m) for two polygon edges to be considered "shared". */
const SHARED_EDGE_TOL = 0.05;

/**
 * Split a living room into a living room + a new kitchen along its longer
 * axis. The room's polygon must be an axis-aligned rectangle (always true
 * for the Goldbeck generator output). Inserts a new partition wall along
 * the split line and updates the owning apartment's `apartment_type` to
 * reflect the added kitchen.
 *
 * Returns the next plan or `null` if the operation isn't valid (room not
 * found, not a rectangle, too small, etc.) — callers should not commit.
 */
function applyWohnkuecheSplit(basePlan: FloorPlan, roomId: string): FloorPlan | null {
  const target = basePlan.rooms.find((r) => r.id === roomId);
  if (!target || target.room_type !== "living") return null;
  if (target.polygon.length !== 4) return null;
  if (target.area_sqm < MIN_WOHNKUECHE_SPLIT_AREA_SQM) return null;

  const xs = target.polygon.map((p) => p.x);
  const ys = target.polygon.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX;
  const h = maxY - minY;
  // Abort if not axis-aligned rectangle (vertices not at the four corners)
  const tol = 0.01;
  const isRect = target.polygon.every(
    (p) =>
      (Math.abs(p.x - minX) < tol || Math.abs(p.x - maxX) < tol) &&
      (Math.abs(p.y - minY) < tol || Math.abs(p.y - maxY) < tol),
  );
  if (!isRect) return null;

  // Find the owning apartment
  const owningApt = basePlan.apartments.find((a) =>
    a.rooms.some((r) => r.id === roomId),
  );
  if (!owningApt) return null;

  // Split along the longer dimension. Living keeps the larger portion,
  // kitchen takes WOHNKUECHE_SPLIT_KITCHEN_FRAC of the longer axis.
  let livingPoly: Point2D[];
  let kitchenPoly: Point2D[];
  let wallStart: Point2D;
  let wallEnd: Point2D;
  const livingFrac = 1 - WOHNKUECHE_SPLIT_KITCHEN_FRAC;
  if (w >= h) {
    const splitX = minX + w * livingFrac;
    livingPoly = [
      { x: minX, y: minY },
      { x: splitX, y: minY },
      { x: splitX, y: maxY },
      { x: minX, y: maxY },
    ];
    kitchenPoly = [
      { x: splitX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: splitX, y: maxY },
    ];
    wallStart = { x: splitX, y: minY };
    wallEnd = { x: splitX, y: maxY };
  } else {
    const splitY = minY + h * livingFrac;
    livingPoly = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: splitY },
      { x: minX, y: splitY },
    ];
    kitchenPoly = [
      { x: minX, y: splitY },
      { x: maxX, y: splitY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
    wallStart = { x: minX, y: splitY };
    wallEnd = { x: maxX, y: splitY };
  }

  const livingArea = polygonArea(livingPoly);
  const kitchenArea = polygonArea(kitchenPoly);
  const minLiving = MIN_ROOM_AREA_SQM.living ?? 14;
  const minKitchen = MIN_ROOM_AREA_SQM.kitchen ?? 4;
  if (livingArea < minLiving || kitchenArea < minKitchen) return null;

  const newKitchenId = genUuid();
  const newWallId = genUuid();

  const updatedLiving: FloorPlanRoom = {
    ...target,
    polygon: livingPoly,
    area_sqm: livingArea,
    label: target.label?.includes("Wohnküche") ? "Living" : target.label,
  };
  const newKitchen: FloorPlanRoom = {
    ...target,
    id: newKitchenId,
    room_type: "kitchen",
    label: "Kitchen",
    polygon: kitchenPoly,
    area_sqm: kitchenArea,
    // Keep apartment_id so it stays attached
  };

  const newWall: WallSegment = {
    id: newWallId,
    start: wallStart,
    end: wallEnd,
    wall_type: "partition",
    thickness_m: 0.115, // standard non-bearing gypsum partition
    is_bearing: false,
    is_exterior: false,
  };

  // Update flat rooms list
  const roomsNext = basePlan.rooms
    .map((r) => (r.id === roomId ? updatedLiving : r))
    .concat([newKitchen]);

  // Update the owning apartment's rooms + apartment_type (adds a kitchen,
  // so zimmerCount grows by 1 vs the previous declared value).
  const apartmentsNext = basePlan.apartments.map((apt) => {
    if (apt.id !== owningApt.id) return apt;
    const aptRooms = apt.rooms
      .map((r) => (r.id === roomId ? updatedLiving : r))
      .concat([newKitchen]);
    const bedroomCount = aptRooms.filter((r) => r.room_type === "bedroom").length;
    const hasLiving = aptRooms.some((r) => r.room_type === "living");
    const zimmerCount = Math.max(1, Math.min(5, bedroomCount + (hasLiving ? 1 : 0)));
    return { ...apt, rooms: aptRooms, apartment_type: `${zimmerCount}_room` };
  });

  return {
    ...basePlan,
    rooms: roomsNext,
    apartments: apartmentsNext,
    walls: [...basePlan.walls, newWall],
  };
}

/**
 * Merge an adjacent kitchen into a living room, producing a single
 * Wohnküche. Removes the shared partition wall + any openings on it.
 * Returns the next plan or `null` if no valid merge candidate exists.
 */
function applyKitchenMerge(basePlan: FloorPlan, livingRoomId: string): FloorPlan | null {
  const living = basePlan.rooms.find((r) => r.id === livingRoomId);
  if (!living || living.room_type !== "living") return null;
  if (living.polygon.length !== 4) return null;

  const owningApt = basePlan.apartments.find((a) =>
    a.rooms.some((r) => r.id === livingRoomId),
  );
  if (!owningApt) return null;

  // Find kitchen in the same apartment that shares a full edge with living
  const kitchens = owningApt.rooms.filter(
    (r) => r.room_type === "kitchen" && r.polygon.length === 4,
  );
  let kitchen: FloorPlanRoom | null = null;
  let sharedAxis: "x" | "y" | null = null;
  let sharedCoord: number | null = null;
  for (const k of kitchens) {
    const m = findSharedEdge(living.polygon, k.polygon);
    if (m) {
      kitchen = k;
      sharedAxis = m.axis;
      sharedCoord = m.coord;
      break;
    }
  }
  if (!kitchen || sharedAxis === null || sharedCoord === null) return null;

  // Union of both rectangles (they share a full edge → union is the bbox
  // of all 8 corners).
  const allPts = [...living.polygon, ...kitchen.polygon];
  const xs = allPts.map((p) => p.x);
  const ys = allPts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const mergedPoly: Point2D[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];

  const updatedLiving: FloorPlanRoom = {
    ...living,
    polygon: mergedPoly,
    area_sqm: polygonArea(mergedPoly),
    label: "Wohnküche",
  };

  // Find the shared wall: an axis-aligned wall whose axis coord equals
  // the shared coord and whose extent overlaps the shared-edge range.
  const axisTol = 0.01;
  const sharedWallIds = new Set<string>();
  for (const wall of basePlan.walls) {
    const dx = Math.abs(wall.end.x - wall.start.x);
    const dy = Math.abs(wall.end.y - wall.start.y);
    if (sharedAxis === "x") {
      // Shared edge is vertical (x = sharedCoord); wall must be vertical
      if (dx < axisTol && dy > axisTol) {
        if (
          Math.abs(wall.start.x - sharedCoord) < axisTol &&
          Math.abs(wall.end.x - sharedCoord) < axisTol
        ) {
          sharedWallIds.add(wall.id);
        }
      }
    } else {
      // Shared edge is horizontal (y = sharedCoord); wall must be horizontal
      if (dy < axisTol && dx > axisTol) {
        if (
          Math.abs(wall.start.y - sharedCoord) < axisTol &&
          Math.abs(wall.end.y - sharedCoord) < axisTol
        ) {
          sharedWallIds.add(wall.id);
        }
      }
    }
  }

  // Drop the kitchen from rooms + apartment, update living, remove shared
  // walls, and drop any openings on those walls.
  const roomsNext = basePlan.rooms
    .filter((r) => r.id !== kitchen!.id)
    .map((r) => (r.id === livingRoomId ? updatedLiving : r));

  const apartmentsNext = basePlan.apartments.map((apt) => {
    if (apt.id !== owningApt.id) return apt;
    const aptRooms = apt.rooms
      .filter((r) => r.id !== kitchen!.id)
      .map((r) => (r.id === livingRoomId ? updatedLiving : r));
    const bedroomCount = aptRooms.filter((r) => r.room_type === "bedroom").length;
    const hasLiving = aptRooms.some((r) => r.room_type === "living");
    const zimmerCount = Math.max(1, Math.min(5, bedroomCount + (hasLiving ? 1 : 0)));
    return { ...apt, rooms: aptRooms, apartment_type: `${zimmerCount}_room` };
  });

  const wallsNext = basePlan.walls.filter((w) => !sharedWallIds.has(w.id));
  const doorsNext = basePlan.doors.filter((d) => !sharedWallIds.has(d.wall_id));
  const windowsNext = basePlan.windows.filter((w) => !sharedWallIds.has(w.wall_id));

  return {
    ...basePlan,
    rooms: roomsNext,
    apartments: apartmentsNext,
    walls: wallsNext,
    doors: doorsNext,
    windows: windowsNext,
  };
}

/**
 * Return the shared edge of two axis-aligned rectangles if one exists.
 * An edge is "shared" if both rectangles touch the same coordinate
 * along an axis AND their extents overlap along the perpendicular axis
 * for at least 1.0m. Returns `null` if they don't share an edge.
 */
function findSharedEdge(
  polyA: Point2D[],
  polyB: Point2D[],
): { axis: "x" | "y"; coord: number } | null {
  if (polyA.length !== 4 || polyB.length !== 4) return null;
  const ax = polyA.map((p) => p.x);
  const ay = polyA.map((p) => p.y);
  const bx = polyB.map((p) => p.x);
  const by = polyB.map((p) => p.y);
  const aMinX = Math.min(...ax), aMaxX = Math.max(...ax);
  const aMinY = Math.min(...ay), aMaxY = Math.max(...ay);
  const bMinX = Math.min(...bx), bMaxX = Math.max(...bx);
  const bMinY = Math.min(...by), bMaxY = Math.max(...by);

  // Vertical shared edge (x = common coord)
  const yOverlap = Math.max(0, Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY));
  if (yOverlap > 1.0) {
    if (Math.abs(aMaxX - bMinX) < SHARED_EDGE_TOL) return { axis: "x", coord: aMaxX };
    if (Math.abs(aMinX - bMaxX) < SHARED_EDGE_TOL) return { axis: "x", coord: aMinX };
  }
  // Horizontal shared edge (y = common coord)
  const xOverlap = Math.max(0, Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX));
  if (xOverlap > 1.0) {
    if (Math.abs(aMaxY - bMinY) < SHARED_EDGE_TOL) return { axis: "y", coord: aMaxY };
    if (Math.abs(aMinY - bMaxY) < SHARED_EDGE_TOL) return { axis: "y", coord: aMinY };
  }
  return null;
}

/** Default label for a freshly-assigned room type. Bedrooms get renumbered
 *  later by the per-apartment pass; this is just the placeholder. */
function defaultLabelFor(t: (typeof REASSIGNABLE_ROOM_TYPES)[number]): string {
  switch (t) {
    case "living":
      return "Wohnküche";
    case "bedroom":
      return "Bedroom";
    case "kitchen":
      return "Kitchen";
    case "bathroom":
      return "Bathroom";
    case "hallway":
      return "Hallway";
    case "storage":
      return "Storage";
  }
}

/**
 * Room-edit overlay: faint tint on every reassignable room plus a brighter
 * violet outline on hover, and a solid violet outline on the active
 * (popover-anchored) room.
 */
function drawRoomEditOverlay(
  ctx: CanvasRenderingContext2D,
  plan: FloorPlan,
  hoveredRoomId: string | null,
  roomEditor: { roomId: string; screenX: number; screenY: number } | null,
  tx: (x: number) => number,
  ty: (y: number) => number,
) {
  ctx.save();
  for (const room of plan.rooms) {
    if (!isRoomReassignable(room)) continue;
    if (room.polygon.length < 3) continue;
    const isHover = room.id === hoveredRoomId;
    const isActive = roomEditor?.roomId === room.id;

    ctx.beginPath();
    room.polygon.forEach((p, i) => {
      if (i === 0) ctx.moveTo(tx(p.x), ty(p.y));
      else ctx.lineTo(tx(p.x), ty(p.y));
    });
    ctx.closePath();

    if (isActive) {
      ctx.fillStyle = "rgba(139,92,246,0.16)";
      ctx.fill();
      ctx.strokeStyle = "#7c3aed";
      ctx.lineWidth = 2.4;
      ctx.setLineDash([]);
      ctx.stroke();
    } else if (isHover) {
      ctx.fillStyle = "rgba(139,92,246,0.10)";
      ctx.fill();
      ctx.strokeStyle = "#7c3aed";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#7c3aed55";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

// ── Validation (Phase 3.6e) ───────────────────────────────────────────────

/**
 * Runs all live validation rules on a plan and returns a structured result.
 *
 * Rules:
 *   • Room area < DIN minimum (`MIN_ROOM_AREA_SQM`) → error
 *   • Habitable room aspect ratio > `MAX_HABITABLE_ASPECT_RATIO` → warn
 *   • Apartment has no bathroom → error
 *   • Apartment has neither living nor kitchen → error
 *   • Apartment declared `{N}_room` but composition (bedrooms + hasLiving)
 *     disagrees → warn
 */
function validatePlan(
  plan: FloorPlan,
  furnitureByRoom?: Map<string, RoomFurnitureResult>,
  besonnungCtx?: {
    latitude?: number;
    longitude?: number;
    buildingRotationDeg?: number;
  },
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const byRoom = new Map<string, ValidationIssue[]>();
  const byApartment = new Map<string, ValidationIssue[]>();
  const byApartmentAll = new Map<string, ValidationIssue[]>();

  const pushRoomIssue = (
    roomId: string,
    apartmentId: string | undefined,
    issue: Omit<ValidationIssue, "roomId" | "apartmentId">,
  ) => {
    const i: ValidationIssue = { ...issue, roomId, apartmentId };
    issues.push(i);
    const arr = byRoom.get(roomId) ?? [];
    arr.push(i);
    byRoom.set(roomId, arr);
    if (apartmentId) {
      const all = byApartmentAll.get(apartmentId) ?? [];
      all.push(i);
      byApartmentAll.set(apartmentId, all);
    }
  };
  const pushApartmentIssue = (
    apartmentId: string,
    issue: Omit<ValidationIssue, "roomId" | "apartmentId">,
  ) => {
    const i: ValidationIssue = { ...issue, apartmentId };
    issues.push(i);
    const arr = byApartment.get(apartmentId) ?? [];
    arr.push(i);
    byApartment.set(apartmentId, arr);
    const all = byApartmentAll.get(apartmentId) ?? [];
    all.push(i);
    byApartmentAll.set(apartmentId, all);
  };

  // ── Per-room checks ─────────────────────────────────────────────────────
  for (const r of plan.rooms) {
    const minArea = MIN_ROOM_AREA_SQM[r.room_type];
    if (minArea !== undefined && r.area_sqm < minArea) {
      pushRoomIssue(r.id, r.apartment_id, {
        severity: "error",
        code: "area_below_min",
        message: `${r.label || r.room_type}: ${r.area_sqm.toFixed(1)} m² < ${minArea.toFixed(1)} m² (DIN-Minimum)`,
      });
    }

    if (HABITABLE_ROOM_TYPES.includes(r.room_type) && r.polygon.length >= 3) {
      // Axis-aligned bounding box aspect ratio. For the Goldbeck generator's
      // rectangular rooms this is exact; for future irregular polygons it's
      // a conservative proxy.
      const xs = r.polygon.map((p) => p.x);
      const ys = r.polygon.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const w = maxX - minX;
      const h = maxY - minY;
      const short = Math.min(w, h);
      const long = Math.max(w, h);
      if (short > 0) {
        const ratio = long / short;
        if (ratio > MAX_HABITABLE_ASPECT_RATIO) {
          pushRoomIssue(r.id, r.apartment_id, {
            severity: "warn",
            code: "aspect_ratio",
            message: `${r.label || r.room_type}: Seitenverhältnis ${ratio.toFixed(1)}:1 > ${MAX_HABITABLE_ASPECT_RATIO.toFixed(1)}:1 (schwer möblierbar)`,
          });
        }
      }

      // DIN 5034 natural-light check: every habitable room (living, bedroom,
      // kitchen) must have at least one window. Windows sit on the exterior
      // edge of a room's bounding box, so we inflate the bbox by 0.3m (wall
      // thickness slack) and test window centroids against it. Exact for
      // Goldbeck's axis-aligned rectangular rooms; a small false-positive
      // risk for future irregular polygons (acceptable — a false positive
      // raises a visible warning but doesn't block the edit).
      const inflate = 0.3;
      const hasWindow = plan.windows.some(
        (win) =>
          win.position.x >= minX - inflate &&
          win.position.x <= maxX + inflate &&
          win.position.y >= minY - inflate &&
          win.position.y <= maxY + inflate,
      );
      if (!hasWindow) {
        pushRoomIssue(r.id, r.apartment_id, {
          severity: "error",
          code: "no_window",
          message: `${r.label || r.room_type}: kein Fenster (DIN 5034 Tageslicht)`,
        });
      }
    }

    // Phase 4.1 — furnishability warning. Emitted for any furnished room
    // type (living/bedroom/kitchen/bathroom) where the DIN-minimum layout
    // couldn't be placed. Warn (not error) because the room is still legal
    // by area / windows / aspect — just a usability issue.
    if (
      furnitureByRoom &&
      (r.room_type === "living" ||
        r.room_type === "bedroom" ||
        r.room_type === "kitchen" ||
        r.room_type === "bathroom")
    ) {
      const f = furnitureByRoom.get(r.id);
      if (f && !f.fitted) {
        pushRoomIssue(r.id, r.apartment_id, {
          severity: "warn",
          code: "not_furnishable",
          message: `${r.label || r.room_type}: Standard-Möblierung passt nicht${f.reason ? ` — ${f.reason}` : ""}`,
        });
      }
    }
  }

  // ── Per-apartment checks ────────────────────────────────────────────────
  for (const apt of plan.apartments) {
    const types = new Set(apt.rooms.map((r) => r.room_type));
    const bedroomCount = apt.rooms.filter((r) => r.room_type === "bedroom").length;
    const hasLiving = types.has("living");
    const hasKitchen = types.has("kitchen");
    const hasBathroom = types.has("bathroom") || (apt.bathroom && apt.bathroom.area_sqm > 0);

    if (!hasBathroom) {
      pushApartmentIssue(apt.id, {
        severity: "error",
        code: "no_bathroom",
        message: `Wohnung ${apt.unit_number}: kein Badezimmer`,
      });
    }
    if (!hasLiving && !hasKitchen) {
      pushApartmentIssue(apt.id, {
        severity: "error",
        code: "no_living_or_kitchen",
        message: `Wohnung ${apt.unit_number}: weder Wohnraum noch Küche`,
      });
    }

    // Composition vs declared apartment_type (e.g. "3_room")
    const declared = parseInt(apt.apartment_type, 10);
    if (!Number.isNaN(declared)) {
      const implied = Math.max(1, Math.min(5, bedroomCount + (hasLiving ? 1 : 0)));
      if (implied !== declared) {
        pushApartmentIssue(apt.id, {
          severity: "warn",
          code: "composition_mismatch",
          message: `Wohnung ${apt.unit_number}: ${declared}-Zimmer deklariert, tatsächlich ${implied}-Zimmer`,
        });
      }
    }
  }

  // ── Fire-egress check (Phase 5a, MBO §35) ──────────────────────────────
  // Routed distance from each apt entrance door to the nearest staircase:
  // fail > 35 m (legal violation), warn 30-35 m (planning-stage early
  // warning). See `frontend/src/lib/fire-egress.ts` for the algorithm —
  // corridor-axis routing for Ganghaus layouts, Euclidean × 1.15 fallback
  // for Spänner / Laubengang.
  const egress = analyzeEgress(plan);
  for (const check of egress.checks) {
    if (check.status === "pass") continue;
    pushApartmentIssue(check.apartmentId, {
      severity: check.status === "fail" ? "error" : "warn",
      code: check.status === "fail" ? "egress_too_long" : "egress_warn",
      message: `Wohnung ${check.unitNumber}: ${check.reason}`,
    });
  }

  // ── Barrier-free check (Phase 5f, DIN 18040-2) ─────────────────────────
  // Only runs on the ground floor (BauO NRW §50 scope). Validates door
  // widths, bathroom turning areas, and corridor clear widths. See
  // `frontend/src/lib/barrier-free.ts` for the code-reference per check.
  const bf = analyzeBarrierFree(plan);
  for (const bfIssue of bf.issues) {
    // Prefer room scope when we have a subjectId that maps to a known
    // room (bathroom / corridor cases). Doors fall through to apt scope.
    const roomMatch = bfIssue.subjectId
      ? plan.rooms.find((r) => r.id === bfIssue.subjectId)
      : undefined;
    if (roomMatch) {
      pushRoomIssue(roomMatch.id, roomMatch.apartment_id ?? bfIssue.apartmentId, {
        severity: bfIssue.severity,
        code: bfIssue.code,
        message: bfIssue.message,
      });
    } else if (bfIssue.apartmentId) {
      pushApartmentIssue(bfIssue.apartmentId, {
        severity: bfIssue.severity,
        code: bfIssue.code,
        message: bfIssue.message,
      });
    } else {
      // Orphan issue (e.g. floor-level corridor with no apt_id) — push
      // as a plan-wide issue via the issues array directly.
      issues.push({
        severity: bfIssue.severity,
        code: bfIssue.code,
        message: bfIssue.message,
      });
    }
  }

  // ── Besonnung check (Phase 5g, DIN 5034-1) ─────────────────────────────
  // Per-apartment 17.01. sun-hour verdict. Only runs when lat/lng are
  // provided (i.e. plot has been geocoded); otherwise silently skipped.
  if (besonnungCtx?.latitude !== undefined && besonnungCtx?.longitude !== undefined) {
    const bes = analyzeBesonnung({
      plan,
      latitude: besonnungCtx.latitude,
      longitude: besonnungCtx.longitude,
      buildingRotationDeg: besonnungCtx.buildingRotationDeg,
    });
    if (bes.evaluated) {
      for (const apt of bes.apartments) {
        if (apt.status === "pass") continue;
        pushApartmentIssue(apt.apartmentId, {
          severity: apt.status === "fail" ? "error" : "warn",
          code: apt.status === "fail" ? "besonnung_fail" : "besonnung_warn",
          message: apt.reason,
        });
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warn").length;

  return { issues, byRoom, byApartment, byApartmentAll, errorCount, warnCount };
}

/** Compute an approximate centroid of a polygon (mean of its vertices).
 *  Good enough for placing a badge indicator. */
function polygonCentroid(poly: Point2D[]): Point2D {
  if (poly.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of poly) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / poly.length, y: sy / poly.length };
}

/**
 * Draws a small severity badge near each room that has issues, plus apartment-
 * level issue summaries placed near the apartment's rooms' bounding-box top-right.
 *
 * Badge radius 9px; red for any error in scope, amber for warnings only.
 * Text: total issue count for that scope.
 */
function drawValidationOverlay(
  ctx: CanvasRenderingContext2D,
  plan: FloorPlan,
  validation: ValidationResult,
  tx: (x: number) => number,
  ty: (y: number) => number,
) {
  ctx.save();
  ctx.font = "600 10px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Per-room badges
  for (const [roomId, list] of validation.byRoom) {
    if (list.length === 0) continue;
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room || room.polygon.length < 3) continue;
    const c = polygonCentroid(room.polygon);
    // Place badge offset from the centroid toward the top-right corner of
    // the room's bounding box, so it doesn't overlap the room label.
    const xs = room.polygon.map((p) => p.x);
    const ys = room.polygon.map((p) => p.y);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    // Interpolate 75% from centroid toward top-right corner
    const bx = tx(c.x + (maxX - c.x) * 0.65);
    const by = ty(c.y + (minY - c.y) * 0.65);
    const hasError = list.some((i) => i.severity === "error");
    drawIssueBadge(ctx, bx, by, list.length, hasError ? "error" : "warn");
  }

  // Per-apartment badges — placed at the apartment's rooms' combined
  // top-right, but only if the apartment has apartment-level issues
  // (room-only issues are already covered by per-room badges).
  for (const apt of plan.apartments) {
    const aptIssues = validation.byApartment.get(apt.id) ?? [];
    if (aptIssues.length === 0) continue;
    if (apt.rooms.length === 0) continue;
    // Combined bounding box of all the apartment's rooms
    let maxX = -Infinity;
    let minY = Infinity;
    for (const r of apt.rooms) {
      for (const p of r.polygon) {
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
      }
    }
    if (!Number.isFinite(maxX)) continue;
    const bx = tx(maxX) - 14;
    const by = ty(minY) + 14;
    const hasError = aptIssues.some((i) => i.severity === "error");
    drawIssueBadge(ctx, bx, by, aptIssues.length, hasError ? "error" : "warn");
  }

  ctx.restore();
}

/** Filled pill-shaped badge with a white stroke and the count centered. */
function drawIssueBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  count: number,
  severity: "error" | "warn",
) {
  const r = 10;
  const fill = severity === "error" ? "#ef4444" : "#f59e0b";
  ctx.save();
  // Drop shadow for contrast against room fills
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // White outer ring
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
  // Count label
  ctx.fillStyle = "#ffffff";
  ctx.fillText(String(count), x, y + 0.5);
  ctx.restore();
}

/** Signed polygon area via the shoelace formula; returns absolute m². */
function polygonArea(poly: Point2D[]): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(s) / 2;
}

/**
 * Pure version of wall-drag application. Takes a base FloorPlan and produces
 * a new one with the wall moved to `newPos`, all affected room polygon
 * vertices translated, areas recomputed, and a boolean `valid` flag that is
 * false if any affected room drops below its DIN minimum area.
 *
 * This lives at module scope so it can be called from mousemove against the
 * pre-drag snapshot (not the live edited plan, which already reflects the
 * previous frame's delta).
 */
function applyWallDragOnPlan(
  basePlan: FloorPlan,
  drag: WallDragState,
  newPos: number,
): { plan: FloorPlan; valid: boolean; invalidReason?: string } {
  const { affectedWallIds, axis, original, affectedRoomIds, kind } = drag;
  const key: "x" | "y" = axis;
  const wallGroup = new Set(affectedWallIds);

  // Move every wall in the drag group (partition: just one; apt_boundary:
  // every bearing_cross segment on the same axis — e.g. south + north of
  // the corridor).
  const wallsNext = basePlan.walls.map((w) => {
    if (!wallGroup.has(w.id)) return w;
    return {
      ...w,
      start: { ...w.start, [key]: newPos } as Point2D,
      end: { ...w.end, [key]: newPos } as Point2D,
    };
  });

  const affectedSet = new Set(affectedRoomIds);
  let valid = true;
  let invalidReason: string | undefined;

  const updateRoom = (room: FloorPlanRoom): FloorPlanRoom => {
    if (!affectedSet.has(room.id)) return room;
    const newPoly = room.polygon.map((p) => {
      if (Math.abs(p[key] - original) < VERTEX_MATCH_TOL) {
        return { ...p, [key]: newPos } as Point2D;
      }
      return p;
    });
    const newArea = polygonArea(newPoly);
    const minArea = MIN_ROOM_AREA_SQM[room.room_type] ?? 0;
    if (newArea < minArea - 0.001) {
      valid = false;
      if (!invalidReason) {
        invalidReason = `${room.label || room.room_type}: ${newArea.toFixed(1)}m² < ${minArea.toFixed(1)}m²`;
      }
    }
    return { ...room, polygon: newPoly, area_sqm: newArea };
  };

  const roomsNext = basePlan.rooms.map(updateRoom);
  const apartmentsNext = basePlan.apartments.map((apt) => ({
    ...apt,
    rooms: apt.rooms.map(updateRoom),
  }));

  // Openings (doors + windows) that sit on a dragged wall must follow the
  // wall along the perpendicular axis. Along-axis position (where they sit
  // along the wall) is preserved — this is pure translation. Fixes the
  // 3.6b known issue "openings don't follow apt-boundary drag".
  const doorsNext = basePlan.doors.map((d) =>
    wallGroup.has(d.wall_id)
      ? { ...d, position: { ...d.position, [key]: newPos } as Point2D }
      : d,
  );
  const windowsNext = basePlan.windows.map((w) =>
    wallGroup.has(w.wall_id)
      ? { ...w, position: { ...w.position, [key]: newPos } as Point2D }
      : w,
  );

  // Apt-boundary drags: ensure each affected apartment retains at least
  // MIN_APARTMENT_WIDTH_M along the drag axis (i.e. no apartment collapses
  // below one narrow bay).
  if (kind === "apt_boundary") {
    for (const apt of apartmentsNext) {
      // Only check apartments whose rooms were touched
      const touched = apt.rooms.some((r) => affectedSet.has(r.id));
      if (!touched) continue;
      const allAlong = apt.rooms.flatMap((r) =>
        r.polygon.map((p) => (axis === "x" ? p.x : p.y))
      );
      if (allAlong.length === 0) continue;
      const span = Math.max(...allAlong) - Math.min(...allAlong);
      if (span < MIN_APARTMENT_WIDTH_M - 0.001) {
        valid = false;
        if (!invalidReason) {
          invalidReason = `Apt ${apt.unit_number || apt.id.slice(0, 3)}: ${span.toFixed(2)}m < ${MIN_APARTMENT_WIDTH_M.toFixed(2)}m`;
        }
      }
    }
  }

  return {
    plan: {
      ...basePlan,
      walls: wallsNext,
      rooms: roomsNext,
      apartments: apartmentsNext,
      doors: doorsNext,
      windows: windowsNext,
    },
    valid,
    invalidReason,
  };
}

function adjustBrightness(hex: string, amount: number): string {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((num >> 16) & 0xff) + amount));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (num & 0xff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function drawDiagonalHatch(
  ctx: CanvasRenderingContext2D,
  polygon: Point2D[],
  tx: (x: number) => number,
  ty: (y: number) => number,
  spacing: number,
  color: string,
  alpha: number,
) {
  if (polygon.length < 3) return;

  // Get bounding box
  const xs = polygon.map((p) => tx(p.x));
  const ys = polygon.map((p) => ty(p.y));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  ctx.save();
  ctx.globalAlpha = alpha;

  // Create clipping path
  ctx.beginPath();
  polygon.forEach((p, i) => {
    if (i === 0) ctx.moveTo(tx(p.x), ty(p.y));
    else ctx.lineTo(tx(p.x), ty(p.y));
  });
  ctx.closePath();
  ctx.clip();

  // Draw diagonal lines
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let x = minX - (maxY - minY); x < maxX + (maxY - minY); x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, minY);
    ctx.lineTo(x + (maxY - minY), maxY);
    ctx.stroke();
  }

  ctx.restore();
}

function drawCrossHatch(
  ctx: CanvasRenderingContext2D,
  polygon: Point2D[],
  tx: (x: number) => number,
  ty: (y: number) => number,
  spacing: number,
  color: string,
  alpha: number,
) {
  if (polygon.length < 3) return;

  const xs = polygon.map((p) => tx(p.x));
  const ys = polygon.map((p) => ty(p.y));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.beginPath();
  polygon.forEach((p, i) => {
    if (i === 0) ctx.moveTo(tx(p.x), ty(p.y));
    else ctx.lineTo(tx(p.x), ty(p.y));
  });
  ctx.closePath();
  ctx.clip();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  // Diagonal lines one direction
  for (let x = minX - (maxY - minY); x < maxX + (maxY - minY); x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, minY);
    ctx.lineTo(x + (maxY - minY), maxY);
    ctx.stroke();
  }

  // Diagonal lines other direction
  for (let x = minX; x < maxX + (maxY - minY); x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, minY);
    ctx.lineTo(x - (maxY - minY), maxY);
    ctx.stroke();
  }

  ctx.restore();
}

function drawStructuralGrid(
  ctx: CanvasRenderingContext2D,
  grid: any,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
  bldgH: number,
) {
  // Draw grid lines
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = "#d4cfc9";
  ctx.lineWidth = 0.6;

  // Vertical lines (X-axis)
  for (const ax of grid.axis_positions_x) {
    ctx.beginPath();
    ctx.moveTo(tx(ax), ty(0));
    ctx.lineTo(tx(ax), ty(bldgH));
    ctx.stroke();
  }

  // Compute Y positions from grid data if not provided
  const yPositions = grid.axis_positions_y || [
    grid.outer_wall_south_y || 0,
    grid.corridor_y_start_m || 0,
    (grid.corridor_y_start_m || 0) + (grid.corridor_width_m || 0),
    grid.outer_wall_north_y || grid.building_depth_m,
  ].filter((v: number, i: number, a: number[]) => v >= 0 && a.indexOf(v) === i).sort((a: number, b: number) => a - b);

  // Horizontal lines (Y-axis)
  for (const ay of yPositions) {
    ctx.beginPath();
    ctx.moveTo(tx(0), ty(ay));
    ctx.lineTo(tx(grid.building_length_m), ty(ay));
    ctx.stroke();
  }

  ctx.setLineDash([]);

  // Draw axis labels
  ctx.fillStyle = "#8b8277";
  ctx.font = "9px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  // X-axis labels (A, B, C, ...)
  (grid.axis_positions_x || []).forEach((ax: number, i: number) => {
    const label = String.fromCharCode(65 + i); // A, B, C, ...
    ctx.fillText(label, tx(ax), ty(0) + 5);
  });

  // Y-axis labels (1, 2, 3, ...)
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i < yPositions.length; i++) {
    const ay = yPositions[i];
    ctx.fillText((i + 1).toString(), tx(0) - 5, ty(ay));
  }
}

function drawApartmentOutline(
  ctx: CanvasRenderingContext2D,
  apt: FloorPlanApartment,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
  isSelected: boolean,
) {
  // Trace the outer boundary of all rooms in this apartment
  const allPoints = apt.rooms.flatMap((r) => r.polygon);
  if (allPoints.length === 0) return;

  // Compute convex hull or use simplified outer boundary
  const hull = computeConvexHull(allPoints);
  if (hull.length < 3) return;

  // Draw apartment boundary
  ctx.strokeStyle = isSelected ? "#2563eb" : "#60a5fa";
  ctx.lineWidth = isSelected ? 3 : 2;
  ctx.setLineDash(isSelected ? [] : [5, 3]);

  ctx.beginPath();
  hull.forEach((p, i) => {
    if (i === 0) ctx.moveTo(tx(p.x), ty(p.y));
    else ctx.lineTo(tx(p.x), ty(p.y));
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw apartment number label
  const centerX = sum(allPoints.map((p) => p.x)) / allPoints.length;
  const centerY = sum(allPoints.map((p) => p.y)) / allPoints.length;

  ctx.fillStyle = isSelected ? "#2563eb" : "#60a5fa";
  ctx.font = "bold 11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(apt.unit_number || apt.id.slice(0, 3), tx(centerX), ty(centerY) - ts(0.5));
}

function computeConvexHull(points: Point2D[]): Point2D[] {
  if (points.length < 3) return points;

  // Sort points lexicographically
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);

  // Build lower hull
  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  // Build upper hull
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  return lower.concat(upper.slice(1, upper.length - 1));
}

function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Phase 4.1 — DIN-compliant furniture silhouettes per room.
 *  Each piece rendered as a filled rectangle with a soft stroke and a
 *  tiny label when zoom allows. Rooms where placement failed get a faint
 *  dashed warning rectangle across the centroid area. */
function drawFurnitureLayer(
  ctx: CanvasRenderingContext2D,
  rooms: FloorPlanRoom[],
  byRoom: Map<string, RoomFurnitureResult>,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
) {
  ctx.save();
  // Draw each placement on top of the room fill
  for (const room of rooms) {
    const result = byRoom.get(room.id);
    if (!result) continue;
    for (const p of result.placements) {
      drawFurniturePiece(ctx, p, tx, ty, ts);
    }
  }
  ctx.restore();
}

function drawFurniturePiece(
  ctx: CanvasRenderingContext2D,
  p: FurniturePlacement,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
) {
  const fill = FURNITURE_COLORS[p.kind] ?? "#8a7a6a";
  // Top-left in screen: (tx(x), ty(y + depth)) because canvas-y is flipped.
  const sx = tx(p.x);
  const sy = ty(p.y + p.depth_m);
  const sw = ts(p.width_m);
  const sh = ts(p.depth_m);

  // Base fill — semi-transparent so room color still shows through
  ctx.fillStyle = fill + "b3"; // ~70% alpha
  ctx.fillRect(sx, sy, sw, sh);
  // Crisp outline
  ctx.strokeStyle = fill;
  ctx.lineWidth = 0.75;
  ctx.strokeRect(sx, sy, sw, sh);

  // Kind-specific embellishments for architectural legibility
  switch (p.kind) {
    case "bed_double":
    case "bed_single": {
      // Pillow line at head (assumed top edge — we don't track orientation,
      // so draw two small rectangles at the short edge nearest the centroid
      // of the longer dimension)
      const headAlongX = p.depth_m > p.width_m; // piece is "tall" — head at top
      ctx.fillStyle = "#f5ede0";
      const padding = ts(0.08);
      const pillowThick = ts(0.15);
      if (headAlongX) {
        ctx.fillRect(sx + padding, sy + padding, sw - 2 * padding, pillowThick);
      } else {
        ctx.fillRect(sx + padding, sy + padding, pillowThick, sh - 2 * padding);
      }
      break;
    }
    case "sofa": {
      // Back cushion indication — draw a thinner rectangle along the longer
      // edge, slightly inset.
      ctx.fillStyle = "#6b5d50";
      const inset = ts(0.15);
      if (p.width_m > p.depth_m) {
        ctx.fillRect(sx + 1, sy + 1, sw - 2, inset);
      } else {
        ctx.fillRect(sx + 1, sy + 1, inset, sh - 2);
      }
      break;
    }
    case "bathtub": {
      // Inner basin outline
      ctx.strokeStyle = "#5c7a9e";
      ctx.lineWidth = 0.5;
      const inset = ts(0.12);
      ctx.strokeRect(sx + inset, sy + inset, sw - 2 * inset, sh - 2 * inset);
      break;
    }
    case "shower": {
      ctx.strokeStyle = "#5c7a9e";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + sw, sy + sh);
      ctx.moveTo(sx + sw, sy);
      ctx.lineTo(sx, sy + sh);
      ctx.stroke();
      break;
    }
    case "wc": {
      // Round the front edge slightly
      ctx.fillStyle = "#b5c7d5";
      ctx.beginPath();
      ctx.arc(sx + sw / 2, sy + sh - ts(0.12), ts(0.15), 0, Math.PI);
      ctx.fill();
      break;
    }
    case "kitchen_counter": {
      // Hob indicator: four small circles
      ctx.fillStyle = "#2e3a44";
      const rr = ts(0.08);
      const isHorizontal = p.width_m > p.depth_m;
      if (isHorizontal) {
        const cy = sy + sh / 2;
        for (let i = 0; i < 4; i++) {
          const cx = sx + ts(0.30) + i * ts(0.22);
          if (cx + rr > sx + sw - ts(0.1)) break;
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
  }

  // Label (only if piece is large enough to host text at current zoom)
  if (p.label && sw > 24 && sh > 14) {
    ctx.fillStyle = "#1f1a15";
    ctx.font = `500 ${Math.min(11, Math.max(8, Math.min(sw, sh) / 4))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.label, sx + sw / 2, sy + sh / 2);
  }
}

function drawRoomLabels(
  ctx: CanvasRenderingContext2D,
  rooms: FloorPlanRoom[],
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const room of rooms) {
    if (room.room_type === "shaft") continue;

    const cx = sum(room.polygon.map((p) => p.x)) / room.polygon.length;
    const cy = sum(room.polygon.map((p) => p.y)) / room.polygon.length;

    const labelSize = Math.max(ts(0.6), 8);
    const fontSize = Math.min(11, labelSize);

    ctx.fillStyle = "#4a453f";
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.fillText(room.label, tx(cx), ty(cy) - fontSize * 0.7);

    ctx.fillStyle = "#7a7066";
    ctx.font = `${Math.max(7, fontSize - 1)}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.fillText(`${room.area_sqm.toFixed(1)}m²`, tx(cx), ty(cy) + fontSize * 0.3);
  }
}

/**
 * Draws DIN 406-style dimension strings.
 *
 * Two strings on both axes:
 *   • INNER string — individual bay widths (horizontal) / single span (vertical)
 *   • OUTER string — overall building dimension
 *
 * Style: extension lines from the axis with a small gap; 45° tick slashes at
 * each dimension stop; labels centered above the dimension line.
 */
function drawDimensionLines(
  ctx: CanvasRenderingContext2D,
  grid: { axis_positions_x: number[]; bay_widths: number[] },
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
  bldgW: number,
  bldgH: number,
) {
  const DIM_COLOR = "#2b2520";
  const LABEL_COLOR = "#1a1612";
  const LINE_W = 0.75;
  const EXT_GAP = 3;       // gap between building edge and start of extension line
  const TICK = 5;          // length of 45° tick slash in px
  // Absolute pixel offsets — stay within the viewer's 50px padding
  const INNER_OFFSET = 18;
  const OUTER_OFFSET = 38;

  ctx.strokeStyle = DIM_COLOR;
  ctx.lineWidth = LINE_W;
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";

  // ── Horizontal dimensions (placed ABOVE the building, i.e. smaller canvas Y) ──
  const topY = ty(bldgH);
  const innerY = topY - INNER_OFFSET;
  const outerY = topY - OUTER_OFFSET;

  // Extension lines from building edge up past the outer dimension
  for (const ax of grid.axis_positions_x) {
    const sx = tx(ax);
    ctx.beginPath();
    ctx.moveTo(sx, topY - EXT_GAP);
    ctx.lineTo(sx, outerY - 3);
    ctx.stroke();
  }

  // Inner dim line + per-bay ticks + labels
  ctx.beginPath();
  ctx.moveTo(tx(grid.axis_positions_x[0]), innerY);
  ctx.lineTo(tx(grid.axis_positions_x[grid.axis_positions_x.length - 1]), innerY);
  ctx.stroke();

  for (const ax of grid.axis_positions_x) {
    const sx = tx(ax);
    ctx.beginPath();
    ctx.moveTo(sx - TICK / 2, innerY + TICK / 2);
    ctx.lineTo(sx + TICK / 2, innerY - TICK / 2);
    ctx.stroke();
  }

  let prevX = grid.axis_positions_x[0];
  for (let i = 0; i < grid.bay_widths.length; i++) {
    const nextX = grid.axis_positions_x[i + 1] ?? prevX + grid.bay_widths[i];
    const midX = (prevX + nextX) / 2;
    ctx.fillText(grid.bay_widths[i].toFixed(2), tx(midX), innerY - 3);
    prevX = nextX;
  }

  // Outer dim line (overall building width)
  const leftSx = tx(0);
  const rightSx = tx(bldgW);
  ctx.beginPath();
  ctx.moveTo(leftSx, outerY);
  ctx.lineTo(rightSx, outerY);
  ctx.stroke();
  // End ticks
  for (const sx of [leftSx, rightSx]) {
    ctx.beginPath();
    ctx.moveTo(sx - TICK / 2, outerY + TICK / 2);
    ctx.lineTo(sx + TICK / 2, outerY - TICK / 2);
    ctx.stroke();
  }
  ctx.font = "bold 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillText(`${bldgW.toFixed(2)} m`, (leftSx + rightSx) / 2, outerY - 3);

  // ── Vertical dimensions (placed LEFT of the building) ──
  const leftX = tx(0);
  const innerX = leftX - INNER_OFFSET;
  const outerX = leftX - OUTER_OFFSET;

  ctx.lineWidth = LINE_W;
  ctx.strokeStyle = DIM_COLOR;

  // Extension lines at top and bottom
  for (const yPlan of [0, bldgH]) {
    const sy = ty(yPlan);
    ctx.beginPath();
    ctx.moveTo(leftX - EXT_GAP, sy);
    ctx.lineTo(outerX + 3, sy);
    ctx.stroke();
  }

  // Inner (= single span for building depth)
  const topSy = ty(bldgH);
  const botSy = ty(0);
  ctx.beginPath();
  ctx.moveTo(innerX, topSy);
  ctx.lineTo(innerX, botSy);
  ctx.stroke();
  for (const sy of [topSy, botSy]) {
    ctx.beginPath();
    ctx.moveTo(innerX - TICK / 2, sy - TICK / 2);
    ctx.lineTo(innerX + TICK / 2, sy + TICK / 2);
    ctx.stroke();
  }

  // Outer (same value here, but stays consistent with horizontal layout)
  ctx.beginPath();
  ctx.moveTo(outerX, topSy);
  ctx.lineTo(outerX, botSy);
  ctx.stroke();
  for (const sy of [topSy, botSy]) {
    ctx.beginPath();
    ctx.moveTo(outerX - TICK / 2, sy - TICK / 2);
    ctx.lineTo(outerX + TICK / 2, sy + TICK / 2);
    ctx.stroke();
  }

  // Rotated label for vertical depth
  ctx.save();
  ctx.translate(outerX - 3, (topSy + botSy) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = "bold 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${bldgH.toFixed(2)} m`, 0, 0);
  ctx.restore();

  // Inner depth label (same value, shown smaller next to inner line)
  ctx.save();
  ctx.translate(innerX - 3, (topSy + botSy) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(bldgH.toFixed(2), 0, 0);
  ctx.restore();
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scale: number,
) {
  const barLength = 50; // pixels for 5m
  const barValue = barLength / scale; // actual meters

  const x = width - 80;
  const y = height - 30;

  ctx.strokeStyle = "#2b2520";
  ctx.lineWidth = 1.5;
  ctx.fillStyle = "#2b2520";

  // Draw scale bar
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barLength, y);
  ctx.stroke();

  // End ticks
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 5);
  ctx.moveTo(x + barLength, y - 5);
  ctx.lineTo(x + barLength, y + 5);
  ctx.stroke();

  // Label
  ctx.font = "9px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(`${barValue.toFixed(1)}m`, x + barLength / 2, y + 8);
}

function drawNorthArrow(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const size = 20;
  const x = 30;
  const y = 50;

  ctx.fillStyle = "#2b2520";
  ctx.strokeStyle = "#2b2520";
  ctx.lineWidth = 1.5;

  // Arrow pointing up
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size / 2, y + size);
  ctx.lineTo(x, y + size * 0.6);
  ctx.lineTo(x + size / 2, y + size);
  ctx.closePath();
  ctx.fill();

  // Label
  ctx.font = "bold 9px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("N", x, y + size + 5);
}

function drawMeasurements(
  ctx: CanvasRenderingContext2D,
  points: Point2D[],
  snapPoint: Point2D | null,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
) {
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const sx1 = tx(p1.x);
    const sy1 = ty(p1.y);

    // Draw point marker
    ctx.fillStyle = "#d97706";
    ctx.beginPath();
    ctx.arc(sx1, sy1, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // If we have a next point, draw the measurement
    if (i < points.length - 1) {
      const p2 = points[i + 1];
      const sx2 = tx(p2.x);
      const sy2 = ty(p2.y);

      // Calculate components
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const distanceM = Math.hypot(dx, dy);

      // Draw dimension line
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();

      // Draw guide lines (dashed orthogonal)
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = "#d9770660";
      ctx.lineWidth = 1;

      // Horizontal component line
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy1);
      ctx.stroke();

      // Vertical component line
      ctx.beginPath();
      ctx.moveTo(sx2, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();

      ctx.setLineDash([]);

      // Draw end ticks
      const tickLen = 5;
      const angle = Math.atan2(sy2 - sy1, sx2 - sx1);
      const perpAngle = angle + Math.PI / 2;

      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 1.5;

      // Ticks at both ends
      for (const [sx, sy] of [
        [sx1, sy1],
        [sx2, sy2],
      ]) {
        ctx.beginPath();
        ctx.moveTo(
          sx + Math.cos(perpAngle) * tickLen,
          sy + Math.sin(perpAngle) * tickLen
        );
        ctx.lineTo(
          sx - Math.cos(perpAngle) * tickLen,
          sy - Math.sin(perpAngle) * tickLen
        );
        ctx.stroke();
      }

      // Draw measurement label with components
      const midX = (sx1 + sx2) / 2;
      const midY = (sy1 + sy2) / 2;

      const labelText = `Δx: ${Math.abs(dx).toFixed(3)}m | Δy: ${Math.abs(dy).toFixed(3)}m | D: ${distanceM.toFixed(3)}m`;

      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 2;
      ctx.font = "bold 10px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const textMetrics = ctx.measureText(labelText);
      const boxPadding = 4;
      const boxWidth = textMetrics.width + 2 * boxPadding;
      const boxHeight = 16;

      ctx.strokeRect(
        midX - boxWidth / 2,
        midY - boxHeight / 2,
        boxWidth,
        boxHeight
      );
      ctx.fillRect(
        midX - boxWidth / 2,
        midY - boxHeight / 2,
        boxWidth,
        boxHeight
      );

      ctx.fillStyle = "#d97706";
      ctx.fillText(labelText, midX, midY);
    }
  }
}
