"use client";

import { Suspense, useState, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Grid, Text } from "@react-three/drei";
import { BuildingDetailed } from "./building-detailed";
import { GroundPlane } from "./ground-plane";
import { SunLight } from "./sun-light";
import { SectionBoxControls } from "./section-box";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import type { LayoutOption, PlotAnalysis, BuildingFloorPlans } from "@/types/api";

interface Scene3DProps {
  layout: LayoutOption | null;
  plot?: PlotAnalysis | null;
  sunPosition?: { azimuth: number; altitude: number };
  floorPlansMap?: Record<string, BuildingFloorPlans>;
}

export function Scene3D({ layout, plot, sunPosition, floorPlansMap }: Scene3DProps) {
  const [showLabels, setShowLabels] = useState(true);
  const [sectionY, setSectionY] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleExportIfc = useCallback(async (buildingId: string) => {
    if (!layout || !floorPlansMap?.[buildingId]) return;
    const building = layout.buildings.find((b) => b.id === buildingId);
    if (!building) return;

    setExporting(true);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";
      const response = await fetch(
        `${base}/v1/export/ifc`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            building,
            floor_plans: floorPlansMap[buildingId],
          }),
        }
      );
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `building_${buildingId}.ifc`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("IFC export error:", err);
    } finally {
      setExporting(false);
    }
  }, [layout, floorPlansMap]);

  if (!layout) {
    return (
      <div className="w-full h-[600px] bg-neutral-100 rounded-lg flex items-center justify-center">
        <p className="text-neutral-500">Select a layout to view in 3D</p>
      </div>
    );
  }

  // Compute camera position from plot size
  const plotWidth = plot?.width_m || 200;
  const plotDepth = plot?.depth_m || 200;
  const cameraDistance = Math.max(plotWidth, plotDepth) * 1.2;

  // Determine max height and story info for section box
  const maxHeight = Math.max(...layout.buildings.map((b) => b.total_height_m), 10);
  const firstBuilding = layout.buildings[0];
  const storyHeight = firstBuilding?.floor_height_m || 2.9;
  const maxStories = Math.max(...layout.buildings.map((b) => b.stories), 1);

  // Check if any building has detailed floor plans
  const hasDetailedData = floorPlansMap && Object.keys(floorPlansMap).length > 0;

  return (
    <div className="relative w-full h-[600px] rounded-lg overflow-hidden border">
      {/* Top controls */}
      <div className="absolute top-3 left-3 z-10 flex gap-2">
        <Button
          size="sm"
          variant={showLabels ? "default" : "outline"}
          onClick={() => setShowLabels(!showLabels)}
        >
          Labels
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

      {/* Section box controls — always shown when buildings exist */}
      <div className="absolute top-3 right-3 z-10">
        <SectionBoxControls
          maxHeight={maxHeight}
          storyHeight={storyHeight}
          numStories={maxStories}
          sectionY={sectionY}
          onSectionYChange={setSectionY}
        />
      </div>

      <Canvas
        shadows
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
              position={[200, 300, 200]}
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

          {/* Buildings — detailed if floor plans exist, simple otherwise */}
          {layout.buildings.map((building, i) => (
            <BuildingDetailed
              key={building.id}
              building={building}
              floorPlans={floorPlansMap?.[building.id]}
              index={i}
              showLabel={showLabels}
              sectionBoxY={sectionY}
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
