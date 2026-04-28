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
import {
  TweaksPanel,
  DEFAULT_TWEAKS,
  paddingForDensity,
  gridForLayout,
  type WorkspaceTweaks,
} from "@/components/workspace/tweaks-panel";
import type { FloorPlanApartment } from "@/types/api";
import { useIfcExport } from "@/hooks/use-ifc-export";
import { useRhinoStatus } from "@/hooks/use-rhino-status";
import { API_BASE } from "@/lib/api-client";

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
  const [actionToast, setActionToast] = useState<
    | { type: "success" | "error" | "info"; message: string }
    | null
  >(null);
  // Phase 14c — workspace tweaks (density / layout / accent / draw
  // toggles). Local state, resets on reload.
  const [tweaks, setTweaks] = useState<WorkspaceTweaks>(DEFAULT_TWEAKS);
  const [tweaksOpen, setTweaksOpen] = useState(false);

  // Fall back to the first available building.
  const buildings = useMemo(() => Object.values(floorPlans), [floorPlans]);
  const currentBuildingPlans =
    (selectedBuildingId && floorPlans[selectedBuildingId]) ||
    buildings[0] ||
    null;

  // Phase 14b — IFC export + Rhino sync wired into the TopBar buttons.
  const ifc = useIfcExport({
    layout: selectedLayout,
    floorPlansMap: floorPlans,
  });
  // Phase 14d — live Rhino/Grasshopper connection state for the
  // status-bar dot. Polls /v1/rhino/status every 5 s.
  const rhinoStatus = useRhinoStatus();

  const handleExportIfc = async () => {
    const id = currentBuildingPlans?.building_id ?? selectedLayout?.buildings?.[0]?.id;
    if (!id) {
      setActionToast({ type: "error", message: "Kein Gebäude zum Exportieren ausgewählt." });
      setTimeout(() => setActionToast(null), 4000);
      return;
    }
    await ifc.exportIfc(id);
  };

  const handleSendRhino = async () => {
    if (!currentBuildingPlans) {
      setActionToast({ type: "error", message: "Keine Geschosse zum Senden — erst Grundrisse generieren." });
      setTimeout(() => setActionToast(null), 4000);
      return;
    }
    setActionToast({ type: "info", message: "Sende an Rhino…" });
    try {
      const res = await fetch(`${API_BASE}/v1/rhino/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentBuildingPlans),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(detail.detail || `HTTP ${res.status}`);
      }
      const data: { client_count: number; message: string } = await res.json();
      setActionToast({
        type: data.client_count > 0 ? "success" : "info",
        message:
          data.client_count > 0
            ? `An Rhino gesendet (${data.client_count} Verbindung${data.client_count === 1 ? "" : "en"}).`
            : "Kein Grasshopper-Client verbunden — beim nächsten Connect wird automatisch synchronisiert.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
      setActionToast({ type: "error", message: `Rhino-Sync fehlgeschlagen: ${msg}` });
    } finally {
      setTimeout(() => setActionToast(null), 5000);
    }
  };

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

  // Phase 14c — apply the chosen accent hue to the OKLCH `--ws-accent`
  // variables on the workspace root so every cyan-coloured element
  // recolours together. We only touch the variables on the workspace
  // root, never on `document.documentElement`, so other routes are
  // unaffected.
  const wsRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wsRootRef.current;
    if (!el) return;
    el.style.setProperty(
      "--ws-accent",
      `oklch(0.55 0.12 ${tweaks.accentHue})`,
    );
    el.style.setProperty(
      "--ws-accent-bg",
      `oklch(0.93 0.05 ${tweaks.accentHue})`,
    );
  }, [tweaks.accentHue]);

  // Density/layout numeric resolutions used in JSX below.
  const canvasPad = paddingForDensity(tweaks.density);
  const layoutGrid = gridForLayout(tweaks.layout);

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
        <StatusBar coords={coords} rhinoConnected={rhinoStatus.connected} />
      </div>
    );
  }

  return (
    <div
      ref={wsRootRef}
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
        onExportIfc={handleExportIfc}
        onSendRhino={handleSendRhino}
      />

      {/* Phase 14b — combined toast for IFC export + Rhino sync. The
          IFC hook owns its own status; we surface ours from
          `actionToast` (the Rhino path). When both fire we show
          whichever is currently set. */}
      {(ifc.status || actionToast) && (() => {
        const t = ifc.status ?? actionToast!;
        const tone =
          t.type === "success"
            ? "bg-emerald-50 border-emerald-200 text-emerald-900"
            : t.type === "error"
              ? "bg-rose-50 border-rose-200 text-rose-900"
              : "bg-sky-50 border-sky-200 text-sky-900";
        return (
          <div
            className={`absolute z-50 left-1/2 -translate-x-1/2 mt-2 px-3 py-2 rounded-md border text-sm font-medium shadow ${tone}`}
            style={{ top: 56 }}
            role="status"
          >
            {t.message}
          </div>
        );
      })()}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <LeftToolbar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          onOpenSettings={() => setTweaksOpen((v) => !v)}
          settingsActive={tweaksOpen}
        />

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
              gridTemplateColumns: layoutGrid.columns,
              gridTemplateRows: layoutGrid.rows,
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
                padding: canvasPad,
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
                  externalTool={activeTool}
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

            {/* Right column: 3D + variants — hidden in `focus` layout
                so the floor plan gets the full canvas. */}
            {tweaks.layout !== "focus" && (
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
            )}
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
        rhinoConnected={rhinoStatus.connected}
        bayInfo={bayInfo}
      />

      {/* Phase 14c — workspace tweaks popover, anchored above the
          LeftToolbar's Einstellungen button. */}
      <TweaksPanel
        open={tweaksOpen}
        state={tweaks}
        onChange={setTweaks}
        onClose={() => setTweaksOpen(false)}
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
