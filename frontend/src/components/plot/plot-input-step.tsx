"use client";

import { useState, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { MapContainer } from "@/components/map/map-container";
import { CadastralMap } from "@/components/map/cadastral-map";
import { ManualPlotInput } from "@/components/plot/manual-plot-input";
import { PlotSummary } from "@/components/plot/plot-summary";
import { usePlotAnalysis } from "@/hooks/use-plot-analysis";
import { useProjectStore } from "@/stores/project-store";
import type { CoordinatePoint } from "@/types/api";

interface PlotInputStepProps {
  onNext: () => void;
}

export function PlotInputStep({ onNext }: PlotInputStepProps) {
  const [tab, setTab] = useState("cadastral");
  const { analyze, isLoading } = usePlotAnalysis();
  const plotAnalysis = useProjectStore((s) => s.plotAnalysis);

  const handlePolygonDrawn = useCallback(
    async (coords: CoordinatePoint[]) => {
      try {
        await analyze({
          mode: "coordinates",
          boundary_polygon: coords,
        });
      } catch {
        // handled in hook
      }
    },
    [analyze]
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Grundstück definieren</CardTitle>
          <CardDescription>
            Wählen Sie ein Flurstück aus der Katasterkarte oder geben Sie die Maße manuell ein.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="cadastral">Katasterkarte</TabsTrigger>
              <TabsTrigger value="manual">Manuelle Eingabe</TabsTrigger>
              <TabsTrigger value="map">Auf Karte zeichnen</TabsTrigger>
            </TabsList>

            <TabsContent value="cadastral">
              <CadastralMap onPlotConfirmed={onNext} />
            </TabsContent>

            <TabsContent value="manual">
              <ManualPlotInput onComplete={onNext} />
            </TabsContent>

            <TabsContent value="map">
              <MapContainer onPolygonDrawn={handlePolygonDrawn} />
              {isLoading && (
                <p className="text-sm text-neutral-500 mt-2">Analyzing plot...</p>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {plotAnalysis && <PlotSummary analysis={plotAnalysis} onNext={onNext} />}
    </div>
  );
}
