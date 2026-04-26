"use client";

import { Suspense, useEffect, useState, useCallback, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { OrbitControls, Environment, Grid, Text } from "@react-three/drei";
import { BuildingDetailed } from "./building-detailed";
import { GroundPlane } from "./ground-plane";
import { SunLight } from "./sun-light";
import { SectionBoxControls } from "./section-box";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import type { LayoutOption, PlotAnalysis, BuildingFloorPlans, BuildingFootprint } from "@/types/api";
import { API_BASE } from "@/lib/api-client";
import { estimateCost } from "@/lib/cost-estimator";
import { estimateThermal } from "@/lib/thermal-envelope";
import { placeFurnitureForPlan, type FurnitureKind } from "@/lib/furniture-layouts";
import {
  defaultSectionBox,
  normalizeSectionBox,
  planesForSectionBox,
  type SectionBox,
} from "@/lib/section-clip";

/** Aggregate furniture placements across every floor of a building into a
 *  flat `{kind: count}` dict for the IFC Pset_ADS_Furniture_DIN18011 pset.
 *  Only counts pieces that actually got placed (`fitted` rooms or partial
 *  fits still emit placements that landed successfully). */
function aggregateFurnitureCounts(building: BuildingFloorPlans): Record<string, number> {
  const counts: Partial<Record<FurnitureKind, number>> = {};
  for (const floor of building.floor_plans) {
    const perRoom = placeFurnitureForPlan(floor);
    for (const result of perRoom.values()) {
      for (const piece of result.placements) {
        counts[piece.kind] = (counts[piece.kind] ?? 0) + 1;
      }
    }
  }
  return counts as Record<string, number>;
}

/** Props for the 3D building scene (Three.js / R3F).
 * @property layout - The selected optimizer layout with building positions.
 * @property plot - Plot boundary polygon for ground-plane rendering.
 * @property sunPosition - Azimuth/altitude in degrees for directional light.
 * @property floorPlansMap - Per-building floor plans keyed by building_id,
 *   used to render detailed walls/windows/doors in the 3D view.
 */
interface Scene3DProps {
  layout: LayoutOption | null;
  plot?: PlotAnalysis | null;
  sunPosition?: { azimuth: number; altitude: number };
  floorPlansMap?: Record<string, BuildingFloorPlans>;
}

export function Scene3D({ layout, plot, sunPosition, floorPlansMap }: Scene3DProps) {
  // Default sun direction: northern hemisphere → sun from south, southern → from north
  const latitude = plot?.centroid_geo?.lat ?? 50; // Default to Germany
  const defaultSunZ = latitude >= 0 ? 200 : -200; // Flip Z for southern hemisphere
  const [showLabels, setShowLabels] = useState(true);
  // Phase 11a — section *box* (six bounds) replaces the old single
  // horizontal-cut sectionY. `null` means "no clipping, show
  // everything". Toggling on initialises the box from the scene's
  // tight bounds so the user can drag faces inward.
  const [sectionBox, setSectionBox] = useState<SectionBox | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  // Phase 8c / 8.6: §6 Abstandsflächen overlay + breakdown panel
  const [showAbstand, setShowAbstand] = useState(false);

  const handleExportIfc = useCallback(async (buildingId: string) => {
    if (!layout || !floorPlansMap?.[buildingId]) return;
    const building = layout.buildings.find((b) => b.id === buildingId);
    if (!building) return;

    setExporting(true);
    setExportStatus(null);
    try {
      const floorPlans = floorPlansMap[buildingId];

      // Phase 4.6 — enrich the IFC with cost, thermal, and furniture psets.
      // All three are best-effort: failures fall back to a minimal IFC so a
      // broken estimator can never block the export.
      let costMetadata: unknown = null;
      let thermalMetadata: unknown = null;
      let furnitureCounts: Record<string, number> | null = null;
      try {
        costMetadata = estimateCost({ building: floorPlans });
      } catch (e) {
        console.debug("cost metadata skipped:", e);
      }
      try {
        thermalMetadata = estimateThermal({ building: floorPlans, standard: "goldbeck_standard" });
      } catch (e) {
        console.debug("thermal metadata skipped:", e);
      }
      try {
        furnitureCounts = aggregateFurnitureCounts(floorPlans);
      } catch (e) {
        console.debug("furniture counts skipped:", e);
      }

      const response = await fetch(
        `${API_BASE}/v1/export/ifc`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            building,
            floor_plans: floorPlans,
            cost_metadata: costMetadata,
            thermal_metadata: thermalMetadata,
            furniture_counts: furnitureCounts,
          }),
        }
      );
      if (!response.ok) {
        const detail = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(detail.detail || `Export failed (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `building_${buildingId}.ifc`;
      a.click();
      URL.revokeObjectURL(url);
      setExportStatus({ type: "success", message: `IFC-Export erfolgreich: building_${buildingId}.ifc` });
      setTimeout(() => setExportStatus(null), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
      setExportStatus({ type: "error", message: `IFC-Export fehlgeschlagen: ${msg}` });
      setTimeout(() => setExportStatus(null), 6000);
    } finally {
      setExporting(false);
    }
  }, [layout, floorPlansMap]);

  // Phase 11a — these hooks have to live above the early return so
  // hooks order stays stable across renders. They're cheap when the
  // layout is null (empty buildings list).
  const sceneBounds = useMemo(
    () => defaultSectionBox(layout?.buildings ?? []),
    [layout?.buildings],
  );
  const clippingPlanes = useMemo(
    () => (sectionBox ? planesForSectionBox(sectionBox) : []),
    [sectionBox],
  );

  if (!layout) {
    return (
      <div className="w-full h-[clamp(300px,60vh,800px)] bg-neutral-100 rounded-lg flex items-center justify-center">
        <p className="text-neutral-500">Select a layout to view in 3D</p>
      </div>
    );
  }

  // Compute camera position from plot size
  const plotWidth = plot?.width_m || 200;
  const plotDepth = plot?.depth_m || 200;
  const cameraDistance = Math.max(plotWidth, plotDepth) * 1.2;

  const firstBuilding = layout.buildings[0];
  const storyHeight = firstBuilding?.floor_height_m || 2.9;
  const maxStories = Math.max(...layout.buildings.map((b) => b.stories), 1);

  // Check if any building has detailed floor plans
  const hasDetailedData = floorPlansMap && Object.keys(floorPlansMap).length > 0;

  return (
    <div className="relative w-full h-[clamp(300px,60vh,800px)] rounded-lg overflow-hidden border">
      {/* Top controls */}
      <div className="absolute top-3 left-3 z-10 flex gap-2">
        <Button
          size="sm"
          variant={showLabels ? "default" : "outline"}
          onClick={() => setShowLabels(!showLabels)}
        >
          Labels
        </Button>
        <Button
          size="sm"
          variant={showAbstand ? "default" : "outline"}
          onClick={() => setShowAbstand((v) => !v)}
          title="§6 Abstandsflächen ein-/ausblenden"
        >
          Abstandsflächen
        </Button>
        {/* IFC export buttons — only when floor plans exist */}
        {hasDetailedData && layout.buildings.map((b) =>
          floorPlansMap?.[b.id] ? (
            <Button
              key={b.id}
              size="sm"
              variant="outline"
              disabled={exporting}
              onClick={() => handleExportIfc(b.id)}
              className="bg-white/90"
            >
              <Download className="w-3.5 h-3.5 mr-1" />
              {exporting ? "Exporting..." : `IFC ${b.id.replace("bldg-", "B")}`}
            </Button>
          ) : null
        )}
      </div>

      {/* Phase 8.6 — §6 breakdown panel. Lists each building face with
          the formula and depth so the user can see exactly how the
          rendered envelope was computed. */}
      {showAbstand && layout.buildings.length > 0 && (
        <AbstandsflaechenBreakdownPanel buildings={layout.buildings} />
      )}

      {/* Export status toast */}
      {exportStatus && (
        <div className={`absolute top-14 left-3 z-20 px-3 py-2 rounded-md text-sm font-medium shadow-md ${
          exportStatus.type === "success"
            ? "bg-green-100 text-green-800 border border-green-200"
            : "bg-red-100 text-red-800 border border-red-200"
        }`}>
          {exportStatus.message}
        </div>
      )}

      {/* Section box controls — always shown when buildings exist */}
      <div className="absolute top-3 right-3 z-10">
        <SectionBoxControls
          bounds={sceneBounds}
          storyHeight={storyHeight}
          numStories={maxStories}
          box={sectionBox}
          onChange={(b) => setSectionBox(b ? normalizeSectionBox(b) : null)}
        />
      </div>

      <Canvas
        shadows
        gl={{ localClippingEnabled: true }}
        camera={{
          position: [cameraDistance * 0.6, cameraDistance * 0.5, cameraDistance * 0.6],
          fov: 50,
          near: 1,
          far: 5000,
        }}
      >
        <Suspense fallback={null}>
          <ambientLight intensity={0.4} />
          {sunPosition && sunPosition.altitude > 0 ? (
            <SunLight azimuth={sunPosition.azimuth} altitude={sunPosition.altitude} />
          ) : (
            <directionalLight
              castShadow
              position={[200, 300, defaultSunZ]}
              intensity={1.5}
              shadow-mapSize={[2048, 2048]}
              shadow-camera-far={1500}
              shadow-camera-left={-400}
              shadow-camera-right={400}
              shadow-camera-top={400}
              shadow-camera-bottom={-400}
            />
          )}

          {/* Ground */}
          <GroundPlane
            boundary={plot?.boundary_polygon_local || [[-100, -100], [100, -100], [100, 100], [-100, 100]]}
          />

          <Grid
            args={[500, 500]}
            position={[0, 0.01, 0]}
            cellSize={10}
            cellThickness={0.5}
            cellColor="#94a3b8"
            sectionSize={50}
            sectionThickness={1}
            sectionColor="#64748b"
            fadeDistance={500}
            fadeStrength={1}
          />

          {/* Phase 8c: §6 Abstandsflächen translucent ground projections —
              one rectangle per facade, depth = max(0.4·H, 3 m). Drawn at
              y = 0.02 to sit above the ground but below buildings. */}
          {showAbstand && layout.buildings.map((b) => (
            <AbstandsflaechenLayer3D key={`abst-${b.id}`} building={b} />
          ))}

          {/* Phase 11a — apply the section-box clipping planes to every
              material in the scene. `localClippingEnabled` (set on the
              renderer via Canvas's `gl` prop) lets each material's
              clipping respond — but here we use the global path
              (`renderer.clippingPlanes = planes`) so we don't have to
              thread the planes into every <meshStandardMaterial>. */}
          <SectionClipApplier planes={clippingPlanes} />

          {/* Buildings — detailed if floor plans exist, simple otherwise */}
          {layout.buildings.map((building, i) => (
            <BuildingDetailed
              key={building.id}
              building={building}
              floorPlans={floorPlansMap?.[building.id]}
              index={i}
              showLabel={showLabels}
            />
          ))}

          {/* Scale reference */}
          {showLabels && (
            <Text
              position={[0, 0.5, -(plotDepth / 2 + 20)]}
              fontSize={5}
              color="#64748b"
              anchorX="center"
            >
              {`${layout.buildings.length} buildings | ${layout.total_units} units | FAR ${layout.far_achieved.toFixed(2)}`}
            </Text>
          )}

          <OrbitControls
            makeDefault
            minDistance={20}
            maxDistance={cameraDistance * 3}
            maxPolarAngle={Math.PI / 2.1}
            enableDamping
          />
          <Environment preset="city" />
        </Suspense>
      </Canvas>

      {/* Legend — show building info for simple view, detailed for floor plans */}
      <div className="absolute bottom-3 left-3 bg-white/90 backdrop-blur-sm rounded-md border px-3 py-2 text-[10px] text-neutral-600 flex gap-4">
        {hasDetailedData ? (
          <>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm" style={{ background: "#d6d3d1" }} />
              Bearing Wall
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm" style={{ background: "#e7e5e4" }} />
              Ext. Wall
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm" style={{ background: "#93c5fd" }} />
              Window
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm" style={{ background: "#92400e" }} />
              Door
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-sm" style={{ background: SLAB_COLOR }} />
              Slab
            </span>
          </>
        ) : (
          <>
            <span className="text-neutral-500">
              {layout.buildings.length} building{layout.buildings.length !== 1 ? "s" : ""} |
              {" "}{layout.total_units} units |
              {" "}FAR {layout.far_achieved.toFixed(2)} |
              {" "}{layout.lot_coverage_pct.toFixed(0)}% coverage
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const SLAB_COLOR = "#c4b5a3";

// ── Phase 8c / 8.6: §6 Abstandsflächen ground projection ─────────────
//
// One translucent amber slab per facade, depth = max(0.4·H, 3 m). Each
// slab is built in the building's local frame (so it rotates with the
// building) and lifted slightly off the ground (y = 0.02) so it draws
// above the ground plane but below building walls.
//
// Phase 8.6 extension: when the building has a Staffelgeschoss the
// SG facade sits inset by `staffelgeschoss_setback_m` and uses the
// FULL building height — its §6 envelope is rendered as a second,
// slightly more saturated layer so the user can see both the lower
// and SG offsets.
function AbstandsflaechenLayer3D({
  building,
  hCoeff = 0.4,
}: {
  building: BuildingFootprint;
  hCoeff?: number;
}) {
  const lowerH = building.stories * (building.floor_height_m || 3.05);
  const lowerDepth = Math.max(hCoeff * lowerH, 3.0);
  const rotationRad = (building.rotation_deg * Math.PI) / 180;
  const hasSg = building.has_staffelgeschoss === true;
  const sgSetback = building.staffelgeschoss_setback_m ?? 2.0;
  const totalH = building.total_height_m;
  const sgDepth = Math.max(hCoeff * totalH, 3.0);
  const sgW = Math.max(building.width_m - 2 * sgSetback, 1.0);
  const sgD = Math.max(building.depth_m - 2 * sgSetback, 1.0);

  const lowerFaces = abstandsfaces(building.width_m, building.depth_m, lowerDepth);
  const sgFaces = hasSg ? abstandsfaces(sgW, sgD, sgDepth) : [];

  return (
    <group
      position={[building.position_x, 0.02, -building.position_y]}
      rotation={[0, rotationRad, 0]}
    >
      {lowerFaces.map((f, i) => (
        <mesh key={`lo-${i}`} position={[f.lx, 0, f.lz]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[f.w, f.d]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.18}
            depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      ))}
      {sgFaces.map((f, i) => (
        <mesh key={`sg-${i}`} position={[f.lx, 0.04, f.lz]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[f.w, f.d]} />
          <meshBasicMaterial color="#d97706" transparent opacity={0.22}
            depthWrite={false} polygonOffset polygonOffsetFactor={-2} />
        </mesh>
      ))}
    </group>
  );
}

// Compute the four facade rectangles in the building's local frame for
// a given footprint width/depth and offset depth. Each rect is laid
// flat on the ground (handled by caller's rotation).
function abstandsfaces(width_m: number, depth_m: number, offset: number) {
  const halfW = width_m / 2;
  const halfD = depth_m / 2;
  return [
    { lx: 0, lz: -halfD - offset / 2, w: width_m + 2 * offset, d: offset },
    { lx: 0, lz:  halfD + offset / 2, w: width_m + 2 * offset, d: offset },
    { lx: -halfW - offset / 2, lz: 0, w: offset, d: depth_m },
    { lx:  halfW + offset / 2, lz: 0, w: offset, d: depth_m },
  ];
}

// Phase 8.6 — §6 calculation breakdown panel. Shows H, formula and
// resulting offset for each building's lower and (if applicable) SG
// envelopes. Uses the same hCoeff (0.4) the renderer uses so what the
// user sees in 3D matches the numbers in the panel.
function AbstandsflaechenBreakdownPanel({
  buildings,
  hCoeff = 0.4,
}: {
  buildings: BuildingFootprint[];
  hCoeff?: number;
}) {
  return (
    <div className="absolute top-3 right-3 z-10 mt-32 max-w-xs bg-white/95 border border-amber-200 rounded-md shadow-md p-3 text-xs leading-tight">
      <div className="font-semibold text-amber-900 mb-1">§6 Abstandsflächen</div>
      <div className="text-[10px] text-neutral-500 mb-2">
        BauO NRW · d = max({hCoeff} · H, 3 m)
      </div>
      <div className="space-y-2 max-h-64 overflow-auto pr-1">
        {buildings.map((b) => {
          const lowerH = b.stories * (b.floor_height_m || 3.05);
          const lowerD = Math.max(hCoeff * lowerH, 3);
          const totalH = b.total_height_m;
          const sgD = b.has_staffelgeschoss
            ? Math.max(hCoeff * totalH, 3)
            : null;
          return (
            <div key={b.id} className="border-t pt-2 first:border-0 first:pt-0">
              <div className="font-medium text-neutral-800">{b.id}</div>
              <div className="text-neutral-600">
                Vollgeschosse · H = {lowerH.toFixed(2)} m →{" "}
                <span className="font-mono">d = {lowerD.toFixed(2)} m</span>
              </div>
              {b.has_staffelgeschoss && sgD !== null && (
                <div className="text-neutral-600">
                  + Staffelgeschoss · H<sub>tot</sub> = {totalH.toFixed(2)} m
                  · Setback {(b.staffelgeschoss_setback_m ?? 2).toFixed(1)} m →{" "}
                  <span className="font-mono">d<sub>SG</sub> = {sgD.toFixed(2)} m</span>
                </div>
              )}
              <div className="text-[10px] text-neutral-500 mt-0.5">
                Footprint {b.width_m.toFixed(1)} × {b.depth_m.toFixed(1)} m
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Phase 11a — install / uninstall the section-box clipping planes on
// the WebGL renderer. We use `renderer.clippingPlanes` (global) rather
// than per-material `clippingPlanes` so the planes apply to every
// `meshStandardMaterial` / `meshBasicMaterial` in the scene without
// having to thread them through every helper component. Empty array
// turns clipping off cleanly.
function SectionClipApplier({ planes }: { planes: THREE.Plane[] }) {
  const { gl } = useThree();
  useEffect(() => {
    // The Three.js renderer's `clippingPlanes` is a runtime-mutable
    // property — `Object.assign` keeps the React Compiler's
    // immutability check off our backs while still setting the
    // value the renderer reads each frame.
    Object.assign(gl, { clippingPlanes: planes });
    return () => {
      Object.assign(gl, { clippingPlanes: [] });
    };
  }, [gl, planes]);
  return null;
}
