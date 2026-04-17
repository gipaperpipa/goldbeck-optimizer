"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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

  // View mode — Architect (technical, all layers, crisp black linework) vs
  // Presentation (client-facing, hides grid/dimensions, clean white background).
  const [viewMode, setViewMode] = useState<"architect" | "presentation">("architect");
  const applyViewMode = (mode: "architect" | "presentation") => {
    setViewMode(mode);
    if (mode === "architect") {
      setLayers({
        grid: true, rooms: true, walls: true, openings: true,
        labels: true, dimensions: true, annotations: true,
      });
    } else {
      // Presentation: hide technical layers, keep rooms + walls + openings + labels
      setLayers({
        grid: false, rooms: true, walls: true, openings: true,
        labels: true, dimensions: false, annotations: true,
      });
    }
  };

  // Precompute transform
  const getTransform = useCallback(() => {
    const grid = floorPlan.structural_grid;
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
  }, [floorPlan, width, height]);

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

      // --- Element inspection (priority: opening → wall → room) ---
      const planX = invTx(mx);
      const planY = invTy(my);

      // 1. Windows / doors — hit if within half-width along the host wall + ~0.35m across
      const OPENING_TOL = 0.35;
      for (const win of floorPlan.windows) {
        const d = Math.hypot(planX - win.position.x, planY - win.position.y);
        if (d <= Math.max(win.width_m / 2, OPENING_TOL)) {
          setInspected({ kind: "window", data: win });
          return;
        }
      }
      for (const door of floorPlan.doors) {
        const d = Math.hypot(planX - door.position.x, planY - door.position.y);
        if (d <= Math.max(door.width_m / 2, OPENING_TOL)) {
          setInspected({ kind: "door", data: door });
          return;
        }
      }

      // 2. Walls — hit if perpendicular distance to segment < thickness/2 + 0.08m tolerance
      for (const wall of floorPlan.walls) {
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
      for (const apt of floorPlan.apartments) {
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
    [floorPlan, onApartmentSelect, getTransform, measureMode, measurePoints, snapPoint]
  );

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

      if (measureMode) {
        canvas.style.cursor = "crosshair";

        // Find snap points: wall endpoints, grid intersections, room corners
        let closestSnap: Point2D | null = null;
        let closestDist = SNAP_RADIUS;

        // Check wall endpoints
        for (const wall of floorPlan.walls) {
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
        for (const room of floorPlan.rooms) {
          for (const pt of room.polygon) {
            const dist = Math.hypot(planX - pt.x, planY - pt.y);
            if (dist < closestDist) {
              closestSnap = pt;
              closestDist = dist;
            }
          }
        }

        // Check grid intersections
        const grid = floorPlan.structural_grid;
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

      for (const apt of floorPlan.apartments) {
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
    [floorPlan, hoveredAptId, getTransform, measureMode]
  );

  // Keyboard shortcuts (L10)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (measureMode) {
          setMeasureMode(false);
          setMeasurePoints([]);
        } else if (onApartmentSelect) {
          onApartmentSelect(null); // Deselect apartment
        }
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
  }, [measureMode, onApartmentSelect]);

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
    const grid = floorPlan.structural_grid;
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
    const allRooms = [...floorPlan.rooms];
    if (layers.rooms) {
      for (const room of allRooms) {
        drawRoom(ctx, room, tx, ty, hoveredAptId, selectedApartmentId);
      }
    }

    // --- 6. Apartment outlines (trace actual apartment boundary) ---
    if (layers.rooms) {
      for (const apt of floorPlan.apartments) {
        const isSelected = apt.id === selectedApartmentId;
        const isHovered = apt.id === hoveredAptId;
        if (isSelected || isHovered) {
          drawApartmentOutline(ctx, apt, tx, ty, ts, isSelected);
        }
      }
    }

    // --- 7. Walls (filled rectangles with proper thickness) ---
    if (layers.walls) {
      for (const wall of floorPlan.walls) {
        drawWall(ctx, wall, tx, ty, ts);
      }
    }

    // --- 8. Windows (architectural symbols — oriented along host wall) ---
    if (layers.openings) {
      for (const win of floorPlan.windows) {
        const hostWall = findNearestWall2D(win.position, floorPlan.walls);
        drawWindow(ctx, win, hostWall, tx, ty, ts);
      }

      // --- 9. Doors (architectural swing arcs — oriented along host wall) ---
      for (const door of floorPlan.doors) {
        const hostWall = findNearestWall2D(door.position, floorPlan.walls);
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

    // --- 16. Title and metadata ---
    if (!layers.annotations) return;
    ctx.fillStyle = "#2b2520";
    ctx.font = "bold 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      `${floorPlan.floor_index === 0 ? "EG" : `${floorPlan.floor_index}. OG`} \u2022 ${floorPlan.num_apartments} Wohnungen \u2022 ${
        floorPlan.access_type === "ganghaus"
          ? "Central Corridor"
          : floorPlan.access_type === "laubengang"
            ? "External Gallery"
            : "Direct Access"
      }`,
      12,
      18
    );

    ctx.fillStyle = "#7a7066";
    ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.fillText(
      `Gross: ${floorPlan.gross_area_sqm.toFixed(1)}m\u00B2 | Net: ${floorPlan.net_area_sqm.toFixed(1)}m\u00B2`,
      12,
      height - 8
    );
  }, [floorPlan, width, height, hoveredAptId, selectedApartmentId, getTransform, measurePoints, snapPoint, measureMode, layers, viewMode]);

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
        aria-label={`Grundriss ${floorPlan.floor_index === 0 ? "EG" : `${floorPlan.floor_index}. OG`} — ${floorPlan.apartments.length} Wohnungen`}
        onClick={handleClick}
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
            link.download = `grundriss_${floorPlan.floor_index === 0 ? "EG" : `${floorPlan.floor_index}OG`}.png`;
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
