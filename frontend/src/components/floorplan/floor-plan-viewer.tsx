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
}: FloorPlanViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredAptId, setHoveredAptId] = useState<string | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<Point2D[]>([]);
  const [snapPoint, setSnapPoint] = useState<Point2D | null>(null);
  const rafRef = useRef<number | null>(null);

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
  const [editedPlan, setEditedPlan] = useState<FloorPlan>(floorPlan);
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
    setEditedPlan(floorPlan);
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
  const validation = useMemo(() => validatePlan(plan), [plan]);
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
      setLayers({
        grid: true, rooms: true, walls: true, openings: true,
        labels: true, dimensions: true, annotations: true, validation: true,
      });
    } else {
      // Presentation: hide technical layers, keep rooms + walls + openings + labels
      setLayers({
        grid: false, rooms: true, walls: true, openings: true,
        labels: true, dimensions: false, annotations: true, validation: false,
      });
    }
  };

  // Precompute transform
  const getTransform = useCallback(() => {
    const grid = plan.structural_grid;
    const bldgW = grid.building_length_m;
    const bldgH = grid.building_depth_m;

    const padding = 50;
    const scaleX = (width - 2 * padding) / bldgW;
    const scaleY = (height - 2 * padding) / bldgH;
    const scale = Math.min(scaleX, scaleY);

    const offsetX = padding + ((width - 2 * padding) - bldgW * scale) / 2;
    const offsetY = padding + ((height - 2 * padding) - bldgH * scale) / 2;

    return {
      scale,
      offsetX,
      offsetY,
      tx: (x: number) => offsetX + x * scale,
      ty: (y: number) => height - (offsetY + y * scale),
      ts: (s: number) => s * scale,
      // Inverse transforms: convert screen coordinates to plan coordinates
      invTx: (screenX: number) => (screenX - offsetX) / scale,
      invTy: (screenY: number) => (height - screenY - offsetY) / scale,
    };
  }, [plan, width, height]);

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
      if (e.button !== 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
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
        } else {
          // Click empty space → deselect
          setSelectedOpening(null);
        }
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
    ]
  );

  // ── Mouse up — commit (valid) or revert (invalid) a drag ──────────────────
  const handleMouseUp = useCallback(() => {
    if (wallDrag) {
      // editedPlan is already live-updated during mousemove; revert if
      // invalid or if the wall never moved off its original position.
      const moved = Math.abs(wallDrag.current - wallDrag.original) > 0.001;
      if (!wallDrag.valid || !moved) {
        if (preDragPlanRef.current) setEditedPlan(preDragPlanRef.current);
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
      }
      preDragPlanRef.current = null;
      setOpeningDrag(null);
    }
  }, [wallDrag, openingDrag]);

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

  // Keyboard shortcuts (L10)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
          if (selectedOpening) {
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
        setEditedPlan((prev) => {
          if (selectedOpening.kind === "window") {
            return { ...prev, windows: prev.windows.filter((w) => w.id !== selectedOpening.id) };
          }
          return { ...prev, doors: prev.doors.filter((d) => d.id !== selectedOpening.id) };
        });
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
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [measureMode, onApartmentSelect, editMode, wallDrag, openingDrag, selectedOpening, roomEditor]);

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
  ]);

  const handleMeasureToggle = () => {
    setMeasureMode(!measureMode);
    setMeasurePoints([]);
  };

  const handleClearMeasurements = () => {
    setMeasurePoints([]);
  };

  return (
    <div className="relative inline-block">
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="border rounded-lg bg-white cursor-default"
        tabIndex={0}
        role="img"
        aria-label={`Grundriss ${plan.floor_index === 0 ? "EG" : `${plan.floor_index}. OG`} — ${plan.apartments.length} Wohnungen`}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onMouseMove={handleMouseMove}
      />
      <div className="absolute top-2 right-2 flex gap-2">
        {/* View mode segmented toggle */}
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
              setEditedPlan(floorPlan);
              setWallDrag(null);
              setHoveredWallId(null);
            }}
            className="px-3 py-1.5 rounded text-sm font-medium bg-gray-200 text-gray-800 hover:bg-gray-300 transition-colors"
            title="Alle Wand-Änderungen zurücksetzen"
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
        return (
          <RoomTypePopover
            room={room}
            anchorX={roomEditor.screenX}
            anchorY={roomEditor.screenY}
            onClose={() => setRoomEditor(null)}
            onApply={(newType) => {
              const nextPlan = applyRoomTypeChangeOnPlan(editedPlan, room.id, newType);
              setEditedPlan(nextPlan);
              setRoomEditor(null);
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
  onClose,
  onApply,
}: {
  room: FloorPlanRoom;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  onApply: (newType: (typeof REASSIGNABLE_ROOM_TYPES)[number]) => void;
}) {
  // Popover card size: ~ 200 × 200 px. Nudge anchor so the card doesn't
  // overflow the canvas on right / bottom edges — we clamp by subtracting
  // from the anchor when the click is too close to the edge.
  const CARD_W = 216;
  const CARD_H = 250;
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
function validatePlan(plan: FloorPlan): ValidationResult {
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
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
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
    plan: { ...basePlan, walls: wallsNext, rooms: roomsNext, apartments: apartmentsNext },
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
