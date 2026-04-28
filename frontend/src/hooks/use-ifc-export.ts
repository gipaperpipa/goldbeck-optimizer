"use client";

/**
 * `useIfcExport` (Phase 14b) — single source of truth for the IFC
 * export flow.
 *
 * Lifted out of `Scene3D` so the workspace TopBar's "IFC Export"
 * button can use the same code path. The hook posts to
 * `/v1/export/ifc` with the building footprint, the floor plans, and
 * three optional Pset enrichments (cost, thermal, furniture). Each
 * enrichment runs in its own try/catch so a broken estimator can't
 * block the export — the IFC just goes out without that pset.
 */

import { useCallback, useState } from "react";
import type {
  BuildingFloorPlans,
  BuildingFootprint,
  LayoutOption,
} from "@/types/api";
import { API_BASE } from "@/lib/api-client";
import { estimateCost } from "@/lib/cost-estimator";
import { estimateThermal } from "@/lib/thermal-envelope";
import { placeFurnitureForPlan, type FurnitureKind } from "@/lib/furniture-layouts";

export interface IfcExportStatus {
  type: "success" | "error";
  message: string;
}

export interface UseIfcExportArgs {
  layout: LayoutOption | null;
  floorPlansMap?: Record<string, BuildingFloorPlans>;
}

export interface UseIfcExportResult {
  exportIfc: (buildingId: string) => Promise<void>;
  /** Convenience for the workspace path: pulls a building id off the
   *  layout if not provided, defaulting to the first one. */
  exportFirstBuilding: () => Promise<void>;
  exporting: boolean;
  status: IfcExportStatus | null;
  clearStatus: () => void;
}

/** Aggregate furniture placements across every floor of a building
 *  into a flat `{kind: count}` dict for the IFC
 *  Pset_ADS_Furniture_DIN18011 pset. Mirrors the earlier helper in
 *  `scene.tsx`. */
function aggregateFurnitureCounts(
  building: BuildingFloorPlans,
): Record<string, number> {
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

export function useIfcExport({
  layout,
  floorPlansMap,
}: UseIfcExportArgs): UseIfcExportResult {
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<IfcExportStatus | null>(null);

  const clearStatus = useCallback(() => setStatus(null), []);

  const exportIfc = useCallback(
    async (buildingId: string) => {
      if (!layout || !floorPlansMap?.[buildingId]) {
        setStatus({
          type: "error",
          message:
            "Kein Gebäude / keine Geschosse zum Exportieren — erst Layout auswählen und Grundrisse generieren.",
        });
        setTimeout(() => setStatus(null), 5000);
        return;
      }
      const building: BuildingFootprint | undefined = layout.buildings.find(
        (b) => b.id === buildingId,
      );
      if (!building) {
        setStatus({ type: "error", message: `Gebäude ${buildingId} nicht im Layout.` });
        setTimeout(() => setStatus(null), 5000);
        return;
      }

      setExporting(true);
      setStatus(null);
      try {
        const floorPlans = floorPlansMap[buildingId];

        let costMetadata: unknown = null;
        let thermalMetadata: unknown = null;
        let furnitureCounts: Record<string, number> | null = null;
        try {
          costMetadata = estimateCost({ building: floorPlans });
        } catch (e) {
          console.debug("cost metadata skipped:", e);
        }
        try {
          thermalMetadata = estimateThermal({
            building: floorPlans,
            standard: "goldbeck_standard",
          });
        } catch (e) {
          console.debug("thermal metadata skipped:", e);
        }
        try {
          furnitureCounts = aggregateFurnitureCounts(floorPlans);
        } catch (e) {
          console.debug("furniture counts skipped:", e);
        }

        const response = await fetch(`${API_BASE}/v1/export/ifc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            building,
            floor_plans: floorPlans,
            cost_metadata: costMetadata,
            thermal_metadata: thermalMetadata,
            furniture_counts: furnitureCounts,
          }),
        });
        if (!response.ok) {
          const detail = await response
            .json()
            .catch(() => ({ detail: response.statusText }));
          throw new Error(detail.detail || `Export failed (${response.status})`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `building_${buildingId}.ifc`;
        a.click();
        URL.revokeObjectURL(url);
        setStatus({
          type: "success",
          message: `IFC-Export erfolgreich: building_${buildingId}.ifc`,
        });
        setTimeout(() => setStatus(null), 4000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
        setStatus({
          type: "error",
          message: `IFC-Export fehlgeschlagen: ${msg}`,
        });
        setTimeout(() => setStatus(null), 6000);
      } finally {
        setExporting(false);
      }
    },
    [layout, floorPlansMap],
  );

  const exportFirstBuilding = useCallback(async () => {
    const id = layout?.buildings?.[0]?.id;
    if (!id) {
      setStatus({ type: "error", message: "Kein Gebäude im Layout." });
      setTimeout(() => setStatus(null), 4000);
      return;
    }
    await exportIfc(id);
  }, [layout, exportIfc]);

  return { exportIfc, exportFirstBuilding, exporting, status, clearStatus };
}
