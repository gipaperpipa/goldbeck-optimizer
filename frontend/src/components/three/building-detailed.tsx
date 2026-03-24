"use client";

import { useMemo } from "react";
import * as THREE from "three";
import type {
  BuildingFootprint,
  BuildingFloorPlans,
  WallSegment,
  WindowPlacement,
  DoorPlacement,
} from "@/types/api";

// ─── Colors ────────────────────────────────────────────────────────────
const WALL_COLORS: Record<string, string> = {
  bearing_cross: "#d6d3d1",
  corridor: "#d6d3d1",
  outer_long: "#e7e5e4",
  gable_end: "#d6d3d1",
  staircase: "#d6d3d1",
  elevator_shaft: "#a8a29e",
  partition: "#f5f5f4",
  apt_separation: "#e7e5e4",
};

const SLAB_COLOR = "#c4b5a3";
const WINDOW_GLASS = "#93c5fd";
const WINDOW_FRAME = "#64748b";
const DOOR_COLOR = "#92400e";
const DOOR_ENTRANCE = "#7c2d12";

// ─── Helper: build wall mesh with door/window openings ────────────────
function createWallGeometry(
  wall: WallSegment,
  wallHeight: number,
  doors: DoorPlacement[],
  windows: WindowPlacement[],
): THREE.BufferGeometry {
  // Wall direction and dimensions
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const wallLength = Math.sqrt(dx * dx + dy * dy);

  if (wallLength < 0.01) {
    return new THREE.BufferGeometry();
  }

  // Use CSG-like approach: create wall as extruded shape with holes
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(wallLength, 0);
  shape.lineTo(wallLength, wallHeight);
  shape.lineTo(0, wallHeight);
  shape.closePath();

  // Project door/window positions onto wall's local axis
  const dirX = dx / wallLength;
  const dirY = dy / wallLength;

  // Cut window openings
  for (const win of windows) {
    const px = win.position.x - wall.start.x;
    const py = win.position.y - wall.start.y;
    const localX = px * dirX + py * dirY;
    const halfW = win.width_m / 2;
    const sill = win.sill_height_m;
    const top = sill + win.height_m;

    const hole = new THREE.Path();
    hole.moveTo(localX - halfW, sill);
    hole.lineTo(localX + halfW, sill);
    hole.lineTo(localX + halfW, top);
    hole.lineTo(localX - halfW, top);
    hole.closePath();
    shape.holes.push(hole);
  }

  // Cut door openings
  for (const door of doors) {
    const px = door.position.x - wall.start.x;
    const py = door.position.y - wall.start.y;
    const localX = px * dirX + py * dirY;
    const halfW = door.width_m / 2;

    const hole = new THREE.Path();
    hole.moveTo(localX - halfW, 0);
    hole.lineTo(localX + halfW, 0);
    hole.lineTo(localX + halfW, door.height_m);
    hole.lineTo(localX - halfW, door.height_m);
    hole.closePath();
    shape.holes.push(hole);
  }

  // Extrude to wall thickness
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: wall.thickness_m,
    bevelEnabled: false,
  });

  return geom;
}

// ─── Single wall component ────────────────────────────────────────────
function Wall3D({
  wall,
  wallHeight,
  yOffset,
  doors,
  windows,
}: {
  wall: WallSegment;
  wallHeight: number;
  yOffset: number;
  doors: DoorPlacement[];
  windows: WindowPlacement[];
}) {
  const { geometry, position, rotation } = useMemo(() => {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const wallLength = Math.sqrt(dx * dx + dy * dy);

    if (wallLength < 0.01) {
      return {
        geometry: new THREE.BufferGeometry(),
        position: new THREE.Vector3(),
        rotation: 0,
      };
    }

    const angle = Math.atan2(dy, dx);
    const geom = createWallGeometry(wall, wallHeight, doors, windows);

    // Position at wall start, offset by half thickness perpendicular
    const pos = new THREE.Vector3(
      wall.start.x,
      yOffset,
      -wall.start.y,
    );

    return { geometry: geom, position: pos, rotation: angle };
  }, [wall, wallHeight, yOffset, doors, windows]);

  const color = WALL_COLORS[wall.wall_type] || "#d6d3d1";

  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Offset perpendicular so wall is centered on its axis */}
      <group position={[0, 0, -wall.thickness_m / 2]}>
        <mesh geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color={color}
            roughness={0.85}
            metalness={0.05}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

// ─── Window glass pane ────────────────────────────────────────────────
function Window3D({
  window: win,
  wall,
  yOffset,
}: {
  window: WindowPlacement;
  wall: WallSegment | undefined;
  yOffset: number;
}) {
  if (!wall) return null;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const wallLength = Math.sqrt(dx * dx + dy * dy);
  if (wallLength < 0.01) return null;

  const angle = Math.atan2(dy, dx);
  const centerY = yOffset + win.sill_height_m + win.height_m / 2;

  return (
    <group
      position={[win.position.x, centerY, -win.position.y]}
      rotation={[0, -angle, 0]}
    >
      {/* Glass pane */}
      <mesh>
        <planeGeometry args={[win.width_m - 0.06, win.height_m - 0.06]} />
        <meshPhysicalMaterial
          color={WINDOW_GLASS}
          transparent
          opacity={0.35}
          roughness={0.05}
          metalness={0.1}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Frame */}
      <lineSegments>
        <edgesGeometry
          args={[new THREE.PlaneGeometry(win.width_m, win.height_m)]}
        />
        <lineBasicMaterial color={WINDOW_FRAME} />
      </lineSegments>
    </group>
  );
}

// ─── Door panel ───────────────────────────────────────────────────────
function Door3D({
  door,
  wall,
  yOffset,
}: {
  door: DoorPlacement;
  wall: WallSegment | undefined;
  yOffset: number;
}) {
  if (!wall) return null;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const wallLength = Math.sqrt(dx * dx + dy * dy);
  if (wallLength < 0.01) return null;

  const angle = Math.atan2(dy, dx);
  const centerY = yOffset + door.height_m / 2;
  const color = door.is_entrance ? DOOR_ENTRANCE : DOOR_COLOR;

  return (
    <group
      position={[door.position.x, centerY, -door.position.y]}
      rotation={[0, -angle, 0]}
    >
      <mesh>
        <planeGeometry args={[door.width_m - 0.04, door.height_m - 0.02]} />
        <meshStandardMaterial
          color={color}
          roughness={0.6}
          metalness={0.05}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// ─── Slab (floor plate) ──────────────────────────────────────────────
function Slab3D({
  width,
  depth,
  yOffset,
  originX,
  originZ,
}: {
  width: number;
  depth: number;
  yOffset: number;
  originX: number;
  originZ: number;
}) {
  const THICKNESS = 0.24;
  return (
    <mesh
      position={[originX + width / 2, yOffset - THICKNESS / 2, -(originZ + depth / 2)]}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[width, THICKNESS, depth]} />
      <meshStandardMaterial color={SLAB_COLOR} roughness={0.8} metalness={0.05} />
    </mesh>
  );
}

// ─── Main detailed building component ────────────────────────────────
interface BuildingDetailedProps {
  building: BuildingFootprint;
  floorPlans: BuildingFloorPlans | undefined;
  index: number;
  showLabel?: boolean;
  sectionBoxY?: number | null; // Y-level to clip at (null = no clip)
}

export function BuildingDetailed({
  building,
  floorPlans,
  index,
  showLabel = true,
  sectionBoxY = null,
}: BuildingDetailedProps) {
  const rotationRad = (building.rotation_deg * Math.PI) / 180;

  const hasPlans = !!(floorPlans && floorPlans.floor_plans.length);
  const plans = hasPlans ? floorPlans!.floor_plans : [];
  const storyHeight = hasPlans
    ? (floorPlans!.story_height_m || building.floor_height_m)
    : building.floor_height_m;

  // Build a wall-id lookup for each floor plan (must be before any return)
  const wallMaps = useMemo(() => {
    return plans.map((fp) => {
      const map = new Map<string, WallSegment>();
      fp.walls.forEach((w) => map.set(w.id, w));
      return map;
    });
  }, [plans]);

  // Helper: find nearest wall to a point (geometric matching, not ID-based)
  const findNearestWall = (
    pos: { x: number; y: number },
    walls: WallSegment[],
  ): WallSegment | undefined => {
    let best: WallSegment | undefined;
    let bestDist = Infinity;
    for (const wall of walls) {
      const sx = wall.start.x, sy = wall.start.y;
      const ex = wall.end.x, ey = wall.end.y;
      const ddx = ex - sx, ddy = ey - sy;
      const lenSq = ddx * ddx + ddy * ddy;
      if (lenSq < 0.001) continue;
      const t = Math.max(0, Math.min(1, ((pos.x - sx) * ddx + (pos.y - sy) * ddy) / lenSq));
      const projX = sx + t * ddx, projY = sy + t * ddy;
      const dist = Math.hypot(pos.x - projX, pos.y - projY);
      if (dist < bestDist) { bestDist = dist; best = wall; }
    }
    return best;
  };

  // Determine which floors to show based on section box
  const visibleFloors = useMemo(() => {
    if (sectionBoxY === null) return plans;
    return plans.filter((fp) => {
      const floorTop = (fp.floor_index + 1) * storyHeight;
      return floorTop <= sectionBoxY;
    });
  }, [plans, sectionBoxY, storyHeight]);

  // If no floor plans, fall back to simple box
  if (!hasPlans) {
    return <SimpleBuildingFallback building={building} index={index} showLabel={showLabel} sectionBoxY={sectionBoxY} />;
  }

  return (
    <group
      position={[building.position_x, 0, -building.position_y]}
      rotation={[0, rotationRad, 0]}
    >
      {visibleFloors.map((fp, fpIdx) => {
        const yOffset = fp.floor_index * storyHeight;
        const wallMap = wallMaps[fpIdx] || new Map();

        // Match doors and windows to walls GEOMETRICALLY (nearest wall)
        // The symbolic wall_id on doors/windows is unreliable, so we use
        // perpendicular distance to find the host wall — same as the IFC exporter.
        const doorsByWall = new Map<string, DoorPlacement[]>();
        const windowsByWall = new Map<string, WindowPlacement[]>();
        fp.doors.forEach((d) => {
          const nearWall = findNearestWall(d.position, fp.walls);
          if (nearWall) {
            const arr = doorsByWall.get(nearWall.id) || [];
            arr.push(d);
            doorsByWall.set(nearWall.id, arr);
          }
        });
        fp.windows.forEach((w) => {
          const nearWall = findNearestWall(w.position, fp.walls);
          if (nearWall) {
            const arr = windowsByWall.get(nearWall.id) || [];
            arr.push(w);
            windowsByWall.set(nearWall.id, arr);
          }
        });

        // Per-floor slab dimensions (supports Staffelgeschoss setback floors)
        const floorW = fp.structural_grid?.building_length_m || floorPlans.building_width_m;
        const floorD = fp.structural_grid?.building_depth_m || floorPlans.building_depth_m;
        const gridOriginX = fp.structural_grid?.origin?.x || 0;
        const gridOriginY = fp.structural_grid?.origin?.y || 0;

        return (
          <group key={fp.floor_index}>
            {/* Slab — sized to per-floor grid (Staffelgeschoss has smaller slab) */}
            <Slab3D
              width={floorW}
              depth={floorD}
              yOffset={yOffset}
              originX={gridOriginX - floorPlans.building_width_m / 2}
              originZ={gridOriginY - floorPlans.building_depth_m / 2}
            />

            {/* Walls with openings */}
            {fp.walls.map((wall) => (
              <Wall3D
                key={wall.id}
                wall={{
                  ...wall,
                  // Offset wall coords to center building on origin
                  start: {
                    x: wall.start.x - floorPlans.building_width_m / 2,
                    y: wall.start.y - floorPlans.building_depth_m / 2,
                  },
                  end: {
                    x: wall.end.x - floorPlans.building_width_m / 2,
                    y: wall.end.y - floorPlans.building_depth_m / 2,
                  },
                }}
                wallHeight={storyHeight}
                yOffset={yOffset}
                doors={(doorsByWall.get(wall.id) || []).map((d) => ({
                  ...d,
                  position: {
                    x: d.position.x - floorPlans.building_width_m / 2,
                    y: d.position.y - floorPlans.building_depth_m / 2,
                  },
                }))}
                windows={(windowsByWall.get(wall.id) || []).map((w) => ({
                  ...w,
                  position: {
                    x: w.position.x - floorPlans.building_width_m / 2,
                    y: w.position.y - floorPlans.building_depth_m / 2,
                  },
                }))}
              />
            ))}

            {/* Window glass panes */}
            {fp.windows.map((win) => {
              const w = findNearestWall(win.position, fp.walls);
              const offsetWall = w ? {
                ...w,
                start: { x: w.start.x - floorPlans.building_width_m / 2, y: w.start.y - floorPlans.building_depth_m / 2 },
                end: { x: w.end.x - floorPlans.building_width_m / 2, y: w.end.y - floorPlans.building_depth_m / 2 },
              } : undefined;
              return (
                <Window3D
                  key={win.id}
                  window={{
                    ...win,
                    position: {
                      x: win.position.x - floorPlans.building_width_m / 2,
                      y: win.position.y - floorPlans.building_depth_m / 2,
                    },
                  }}
                  wall={offsetWall}
                  yOffset={yOffset}
                />
              );
            })}

            {/* Door panels */}
            {fp.doors.map((door) => {
              const w = findNearestWall(door.position, fp.walls);
              const offsetWall = w ? {
                ...w,
                start: { x: w.start.x - floorPlans.building_width_m / 2, y: w.start.y - floorPlans.building_depth_m / 2 },
                end: { x: w.end.x - floorPlans.building_width_m / 2, y: w.end.y - floorPlans.building_depth_m / 2 },
              } : undefined;
              return (
                <Door3D
                  key={door.id}
                  door={{
                    ...door,
                    position: {
                      x: door.position.x - floorPlans.building_width_m / 2,
                      y: door.position.y - floorPlans.building_depth_m / 2,
                    },
                  }}
                  wall={offsetWall}
                  yOffset={yOffset}
                />
              );
            })}
          </group>
        );
      })}

      {/* Roof slab */}
      {sectionBoxY === null && (
        <Slab3D
          width={floorPlans.building_width_m}
          depth={floorPlans.building_depth_m}
          yOffset={building.stories * storyHeight}
          originX={-floorPlans.building_width_m / 2}
          originZ={-floorPlans.building_depth_m / 2}
        />
      )}

      {/* Label */}
      {showLabel && (
        <group position={[0, building.total_height_m + 5, 0]}>
          <mesh>
            <planeGeometry args={[0, 0]} />
          </mesh>
        </group>
      )}
    </group>
  );
}

// ─── Fallback: simple box when no floor plan data available ──────────
// Renders per-floor boxes so section box clipping works for simple buildings too.
function SimpleBuildingFallback({
  building,
  index,
  showLabel,
  sectionBoxY,
}: {
  building: BuildingFootprint;
  index: number;
  showLabel: boolean;
  sectionBoxY?: number | null;
}) {
  const BUILDING_COLORS = [
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
    "#ec4899", "#06b6d4", "#f97316",
  ];
  const color = BUILDING_COLORS[index % BUILDING_COLORS.length];
  const rotationRad = (building.rotation_deg * Math.PI) / 180;
  const floorHeight = building.floor_height_m || 2.9;

  // Determine visible stories based on section box
  const totalStories = building.stories || 1;
  const visibleStories = sectionBoxY !== null && sectionBoxY !== undefined
    ? Math.min(totalStories, Math.floor(sectionBoxY / floorHeight))
    : totalStories;
  const clippedHeight = visibleStories * floorHeight;

  if (visibleStories <= 0) return null;

  return (
    <group
      position={[building.position_x, clippedHeight / 2, -building.position_y]}
      rotation={[0, rotationRad, 0]}
    >
      <mesh castShadow receiveShadow>
        <boxGeometry args={[building.width_m, clippedHeight, building.depth_m]} />
        <meshStandardMaterial color={color} transparent opacity={0.75} roughness={0.7} metalness={0.1} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(building.width_m, clippedHeight, building.depth_m)]} />
        <lineBasicMaterial color="#1e293b" linewidth={1} />
      </lineSegments>
    </group>
  );
}
