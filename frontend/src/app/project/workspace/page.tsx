"use client";

/**
 * Goldbeck Workspace (Phase 5i).
 *
 * CAD/blueprint-style unified workspace redesigning the results view as
 * a flagship single-pane experience. Composes the existing
 * `FloorPlanViewer` + `Scene3D` inside new chrome (top bar, left
 * toolbar, left sidebar, right inspector, status bar, optimization
 * bar, variants strip).
 *
 * Coexists with `/project/results` — the tabbed view is unchanged.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/stores/project-store";
import { FloorPlanViewer } from "@/components/floorplan/floor-plan-viewer";
import { Scene3D } from "@/components/three/scene";
import { TopBar, type WorkspaceMode } from "@/components/workspace/top-bar";
import { LeftToolbar, type ToolId } from "@/components/workspace/left-toolbar";
import { LeftSidebar } from "@/components/workspace/left-sidebar";
import { RightInspector } from "@/components/workspace/right-inspector";
import { StatusBar } from "@/components/workspace/status-bar";
import { OptimizationBar } from "@/components/workspace/optimization-bar";
import { VariantsStrip } from "@/components/workspace/variants-strip";
import { Icon } from "@/components/workspace/icon";
import type { FloorPlanApartment } from "@/types/api";

function floorLabelFor(idx: number, total: number, floorType?: string): string {
  if (floorType === "staffelgeschoss") return "SG · Staffelgeschoss";
  if (idx === 0) return "EG · Erdgeschoss";
  if (idx === total - 1 && floorType !== "standard") return `${idx}. OG`;
  return `${idx}. OG`;
}

export default function WorkspacePage() {
  const {
    plotAnalysis,
    selectedLayout,
    floorPlans,
    optimizationResult,
    selectedBuildingId,
    setSelectedBuildingId,
    selectedFloorIndex,
    setSelectedFloorIndex,
    setSelectedLayout,
  } = useProjectStore();

  const [mode, setMode] = useState<WorkspaceMode>("architect");
  const [activeTool, setActiveTool] = useState<ToolId>("cursor");
  const [selectedAptId, setSelectedAptId] = useState<string | null>(null);
  const [coords, setCoords] = useState<string>("X: —  Y: —");

  // Fall back to the first available building.
  const buildings = useMemo(() => Object.values(floorPlans), [floorPlans]);
  const currentBuildingPlans =
    (selectedBuildingId && floorPlans[selectedBuildingId]) ||
    buildings[0] ||
    null;

  useEffect(() => {
    if (!selectedBuildingId && buildings[0]?.building_id) {
      setSelectedBuildingId(buildings[0].building_id);
    }
  }, [selectedBuildingId, buildings, setSelectedBuildingId]);

  const currentBuildingFootprint = selectedLayout?.buildings?.find(
    (b) => b.id === currentBuildingPlans?.building_id,
  );

  const currentFloor = currentBuildingPlans?.floor_plans?.[selectedFloorIndex];
  const totalFloors = currentBuildingPlans?.floor_plans?.length ?? 0;
  const floorLabel = currentFloor
    ? floorLabelFor(selectedFloorIndex, totalFloors, currentFloor.floor_type)
    : "—";

  const apartments: FloorPlanApartment[] = useMemo(
    () => currentFloor?.apartments ?? [],
    [currentFloor],
  );

  // Resolve the effective selected apartment without an effect: if the
  // user's pick is still on this floor, use it; otherwise auto-pick a
  // south-facing apartment, falling back to the first.
  const effectiveAptId = useMemo(() => {
    if (apartments.length === 0) return null;
    if (selectedAptId && apartments.some((a) => a.id === selectedAptId)) {
      return selectedAptId;
    }
    const south = apartments.find((a) => a.side?.toLowerCase().includes("s"));
    return south?.id ?? apartments[0].id;
  }, [apartments, selectedAptId]);

  const selectedApartment =
    apartments.find((a) => a.id === effectiveAptId) ?? null;

  // Floor-plan viewer needs an explicit pixel size — measure the paper
  // container.
  const paperRef = useRef<HTMLDivElement>(null);
  const [viewerSize, setViewerSize] = useState({ width: 800, height: 520 });
  useEffect(() => {
    const el = paperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setViewerSize({
        width: Math.max(320, Math.floor(r.width)),
        height: Math.max(280, Math.floor(r.height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const presentationMode = mode === "presentation";

  // Top variants — pull from optimizationResult.layouts (already sorted by rank).
  const topVariants = useMemo(
    () => (optimizationResult?.layouts ?? []).slice(0, 5),
    [optimizationResult],
  );

  // Project chrome labels.
  const projectLabel = plotAnalysis?.address_resolved
    ? plotAnalysis.address_resolved.split(",")[0]?.toUpperCase() ?? "PROJEKT"
    : "PROJEKT";
  const layoutLabel = selectedLayout
    ? `Layout · V${selectedLayout.rank ?? "?"}`
    : "Kein Layout";
  const projectName = plotAnalysis?.address_resolved
    ? plotAnalysis.address_resolved.split(",")[0] ?? "Goldbeck Projekt"
    : "Goldbeck Projekt";
  const projectAddress = plotAnalysis?.address_resolved
    ?.split(",")
    .slice(1)
    .join(",")
    .trim();

  // Status-bar context.
  const grid = currentFloor?.structural_grid;
  const bayInfo = grid
    ? `${grid.bay_widths.length} × ${(grid.building_length_m / Math.max(grid.bay_widths.length, 1)).toFixed(2)} m`
    : undefined;

  // Empty state — no project loaded.
  if (!selectedLayout && buildings.length === 0) {
    return (
      <div className="workspace-root" style={{ minHeight: "100vh" }}>
        <TopBar
          mode={mode}
          setMode={setMode}
          projectLabel="—"
          layoutLabel="—"
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "calc(100vh - 48px - 26px)",
            gap: 12,
            padding: 40,
            textAlign: "center",
          }}
        >
          <div
            className="ws-serif"
            style={{ fontSize: 28, color: "var(--ws-ink)" }}
          >
            Kein Projekt geladen
          </div>
          <div style={{ color: "var(--ws-ink-dim)", maxWidth: 480 }}>
            Starten Sie ein neues Projekt oder wählen Sie ein bestehendes Layout
            aus, um den Workspace zu öffnen.
          </div>
          <Link
            href="/project/new"
            style={{
              padding: "8px 14px",
              background: "var(--ws-ink)",
              color: "white",
              borderRadius: 3,
              textDecoration: "none",
              fontSize: 13,
              marginTop: 8,
            }}
          >
            Neues Projekt
          </Link>
        </div>
        <StatusBar coords={coords} />
      </div>
    );
  }

  return (
    <div
      className="workspace-root"
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--ws-bg)",
      }}
    >
      <TopBar
        mode={mode}
        setMode={setMode}
        projectLabel={projectLabel}
        layoutLabel={layoutLabel}
      />

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <LeftToolbar activeTool={activeTool} setActiveTool={setActiveTool} />

        <LeftSidebar
          projectName={projectName}
          projectAddress={projectAddress}
          layout={selectedLayout}
          plot={plotAnalysis}
          apartments={apartments}
          selectedAptId={effectiveAptId}
          onSelectApt={setSelectedAptId}
          floorLabel={floorLabel}
        />

        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
            background: "var(--ws-bg-canvas)",
            overflow: "hidden",
          }}
        >
          {/* Canvas toolbar */}
          <div
            style={{
              height: 40,
              flexShrink: 0,
              borderBottom: "1px solid var(--ws-line)",
              display: "flex",
              alignItems: "center",
              padding: "0 16px",
              gap: 14,
              background: "var(--ws-bg)",
            }}
          >
            {buildings.length > 1 && (
              <select
                value={currentBuildingPlans?.building_id ?? ""}
                onChange={(e) => setSelectedBuildingId(e.target.value)}
                style={selectStyle()}
                aria-label="Gebäude"
              >
                {buildings.map((b) => (
                  <option key={b.building_id} value={b.building_id}>
                    {b.building_id}
                  </option>
                ))}
              </select>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Icon name="floor" size={13} />
              <select
                value={selectedFloorIndex}
                onChange={(e) => setSelectedFloorIndex(Number(e.target.value))}
                style={selectStyle()}
                aria-label="Geschoss"
              >
                {currentBuildingPlans?.floor_plans.map((fp, idx) => (
                  <option key={fp.floor_index} value={idx}>
                    {floorLabelFor(idx, totalFloors, fp.floor_type)}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ width: 1, height: 20, background: "var(--ws-line)" }} />

            <Link href="/project/results" style={canvasBtnStyle()}>
              <Icon name="layers" size={12} /> Alle Tabs
            </Link>
            <Link href="/project/results?tab=shadow" style={canvasBtnStyle()}>
              <Icon name="sun" size={12} /> Verschattung
            </Link>
            <Link href="/project/results?tab=permit" style={canvasBtnStyle()}>
              <Icon name="check" size={12} /> Prüfung
            </Link>

            <div style={{ flex: 1 }} />

            <div
              className="ws-mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 11,
                color: "var(--ws-ink-dim)",
              }}
            >
              <span>{coords}</span>
            </div>
          </div>

          {/* Canvas split */}
          <div
            style={{
              flex: 1,
              display: "grid",
              gridTemplateColumns: "1.45fr 1fr",
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            {/* Floor plan paper */}
            <div
              ref={paperRef}
              className="ws-paper"
              onMouseMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const x = ((e.clientX - r.left) / r.width *
                  (grid?.building_length_m ?? 30)).toFixed(2);
                const y = ((e.clientY - r.top) / r.height *
                  (grid?.building_depth_m ?? 13)).toFixed(2);
                setCoords(`X: ${x}  Y: ${y}`);
              }}
              style={{
                position: "relative",
                borderRight: "1px solid var(--ws-line)",
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              <div
                className="ws-mono"
                style={{
                  position: "absolute",
                  top: 12,
                  left: 16,
                  zIndex: 2,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  pointerEvents: "none",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--ws-ink-dim)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  2D · Grundriss
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--ws-ink-dim)",
                    letterSpacing: "0.06em",
                  }}
                >
                  DIN 1356 · {floorLabel}
                </span>
              </div>

              {currentFloor && currentBuildingPlans && (
                <FloorPlanViewer
                  floorPlan={currentFloor}
                  width={viewerSize.width}
                  height={viewerSize.height}
                  selectedApartmentId={effectiveAptId ?? undefined}
                  onApartmentSelect={(apt) =>
                    setSelectedAptId(apt?.id ?? null)
                  }
                  buildingId={currentBuildingPlans.building_id}
                  floorIndex={selectedFloorIndex}
                  allFloors={currentBuildingPlans.floor_plans}
                  latitude={plotAnalysis?.centroid_geo?.lat}
                  longitude={plotAnalysis?.centroid_geo?.lng}
                  buildingRotationDeg={
                    currentBuildingFootprint?.rotation_deg ?? 0
                  }
                  plotBoundary={plotAnalysis?.boundary_polygon_local}
                  buildingPosition={
                    currentBuildingFootprint
                      ? {
                          x: currentBuildingFootprint.position_x,
                          y: currentBuildingFootprint.position_y,
                        }
                      : undefined
                  }
                  buildingDimensions={
                    currentBuildingFootprint
                      ? {
                          width: currentBuildingFootprint.width_m,
                          depth: currentBuildingFootprint.depth_m,
                        }
                      : undefined
                  }
                  buildingHeightM={currentBuildingFootprint?.total_height_m}
                />
              )}
            </div>

            {/* Right column: 3D + variants */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              {/* 3D iso */}
              <div
                style={{
                  height: 320,
                  flexShrink: 0,
                  background: "oklch(0.97 0.005 85)",
                  borderBottom: "1px solid var(--ws-line)",
                  position: "relative",
                  minHeight: 0,
                }}
              >
                <div
                  className="ws-mono"
                  style={{
                    position: "absolute",
                    top: 10,
                    left: 14,
                    zIndex: 2,
                    fontSize: 10,
                    color: "var(--ws-ink-dim)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    pointerEvents: "none",
                  }}
                >
                  3D · Iso
                </div>
                <Scene3D
                  layout={selectedLayout}
                  plot={plotAnalysis}
                  floorPlansMap={floorPlans}
                />
              </div>

              {/* Variants strip */}
              {topVariants.length > 0 && (
                <div
                  style={{
                    padding: 14,
                    background: "var(--ws-bg)",
                    borderBottom: "1px solid var(--ws-line)",
                    flexShrink: 0,
                  }}
                >
                  <VariantsStrip
                    variants={topVariants}
                    selectedId={selectedLayout?.id ?? null}
                    onSelect={(layoutId) => {
                      const next = (optimizationResult?.layouts ?? []).find(
                        (l) => l.id === layoutId,
                      );
                      if (next) setSelectedLayout(next);
                    }}
                  />
                </div>
              )}

              {/* Optimization bar */}
              {!presentationMode && (
                <div
                  style={{
                    padding: 14,
                    flexShrink: 0,
                    background: "var(--ws-bg-canvas)",
                  }}
                >
                  <OptimizationBar
                    generation={optimizationResult?.current_generation}
                    generationsTotal={optimizationResult?.total_generations}
                    bestFitness={
                      optimizationResult?.best_fitness ??
                      selectedLayout?.scores?.overall
                    }
                    fitnessDelta={
                      optimizationResult?.fitness_history?.length
                        ? (optimizationResult.best_fitness ?? 0) -
                          (optimizationResult.fitness_history[0]
                            ?.best_fitness ?? 0)
                        : undefined
                    }
                    points={optimizationResult?.fitness_history?.map((h) => ({
                      generation: h.generation,
                      best: h.best_fitness,
                      current: h.avg_fitness,
                    }))}
                  />
                </div>
              )}
            </div>
          </div>
        </main>

        <RightInspector
          apartment={selectedApartment}
          qualityScore={selectedLayout?.scores?.livability}
          floorLabel={floorLabel}
        />
      </div>

      <StatusBar
        coords={coords}
        generation={optimizationResult?.current_generation}
        fitness={
          optimizationResult?.best_fitness ?? selectedLayout?.scores?.overall
        }
        rhinoConnected={false}
        bayInfo={bayInfo}
      />
    </div>
  );
}

function selectStyle(): React.CSSProperties {
  return {
    border: "1px solid var(--ws-line)",
    background: "white",
    padding: "4px 8px",
    fontSize: 12,
    fontFamily: "inherit",
    color: "var(--ws-ink)",
    borderRadius: 3,
    cursor: "pointer",
  };
}

function canvasBtnStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid var(--ws-line)",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: 11,
    color: "var(--ws-ink-mid)",
    textDecoration: "none",
  };
}
