/**
 * Furniture feasibility overlay (Phase 4.1).
 *
 * For each room, returns a DIN-compliant furniture layout that answers
 * the architect's core question: "does the minimum functional furniture
 * for this room type actually fit?" Drawn as semi-transparent silhouettes
 * with labels on the 2D viewer canvas.
 *
 * Dimensions follow DIN 18011 (residential furniture sizing) and DIN 18040-2
 * (barrier-free access clearances). Silhouettes are conservative — real-world
 * furniture is typically slightly smaller, but rooms that can't fit these
 * minimums will feel cramped.
 *
 * Algorithm is axis-aligned rectangle packing:
 *   1. Infer room bbox (rooms are axis-aligned rectangles in Goldbeck output)
 *   2. Mark door swing clearances and window-wall zones as "no-furniture"
 *   3. Pick a layout template based on room_type + room size class
 *   4. Place furniture rectangles against walls in priority order
 *   5. Return placements or mark `fitted=false` if minimum layout fails
 *
 * Non-rectangular rooms (Wohnküche merge results, odd polygons) skip
 * placement and return `fitted=false` so the viewer shows no furniture
 * (graceful degrade — the user can still see the room).
 */

import type {
  FloorPlan,
  FloorPlanRoom,
  DoorPlacement,
  WindowPlacement,
  Point2D,
} from "@/types/api";

// ── Constants ─────────────────────────────────────────────────────

/** How far from a door center we reserve for swing + approach clearance. */
const DOOR_CLEARANCE_M = 0.80;
/** Window-wall clearance — don't block window with tall furniture. */
const WINDOW_CLEARANCE_M = 0.15;
/** Buffer between a piece of furniture and walls (avoid visual overlap). */
const WALL_GAP_M = 0.05;
/** Buffer between two pieces of furniture. */
const PIECE_GAP_M = 0.10;

export type FurnitureKind =
  | "bed_double"
  | "bed_single"
  | "nightstand"
  | "wardrobe"
  | "sofa"
  | "coffee_table"
  | "tv_unit"
  | "dining_table"
  | "kitchen_counter"
  | "kitchen_island"
  | "fridge"
  | "wc"
  | "sink"
  | "shower"
  | "bathtub"
  | "desk"
  | "chair";

export interface FurniturePlacement {
  kind: FurnitureKind;
  /** Lower-left corner in plan coordinates (meters). */
  x: number;
  y: number;
  /** Footprint dimensions. `width_m` follows the local X axis; rotation
   *  around the centroid is baked in via (x, y, width_m, depth_m). For v1
   *  we only emit axis-aligned placements. */
  width_m: number;
  depth_m: number;
  /** German label for the drawing (optional — falls back to kind). */
  label?: string;
}

export interface RoomFurnitureResult {
  roomId: string;
  /** True when the minimum required pieces for the room_type fit.
   *  Callers use this to emit a "doesn't furnish" warning. */
  fitted: boolean;
  placements: FurniturePlacement[];
  /** Short explanation when `fitted=false` (e.g. "Bett + Kleiderschrank
   *  passen nicht gleichzeitig"). Displayed in the Inspector readout. */
  reason?: string;
}

/** Standard furniture dimensions (meters). `w` = along local X, `d` = depth. */
const DIMS: Record<FurnitureKind, { w: number; d: number; label: string }> = {
  bed_double:       { w: 1.80, d: 2.00, label: "Bett 180" },
  bed_single:       { w: 0.90, d: 2.00, label: "Bett 90" },
  nightstand:       { w: 0.45, d: 0.40, label: "NT" },
  wardrobe:         { w: 2.00, d: 0.60, label: "Schrank" },
  sofa:             { w: 2.10, d: 0.90, label: "Sofa" },
  coffee_table:     { w: 1.10, d: 0.60, label: "Couchtisch" },
  tv_unit:          { w: 1.60, d: 0.45, label: "TV" },
  dining_table:     { w: 1.40, d: 0.80, label: "Esstisch" },
  kitchen_counter:  { w: 3.00, d: 0.60, label: "Küche" },
  kitchen_island:   { w: 1.80, d: 0.90, label: "Kochinsel" },
  fridge:           { w: 0.60, d: 0.65, label: "Kühl" },
  wc:               { w: 0.40, d: 0.60, label: "WC" },
  sink:             { w: 0.60, d: 0.50, label: "WT" },
  shower:           { w: 0.90, d: 0.90, label: "Dusche" },
  bathtub:          { w: 1.70, d: 0.75, label: "Wanne" },
  desk:             { w: 1.40, d: 0.60, label: "Schreibt." },
  chair:            { w: 0.45, d: 0.45, label: "" },
};

// ── Geometry helpers ──────────────────────────────────────────────

interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  depth: number;
}

function roomBBox(room: FloorPlanRoom): BBox | null {
  if (!room.polygon || room.polygon.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of room.polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, depth: maxY - minY };
}

function isAxisAlignedRect(room: FloorPlanRoom, bbox: BBox): boolean {
  if (room.polygon.length !== 4) return false;
  const tol = 0.05;
  let hitsMinX = 0, hitsMaxX = 0, hitsMinY = 0, hitsMaxY = 0;
  for (const p of room.polygon) {
    if (Math.abs(p.x - bbox.minX) < tol) hitsMinX++;
    if (Math.abs(p.x - bbox.maxX) < tol) hitsMaxX++;
    if (Math.abs(p.y - bbox.minY) < tol) hitsMinY++;
    if (Math.abs(p.y - bbox.maxY) < tol) hitsMaxY++;
  }
  return hitsMinX === 2 && hitsMaxX === 2 && hitsMinY === 2 && hitsMaxY === 2;
}

/** Rectangles on a wall: door clearance zones and window zones. */
interface WallZone {
  /** Position along the wall axis (0 = start of wall). */
  start: number;
  end: number;
}

/** Returns no-go zones along each of the four walls of an axis-aligned
 *  rectangular room: {south, north, west, east} = {minY, maxY, minX, maxX}.
 *  Each zone is projected onto the wall's parametric 1D axis. */
function collectDoorZones(
  bbox: BBox,
  doors: DoorPlacement[],
  windows: WindowPlacement[],
): { south: WallZone[]; north: WallZone[]; west: WallZone[]; east: WallZone[] } {
  const south: WallZone[] = [];
  const north: WallZone[] = [];
  const west: WallZone[] = [];
  const east: WallZone[] = [];
  const onWallTol = 0.20;

  const addZone = (side: WallZone[], center: number, halfWidth: number) => {
    side.push({ start: center - halfWidth, end: center + halfWidth });
  };

  for (const d of doors) {
    const halfW = d.width_m / 2 + DOOR_CLEARANCE_M;
    if (Math.abs(d.position.y - bbox.minY) < onWallTol) addZone(south, d.position.x, halfW);
    else if (Math.abs(d.position.y - bbox.maxY) < onWallTol) addZone(north, d.position.x, halfW);
    else if (Math.abs(d.position.x - bbox.minX) < onWallTol) addZone(west, d.position.y, halfW);
    else if (Math.abs(d.position.x - bbox.maxX) < onWallTol) addZone(east, d.position.y, halfW);
  }
  for (const w of windows) {
    const halfW = w.width_m / 2 + WINDOW_CLEARANCE_M;
    if (Math.abs(w.position.y - bbox.minY) < onWallTol) addZone(south, w.position.x, halfW);
    else if (Math.abs(w.position.y - bbox.maxY) < onWallTol) addZone(north, w.position.x, halfW);
    else if (Math.abs(w.position.x - bbox.minX) < onWallTol) addZone(west, w.position.y, halfW);
    else if (Math.abs(w.position.x - bbox.maxX) < onWallTol) addZone(east, w.position.y, halfW);
  }
  return { south, north, west, east };
}

/** True if the rectangle [rs, re] overlaps any zone. */
function intersectsZone(rs: number, re: number, zones: WallZone[]): boolean {
  for (const z of zones) {
    if (re > z.start && rs < z.end) return true;
  }
  return false;
}

/** Cast a single piece of furniture against a wall run. `along` = local
 *  axis along the wall (x for N/S walls, y for E/W). Returns the first
 *  clear interval [start, end] at least `width` long, or null. */
function findClearRun(
  axisMin: number,
  axisMax: number,
  width: number,
  zones: WallZone[],
  preferredStart?: number,
): number | null {
  // Sort zones and walk the gaps
  const sorted = [...zones].sort((a, b) => a.start - b.start);
  const candidates: Array<[number, number]> = [];
  let cursor = axisMin;
  for (const z of sorted) {
    if (z.start > cursor) candidates.push([cursor, z.start]);
    cursor = Math.max(cursor, z.end);
  }
  if (cursor < axisMax) candidates.push([cursor, axisMax]);
  // Pick the candidate nearest preferredStart whose length ≥ width
  let best: number | null = null;
  let bestDist = Infinity;
  for (const [a, b] of candidates) {
    if (b - a < width) continue;
    const start = preferredStart ?? a;
    const clamped = Math.min(Math.max(start, a), b - width);
    const dist = Math.abs(clamped - (preferredStart ?? a));
    if (dist < bestDist) {
      bestDist = dist;
      best = clamped;
    }
  }
  return best;
}

/** Record the bbox of a placed piece as a zone on each orthogonal wall —
 *  simplified interior-collision tracking for pieces that extend from a wall. */
interface PlacedRect { x: number; y: number; w: number; d: number }

function rectIntersects(a: PlacedRect, b: PlacedRect): boolean {
  return (
    a.x < b.x + b.w + PIECE_GAP_M &&
    a.x + a.w + PIECE_GAP_M > b.x &&
    a.y < b.y + b.d + PIECE_GAP_M &&
    a.y + a.d + PIECE_GAP_M > b.y
  );
}

function fitsInBox(rect: PlacedRect, bbox: BBox): boolean {
  return (
    rect.x >= bbox.minX + WALL_GAP_M &&
    rect.y >= bbox.minY + WALL_GAP_M &&
    rect.x + rect.w <= bbox.maxX - WALL_GAP_M &&
    rect.y + rect.d <= bbox.maxY - WALL_GAP_M
  );
}

function noCollision(rect: PlacedRect, placed: PlacedRect[]): boolean {
  return !placed.some((p) => rectIntersects(rect, p));
}

// ── Per-room-type placement templates ─────────────────────────────

type Placer = (
  room: FloorPlanRoom,
  bbox: BBox,
  doorZones: ReturnType<typeof collectDoorZones>,
  windows: WindowPlacement[],
) => { placements: FurniturePlacement[]; fitted: boolean; reason?: string };

function placement(
  kind: FurnitureKind,
  x: number,
  y: number,
  w: number,
  d: number,
): FurniturePlacement {
  return { kind, x, y, width_m: w, depth_m: d, label: DIMS[kind].label };
}

/** Place a bedroom: bed against a long interior wall (not a window wall),
 *  nightstands flanking it, wardrobe on the opposite wall. */
const placeBedroom: Placer = (room, bbox, doorZones, windows) => {
  const placements: FurniturePlacement[] = [];
  const placed: PlacedRect[] = [];

  // Identify which walls have windows — bed head shouldn't be under a window.
  const windowWalls = new Set<"south" | "north" | "west" | "east">();
  for (const w of windows) {
    if (Math.abs(w.position.y - bbox.minY) < 0.2) windowWalls.add("south");
    else if (Math.abs(w.position.y - bbox.maxY) < 0.2) windowWalls.add("north");
    else if (Math.abs(w.position.x - bbox.minX) < 0.2) windowWalls.add("west");
    else if (Math.abs(w.position.x - bbox.maxX) < 0.2) windowWalls.add("east");
  }

  const bed = DIMS.bed_double;
  const ns = DIMS.nightstand;
  const wardrobe = DIMS.wardrobe;

  // Decide orientation: prefer putting bed against a wall parallel to the
  // LONG dimension so nightstands flank it along that wall.
  const horizontalWalls = [
    { name: "south" as const, y: bbox.minY + WALL_GAP_M, dir: 1 },
    { name: "north" as const, y: bbox.maxY - bed.d - WALL_GAP_M, dir: -1 },
  ];
  const verticalWalls = [
    { name: "west" as const, x: bbox.minX + WALL_GAP_M, dir: 1 },
    { name: "east" as const, x: bbox.maxX - bed.d - WALL_GAP_M, dir: -1 },
  ];

  // Try horizontal walls first (bed rotated to lie along X): requires
  // bbox.width >= bed_w + 2*nightstand_w and bbox.depth >= bed_d + wardrobe_d + PIECE_GAP
  const canHorizontal =
    bbox.width >= bed.w + 2 * ns.w + 2 * PIECE_GAP_M &&
    bbox.depth >= bed.d + wardrobe.d + PIECE_GAP_M;

  // Vertical orientation (bed lies along Y): width ≥ wardrobe_d + bed_d, depth ≥ bed_w + 2*ns
  const canVertical =
    bbox.depth >= bed.w + 2 * ns.w + 2 * PIECE_GAP_M &&
    bbox.width >= bed.d + wardrobe.d + PIECE_GAP_M;

  if (canHorizontal) {
    const wall = horizontalWalls.find((w) => !windowWalls.has(w.name)) ?? horizontalWalls[0];
    const bedCenterX = bbox.minX + bbox.width / 2;
    const bedX = bedCenterX - bed.w / 2;
    const bedY = wall.y;
    const zones = wall.name === "south" ? doorZones.south : doorZones.north;
    if (!intersectsZone(bedX, bedX + bed.w, zones)) {
      const bedRect = { x: bedX, y: bedY, w: bed.w, d: bed.d };
      if (fitsInBox(bedRect, bbox)) {
        placed.push(bedRect);
        placements.push(placement("bed_double", bedX, bedY, bed.w, bed.d));
        // Nightstands flanking
        const ns1 = { x: bedX - ns.w - PIECE_GAP_M, y: bedY, w: ns.w, d: ns.d };
        if (fitsInBox(ns1, bbox) && noCollision(ns1, placed)) {
          placed.push(ns1);
          placements.push(placement("nightstand", ns1.x, ns1.y, ns.w, ns.d));
        }
        const ns2 = { x: bedX + bed.w + PIECE_GAP_M, y: bedY, w: ns.w, d: ns.d };
        if (fitsInBox(ns2, bbox) && noCollision(ns2, placed)) {
          placed.push(ns2);
          placements.push(placement("nightstand", ns2.x, ns2.y, ns.w, ns.d));
        }
        // Wardrobe on opposite wall
        const oppY = wall.name === "south" ? bbox.maxY - wardrobe.d - WALL_GAP_M : bbox.minY + WALL_GAP_M;
        const oppZones = wall.name === "south" ? doorZones.north : doorZones.south;
        const wardrobeStart = findClearRun(
          bbox.minX + WALL_GAP_M,
          bbox.maxX - WALL_GAP_M,
          wardrobe.w,
          oppZones,
          bbox.minX + (bbox.width - wardrobe.w) / 2,
        );
        if (wardrobeStart !== null) {
          const wRect = { x: wardrobeStart, y: oppY, w: wardrobe.w, d: wardrobe.d };
          if (fitsInBox(wRect, bbox) && noCollision(wRect, placed)) {
            placed.push(wRect);
            placements.push(placement("wardrobe", wRect.x, wRect.y, wardrobe.w, wardrobe.d));
          }
        }
        return { placements, fitted: true };
      }
    }
  }

  if (canVertical) {
    const wall = verticalWalls.find((w) => !windowWalls.has(w.name)) ?? verticalWalls[0];
    const bedCenterY = bbox.minY + bbox.depth / 2;
    const bedY = bedCenterY - bed.w / 2;
    const bedX = wall.x;
    const zones = wall.name === "west" ? doorZones.west : doorZones.east;
    if (!intersectsZone(bedY, bedY + bed.w, zones)) {
      const bedRect = { x: bedX, y: bedY, w: bed.d, d: bed.w };
      if (fitsInBox(bedRect, bbox)) {
        placed.push(bedRect);
        placements.push(placement("bed_double", bedX, bedY, bed.d, bed.w));
        // Nightstands along same wall (above/below bed)
        const ns1 = { x: bedX, y: bedY - ns.d - PIECE_GAP_M, w: ns.w, d: ns.d };
        if (fitsInBox(ns1, bbox) && noCollision(ns1, placed)) {
          placed.push(ns1);
          placements.push(placement("nightstand", ns1.x, ns1.y, ns.w, ns.d));
        }
        const ns2 = { x: bedX, y: bedY + bed.w + PIECE_GAP_M, w: ns.w, d: ns.d };
        if (fitsInBox(ns2, bbox) && noCollision(ns2, placed)) {
          placed.push(ns2);
          placements.push(placement("nightstand", ns2.x, ns2.y, ns.w, ns.d));
        }
        const oppX = wall.name === "west" ? bbox.maxX - wardrobe.d - WALL_GAP_M : bbox.minX + WALL_GAP_M;
        const oppZones = wall.name === "west" ? doorZones.east : doorZones.west;
        const wardrobeStart = findClearRun(
          bbox.minY + WALL_GAP_M,
          bbox.maxY - WALL_GAP_M,
          wardrobe.w,
          oppZones,
          bbox.minY + (bbox.depth - wardrobe.w) / 2,
        );
        if (wardrobeStart !== null) {
          const wRect = { x: oppX, y: wardrobeStart, w: wardrobe.d, d: wardrobe.w };
          if (fitsInBox(wRect, bbox) && noCollision(wRect, placed)) {
            placed.push(wRect);
            placements.push(placement("wardrobe", wRect.x, wRect.y, wardrobe.d, wardrobe.w));
          }
        }
        return { placements, fitted: true };
      }
    }
  }

  // Fallback: single bed only
  const single = DIMS.bed_single;
  if (bbox.width >= single.w + PIECE_GAP_M && bbox.depth >= single.d + WALL_GAP_M * 2) {
    const bedX = bbox.minX + WALL_GAP_M;
    const bedY = bbox.minY + WALL_GAP_M;
    placements.push(placement("bed_single", bedX, bedY, single.w, single.d));
    return {
      placements,
      fitted: false,
      reason: "Raum zu klein für Doppelbett — nur Einzelbett + minimaler Schrank",
    };
  }

  return {
    placements: [],
    fitted: false,
    reason: "Raum zu klein für Standard-Schlafzimmermöbel",
  };
};

/** Living room: sofa against the longest non-window wall, coffee table 0.6m
 *  in front, TV unit on opposite wall. */
const placeLiving: Placer = (room, bbox, doorZones, _windows) => {
  const placements: FurniturePlacement[] = [];
  const placed: PlacedRect[] = [];

  const sofa = DIMS.sofa;
  const coffee = DIMS.coffee_table;
  const tv = DIMS.tv_unit;
  const seatDist = 0.60; // sofa to coffee table

  // Try horizontal orientation (sofa along X)
  const canHorizontal =
    bbox.width >= sofa.w + 2 * WALL_GAP_M &&
    bbox.depth >= sofa.d + seatDist + coffee.d + 0.5 + tv.d + 2 * WALL_GAP_M;

  const canVertical =
    bbox.depth >= sofa.w + 2 * WALL_GAP_M &&
    bbox.width >= sofa.d + seatDist + coffee.d + 0.5 + tv.d + 2 * WALL_GAP_M;

  if (canHorizontal) {
    // Sofa against south wall (typically the interior one); TV on north
    const sofaY = bbox.minY + WALL_GAP_M;
    const sofaStart = findClearRun(
      bbox.minX + WALL_GAP_M,
      bbox.maxX - WALL_GAP_M,
      sofa.w,
      doorZones.south,
      bbox.minX + (bbox.width - sofa.w) / 2,
    );
    if (sofaStart !== null) {
      placed.push({ x: sofaStart, y: sofaY, w: sofa.w, d: sofa.d });
      placements.push(placement("sofa", sofaStart, sofaY, sofa.w, sofa.d));

      const ctX = sofaStart + (sofa.w - coffee.w) / 2;
      const ctY = sofaY + sofa.d + seatDist;
      const ctRect = { x: ctX, y: ctY, w: coffee.w, d: coffee.d };
      if (fitsInBox(ctRect, bbox) && noCollision(ctRect, placed)) {
        placed.push(ctRect);
        placements.push(placement("coffee_table", ctX, ctY, coffee.w, coffee.d));
      }
      const tvY = bbox.maxY - tv.d - WALL_GAP_M;
      const tvStart = findClearRun(
        bbox.minX + WALL_GAP_M,
        bbox.maxX - WALL_GAP_M,
        tv.w,
        doorZones.north,
        bbox.minX + (bbox.width - tv.w) / 2,
      );
      if (tvStart !== null) {
        const tvRect = { x: tvStart, y: tvY, w: tv.w, d: tv.d };
        if (fitsInBox(tvRect, bbox) && noCollision(tvRect, placed)) {
          placed.push(tvRect);
          placements.push(placement("tv_unit", tvStart, tvY, tv.w, tv.d));
        }
      }
      return { placements, fitted: true };
    }
  }

  if (canVertical) {
    const sofaX = bbox.minX + WALL_GAP_M;
    const sofaStart = findClearRun(
      bbox.minY + WALL_GAP_M,
      bbox.maxY - WALL_GAP_M,
      sofa.w,
      doorZones.west,
      bbox.minY + (bbox.depth - sofa.w) / 2,
    );
    if (sofaStart !== null) {
      placed.push({ x: sofaX, y: sofaStart, w: sofa.d, d: sofa.w });
      placements.push(placement("sofa", sofaX, sofaStart, sofa.d, sofa.w));

      const ctX = sofaX + sofa.d + seatDist;
      const ctY = sofaStart + (sofa.w - coffee.w) / 2;
      const ctRect = { x: ctX, y: ctY, w: coffee.d, d: coffee.w };
      if (fitsInBox(ctRect, bbox) && noCollision(ctRect, placed)) {
        placed.push(ctRect);
        placements.push(placement("coffee_table", ctX, ctY, coffee.d, coffee.w));
      }
      const tvX = bbox.maxX - tv.d - WALL_GAP_M;
      const tvStart = findClearRun(
        bbox.minY + WALL_GAP_M,
        bbox.maxY - WALL_GAP_M,
        tv.w,
        doorZones.east,
        bbox.minY + (bbox.depth - tv.w) / 2,
      );
      if (tvStart !== null) {
        const tvRect = { x: tvX, y: tvStart, w: tv.d, d: tv.w };
        if (fitsInBox(tvRect, bbox) && noCollision(tvRect, placed)) {
          placed.push(tvRect);
          placements.push(placement("tv_unit", tvX, tvStart, tv.d, tv.w));
        }
      }
      return { placements, fitted: true };
    }
  }

  // Size too small: just put a 2-seat sofa
  const smallSofa = { w: 1.60, d: 0.90 };
  if (bbox.width >= smallSofa.w + 2 * WALL_GAP_M && bbox.depth >= smallSofa.d + 1.5) {
    const sx = bbox.minX + (bbox.width - smallSofa.w) / 2;
    const sy = bbox.minY + WALL_GAP_M;
    placements.push(placement("sofa", sx, sy, smallSofa.w, smallSofa.d));
    return {
      placements,
      fitted: false,
      reason: "Nur für 2-Sitzer + Sessel — kein Couchtisch-Platz",
    };
  }

  return { placements: [], fitted: false, reason: "Raum zu klein für Wohnzimmermöbel" };
};

/** Kitchen: L-shaped or I-shaped counter against the longest wall, fridge,
 *  dining table in the remaining open area. Wohnküche (room type "living"
 *  with area ≥ 20m²) uses this layout plus a sofa grouping. */
const placeKitchen: Placer = (room, bbox, doorZones) => {
  const placements: FurniturePlacement[] = [];
  const placed: PlacedRect[] = [];
  const counter = DIMS.kitchen_counter;
  const fridge = DIMS.fridge;
  const table = DIMS.dining_table;

  // Pick the longest wall without a door in the middle run
  const southRun = findClearRun(bbox.minX + WALL_GAP_M, bbox.maxX - WALL_GAP_M, counter.w, doorZones.south);
  const northRun = findClearRun(bbox.minX + WALL_GAP_M, bbox.maxX - WALL_GAP_M, counter.w, doorZones.north);
  const westRun = findClearRun(bbox.minY + WALL_GAP_M, bbox.maxY - WALL_GAP_M, counter.w, doorZones.west);
  const eastRun = findClearRun(bbox.minY + WALL_GAP_M, bbox.maxY - WALL_GAP_M, counter.w, doorZones.east);

  let counterPlaced = false;
  // Prefer horizontal walls if width ≥ counter.w
  if (bbox.width >= counter.w + 2 * WALL_GAP_M && southRun !== null) {
    const cy = bbox.minY + WALL_GAP_M;
    placed.push({ x: southRun, y: cy, w: counter.w, d: counter.d });
    placements.push(placement("kitchen_counter", southRun, cy, counter.w, counter.d));
    // Fridge adjacent
    const fx = southRun + counter.w + PIECE_GAP_M;
    const fr = { x: fx, y: cy, w: fridge.w, d: fridge.d };
    if (fitsInBox(fr, bbox) && noCollision(fr, placed)) {
      placed.push(fr);
      placements.push(placement("fridge", fx, cy, fridge.w, fridge.d));
    }
    counterPlaced = true;
  } else if (bbox.width >= counter.w + 2 * WALL_GAP_M && northRun !== null) {
    const cy = bbox.maxY - counter.d - WALL_GAP_M;
    placed.push({ x: northRun, y: cy, w: counter.w, d: counter.d });
    placements.push(placement("kitchen_counter", northRun, cy, counter.w, counter.d));
    counterPlaced = true;
  } else if (bbox.depth >= counter.w + 2 * WALL_GAP_M && westRun !== null) {
    const cx = bbox.minX + WALL_GAP_M;
    placed.push({ x: cx, y: westRun, w: counter.d, d: counter.w });
    placements.push(placement("kitchen_counter", cx, westRun, counter.d, counter.w));
    counterPlaced = true;
  } else if (bbox.depth >= counter.w + 2 * WALL_GAP_M && eastRun !== null) {
    const cx = bbox.maxX - counter.d - WALL_GAP_M;
    placed.push({ x: cx, y: eastRun, w: counter.d, d: counter.w });
    placements.push(placement("kitchen_counter", cx, eastRun, counter.d, counter.w));
    counterPlaced = true;
  }

  if (!counterPlaced) {
    // Fall back to a short 2m counter
    const shortW = 2.0;
    const runs = [
      bbox.width >= shortW + 2 * WALL_GAP_M
        ? findClearRun(bbox.minX + WALL_GAP_M, bbox.maxX - WALL_GAP_M, shortW, doorZones.south)
        : null,
    ];
    if (runs[0] !== null) {
      const cy = bbox.minY + WALL_GAP_M;
      placed.push({ x: runs[0], y: cy, w: shortW, d: counter.d });
      placements.push(placement("kitchen_counter", runs[0], cy, shortW, counter.d));
      return {
        placements,
        fitted: false,
        reason: "Nur Küchenzeile 2m — kein 3m-Standard",
      };
    }
    return { placements: [], fitted: false, reason: "Kein Platz für Küchenzeile" };
  }

  // Dining table: if room area ≥ 8m² (small table ok), try to place in center
  if (room.area_sqm >= 8.0) {
    const tx = bbox.minX + (bbox.width - table.w) / 2;
    const ty = bbox.minY + (bbox.depth - table.d) / 2;
    const tRect = { x: tx, y: ty, w: table.w, d: table.d };
    if (fitsInBox(tRect, bbox) && noCollision(tRect, placed)) {
      placed.push(tRect);
      placements.push(placement("dining_table", tx, ty, table.w, table.d));
    }
  }

  return { placements, fitted: true };
};

/** Bathroom: WC against a short wall, sink adjacent, shower/bathtub on the
 *  opposite wall or corner. Simple greedy packing. */
const placeBathroom: Placer = (room, bbox) => {
  const placements: FurniturePlacement[] = [];
  const placed: PlacedRect[] = [];
  const wc = DIMS.wc;
  const sink = DIMS.sink;
  const shower = DIMS.shower;
  const tub = DIMS.bathtub;

  // Place WC at bottom-left
  const wcRect = { x: bbox.minX + WALL_GAP_M, y: bbox.minY + WALL_GAP_M, w: wc.w, d: wc.d };
  if (!fitsInBox(wcRect, bbox)) {
    return { placements: [], fitted: false, reason: "Raum zu klein für WC" };
  }
  placed.push(wcRect);
  placements.push(placement("wc", wcRect.x, wcRect.y, wc.w, wc.d));

  // Sink next to WC along bottom wall
  const sinkRect = {
    x: wcRect.x + wc.w + PIECE_GAP_M,
    y: bbox.minY + WALL_GAP_M,
    w: sink.w,
    d: sink.d,
  };
  if (fitsInBox(sinkRect, bbox) && noCollision(sinkRect, placed)) {
    placed.push(sinkRect);
    placements.push(placement("sink", sinkRect.x, sinkRect.y, sink.w, sink.d));
  }

  // Bathtub along top wall if space allows; else shower
  const tubY = bbox.maxY - tub.d - WALL_GAP_M;
  const tubRect = { x: bbox.minX + WALL_GAP_M, y: tubY, w: tub.w, d: tub.d };
  if (fitsInBox(tubRect, bbox) && noCollision(tubRect, placed)) {
    placed.push(tubRect);
    placements.push(placement("bathtub", tubRect.x, tubRect.y, tub.w, tub.d));
    return { placements, fitted: true };
  }
  const showerRect = { x: bbox.maxX - shower.w - WALL_GAP_M, y: bbox.maxY - shower.d - WALL_GAP_M, w: shower.w, d: shower.d };
  if (fitsInBox(showerRect, bbox) && noCollision(showerRect, placed)) {
    placed.push(showerRect);
    placements.push(placement("shower", showerRect.x, showerRect.y, shower.w, shower.d));
    return { placements, fitted: true };
  }

  return {
    placements,
    fitted: false,
    reason: "Keine Wanne/Dusche möglich — nur WC + WT",
  };
};

// ── Public API ────────────────────────────────────────────────────

/** Compute furniture placements for every placeable room in the plan.
 *  Returns a Map keyed by room.id. Rooms that can't be furnished (too small,
 *  non-rectangular, unsupported type) return `fitted=false` with zero or
 *  partial placements. */
export function placeFurnitureForPlan(plan: FloorPlan): Map<string, RoomFurnitureResult> {
  const results = new Map<string, RoomFurnitureResult>();

  for (const room of plan.rooms) {
    const bbox = roomBBox(room);
    if (!bbox) {
      results.set(room.id, { roomId: room.id, fitted: false, placements: [], reason: "Ungültiges Polygon" });
      continue;
    }
    // Only rectangular rooms are laid out. Non-rect rooms (merged Wohnküche
    // preserves bbox shape since we use bbox-union, so those still work;
    // true L-shapes would need per-alcove placement — deferred).
    if (!isAxisAlignedRect(room, bbox)) {
      results.set(room.id, { roomId: room.id, fitted: false, placements: [], reason: "Kein rechteckiger Grundriss" });
      continue;
    }

    const doorZones = collectDoorZones(bbox, plan.doors, plan.windows);

    let result: ReturnType<Placer>;
    switch (room.room_type) {
      case "living":
        // Wohnküche (living ≥ 20m² with no separate kitchen in the same
        // apartment) gets kitchen + sofa grouping. Otherwise straight living.
        {
          const apt = plan.apartments.find((a) => a.rooms.some((r) => r.id === room.id));
          const hasKitchen = apt?.rooms.some((r) => r.room_type === "kitchen") ?? false;
          if (room.area_sqm >= 20 && !hasKitchen) {
            // Wohnküche: try kitchen first, then layer a sofa if space remains
            result = placeKitchen(room, bbox, doorZones, plan.windows);
          } else {
            result = placeLiving(room, bbox, doorZones, plan.windows);
          }
        }
        break;
      case "bedroom":
        result = placeBedroom(room, bbox, doorZones, plan.windows);
        break;
      case "kitchen":
        result = placeKitchen(room, bbox, doorZones, plan.windows);
        break;
      case "bathroom":
        result = placeBathroom(room, bbox, doorZones, plan.windows);
        break;
      default:
        // hallway / storage / corridor / staircase / elevator / shaft / balcony — no furniture
        result = { placements: [], fitted: true };
        break;
    }

    results.set(room.id, {
      roomId: room.id,
      fitted: result.fitted,
      placements: result.placements,
      reason: result.reason,
    });
  }

  return results;
}

/** Visualisation color per category for the canvas overlay. */
export const FURNITURE_COLORS: Record<FurnitureKind, string> = {
  bed_double:      "#b38f6a", // warm brown
  bed_single:      "#b38f6a",
  nightstand:      "#8a6f55",
  wardrobe:        "#6f553f",
  sofa:            "#8a7a6a",
  coffee_table:    "#6f553f",
  tv_unit:         "#3e342a",
  dining_table:    "#8a6f55",
  kitchen_counter: "#6b7a8a",
  kitchen_island:  "#6b7a8a",
  fridge:          "#cfd5da",
  wc:              "#d9e4f0",
  sink:            "#b5c7d5",
  shower:          "#8faac5",
  bathtub:         "#8faac5",
  desk:            "#8a6f55",
  chair:           "#6f553f",
};

/** Centroid of a placement — used for label anchoring. */
export function placementCentroid(p: FurniturePlacement): Point2D {
  return { x: p.x + p.width_m / 2, y: p.y + p.depth_m / 2 };
}
