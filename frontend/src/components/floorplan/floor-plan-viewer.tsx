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

interface FloorPlanViewerProps {
  floorPlan: FloorPlan;
  width?: number;
  height?: number;
  selectedApartmentId?: string | null;
  onApartmentSelect?: (apt: FloorPlanApartment | null) => void;
}

// Professional architectural color palette
const ROOM_COLORS: Record<string, string> = {
  living: "#e8dcc8",      // Warm beige
  bedroom: "#d4e4d0",     // Soft sage green
  kitchen: "#dbe4c8",     // Light taupe
  bathroom: "#d9e4f0",    // Soft blue-gray
  hallway: "#f0ebe5",     // Light neutral
  storage: "#d9d0c8",     // Warm gray
  balcony: "#f5f5e8",     // Very light cream
  corridor: "#e8e5e0",    // Light gray
  staircase: "#d4d0c8",   // Medium taupe
  elevator: "#d4d0c8",    // Medium taupe
  shaft: "#c4c0b8",       // Neutral gray
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

// Snap radius for measurements (in plan coordinates)
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

      // Handle apartment selection
      if (!onApartmentSelect) return;

      // Find which apartment was clicked (find the most specific match)
      let selectedApt: FloorPlanApartment | null = null;
      let smallestArea = Infinity;

      for (const apt of floorPlan.apartments) {
        for (const room of apt.rooms) {
          if (isPointInPolygon(mx, my, room.polygon, invTx, invTy)) {
            // Prefer the apartment with the smallest total area (most specific match)
            const aptArea = apt.rooms.reduce((sum, r) => sum + r.area_sqm, 0);
            if (aptArea < smallestArea) {
              selectedApt = apt;
              smallestArea = aptArea;
            }
            break;
          }
        }
      }

      onApartmentSelect(selectedApt);
    },
    [floorPlan, onApartmentSelect, getTransform, measureMode, measurePoints, snapPoint]
  );

  // Handle mouse move for hover and snap detection
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
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
    },
    [floorPlan, hoveredAptId, getTransform, measureMode]
  );

  // Handle Escape key to exit measure mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && measureMode) {
        setMeasureMode(false);
        setMeasurePoints([]);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [measureMode]);

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

    // --- 1. Background ---
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fafaf8";
    ctx.fillRect(0, 0, width, height);

    // --- 2. Building shadow/depth effect ---
    ctx.fillStyle = "#e8e4df";
    const shadowOffset = 2;
    ctx.fillRect(tx(0) + shadowOffset, ty(bldgH) + shadowOffset, ts(bldgW), ts(bldgH));

    // --- 3. Building outline (thick solid line) ---
    ctx.strokeStyle = "#2b2520";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(tx(0), ty(bldgH), ts(bldgW), ts(bldgH));

    // --- 4. Structural grid with axis labels ---
    drawStructuralGrid(ctx, grid, tx, ty, ts, bldgH);

    // --- 5. Rooms (filled polygons) ---
    const allRooms = [...floorPlan.rooms];
    for (const room of allRooms) {
      drawRoom(ctx, room, tx, ty, hoveredAptId, selectedApartmentId);
    }

    // --- 6. Apartment outlines (trace actual apartment boundary) ---
    for (const apt of floorPlan.apartments) {
      const isSelected = apt.id === selectedApartmentId;
      const isHovered = apt.id === hoveredAptId;
      if (isSelected || isHovered) {
        drawApartmentOutline(ctx, apt, tx, ty, ts, isSelected);
      }
    }

    // --- 7. Walls (filled rectangles with proper thickness) ---
    for (const wall of floorPlan.walls) {
      drawWall(ctx, wall, tx, ty, ts);
    }

    // --- 8. Windows (architectural symbols — oriented along host wall) ---
    for (const win of floorPlan.windows) {
      const hostWall = findNearestWall2D(win.position, floorPlan.walls);
      drawWindow(ctx, win, hostWall, tx, ty, ts);
    }

    // --- 9. Doors (architectural swing arcs — oriented along host wall) ---
    for (const door of floorPlan.doors) {
      const hostWall = findNearestWall2D(door.position, floorPlan.walls);
      drawDoor(ctx, door, hostWall, tx, ty, ts);
    }

    // --- 10. Room labels (professional typography) ---
    drawRoomLabels(ctx, allRooms, tx, ty, ts);

    // --- 11. Dimension lines with architectural style ---
    drawDimensionLines(ctx, grid, tx, ty, ts, bldgW, bldgH);

    // --- 12. Scale bar ---
    drawScaleBar(ctx, width, height, scale);

    // --- 13. North arrow ---
    drawNorthArrow(ctx, width, height);

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
    ctx.fillStyle = "#2b2520";
    ctx.font = "bold 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      `Floor ${floorPlan.floor_index} \u2022 ${floorPlan.num_apartments} apartments \u2022 ${
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
  }, [floorPlan, width, height, hoveredAptId, selectedApartmentId, getTransform, measurePoints, snapPoint, measureMode]);

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
        onClick={handleClick}
        onMouseMove={handleMouseMove}
      />
      <div className="absolute top-2 right-2 flex gap-2">
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

  if (wall.is_bearing) {
    if (wall.is_exterior) {
      wallThickness = ts(wall.thickness_m || 0.25);
      fillColor = "#2b2520"; // Solid black/dark
    } else {
      wallThickness = ts(wall.thickness_m || 0.2);
      fillColor = "#1e1a15"; // Dark gray
    }
  } else if (wall.is_exterior) {
    wallThickness = ts(wall.thickness_m || 0.15);
    fillColor = "#4a453f"; // Medium gray
  } else {
    wallThickness = ts(wall.thickness_m || 0.08);
    fillColor = "#b8b4ad"; // Light gray
  }

  // Draw wall as a filled rectangle
  const offset = wallThickness / 2;
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.moveTo(startX + perpX * offset, startY + perpY * offset);
  ctx.lineTo(endX + perpX * offset, endY + perpY * offset);
  ctx.lineTo(endX - perpX * offset, endY - perpY * offset);
  ctx.lineTo(startX - perpX * offset, startY - perpY * offset);
  ctx.closePath();
  ctx.fill();
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

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(screenAngle);

  // Window opening line (along wall direction)
  ctx.strokeStyle = "#4a9fd8";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.lineTo(w / 2, 0);
  ctx.stroke();

  // Glass pane indicator (arc perpendicular to wall)
  const arcRadius = ts(0.3);
  ctx.strokeStyle = "#2e7db3";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, arcRadius, 0, Math.PI, false);
  ctx.stroke();

  // End ticks (perpendicular to wall direction)
  ctx.strokeStyle = "#4a9fd8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-w / 2, -2.5);
  ctx.lineTo(-w / 2, 2.5);
  ctx.moveTo(w / 2, -2.5);
  ctx.lineTo(w / 2, 2.5);
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

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(screenAngle);

  // Door leaf line (along wall direction)
  ctx.strokeStyle = color;
  ctx.lineWidth = door.is_entrance ? 2 : 1.5;
  ctx.beginPath();
  ctx.moveTo(-doorW / 2, 0);
  ctx.lineTo(doorW / 2, 0);
  ctx.stroke();

  // 90-degree swing arc (opens perpendicular to wall)
  const arcRadius = doorW * 0.65;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(doorW / 2, 0, arcRadius, Math.PI, Math.PI / 2, true);
  ctx.stroke();
  ctx.globalAlpha = 1;

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

function drawDimensionLines(
  ctx: CanvasRenderingContext2D,
  grid: any,
  tx: (x: number) => number,
  ty: (y: number) => number,
  ts: (s: number) => number,
  bldgW: number,
  bldgH: number,
) {
  const offsetAbove = ts(0.6);
  const offsetLeft = ts(0.6);

  // Dimension line offset from building edge
  ctx.strokeStyle = "#8b8277";
  ctx.lineWidth = 0.8;

  // Horizontal bay dimensions
  let prevX = grid.axis_positions_x[0];
  for (let i = 0; i < grid.bay_widths.length; i++) {
    const nextX = grid.axis_positions_x[i + 1] ?? prevX + grid.bay_widths[i];
    const midX = (prevX + nextX) / 2;

    // Dimension line
    const y = ty(0) + offsetAbove;
    ctx.beginPath();
    ctx.moveTo(tx(prevX), y - 3);
    ctx.lineTo(tx(prevX), y);
    ctx.lineTo(tx(nextX), y);
    ctx.lineTo(tx(nextX), y - 3);
    ctx.stroke();

    // Label
    ctx.fillStyle = "#7a7066";
    ctx.font = "8px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${grid.bay_widths[i].toFixed(2)}m`, tx(midX), y - 6);

    prevX = nextX;
  }

  // Vertical depth dimension
  ctx.save();
  ctx.translate(tx(0) - offsetLeft, ty(bldgH / 2));
  ctx.rotate(-Math.PI / 2);

  const depthY = 0;
  ctx.beginPath();
  ctx.moveTo(-3, depthY);
  ctx.lineTo(0, depthY);
  ctx.lineTo(ts(bldgH), depthY);
  ctx.lineTo(ts(bldgH), depthY - 3);
  ctx.stroke();

  ctx.fillStyle = "#7a7066";
  ctx.font = "8px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${bldgH.toFixed(2)}m`, ts(bldgH / 2), depthY - 6);

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
