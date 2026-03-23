"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Scene3D } from "@/components/three/scene";
import { useProjectStore } from "@/stores/project-store";
import { useShadowAnalysis } from "@/hooks/use-shadow-analysis";

const DEFAULT_TIMES = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"];

export function ShadowAnalysisPanel() {
  const { selectedLayout, plotAnalysis, floorPlans } = useProjectStore();
  const { analyze, result, isLoading } = useShadowAnalysis();
  const [date, setDate] = useState("2025-06-21");
  const [currentTimeIndex, setCurrentTimeIndex] = useState(2);

  const handleAnalyze = async () => {
    if (!selectedLayout || !plotAnalysis) return;
    await analyze({
      layout: selectedLayout,
      latitude: plotAnalysis.centroid_geo.lat,
      longitude: plotAnalysis.centroid_geo.lng,
      date,
      times: DEFAULT_TIMES,
    });
  };

  const currentSnapshot = result?.snapshots?.[currentTimeIndex];

  if (!selectedLayout) {
    return (
      <div className="text-center text-neutral-500 py-10">
        Select a layout first to run shadow analysis
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-full">
      {/* Controls sidebar */}
      <div className="w-72 space-y-4 shrink-0">
        <Card>
          <CardHeader><CardTitle className="text-sm">Shadow Controls</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs">Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <Button onClick={handleAnalyze} disabled={isLoading} className="w-full" size="sm">
              {isLoading ? "Analyzing..." : "Analyze Shadows"}
            </Button>

            {result && (
              <>
                <div>
                  <Label className="text-xs">Time: {DEFAULT_TIMES[currentTimeIndex]}</Label>
                  <Slider
                    value={[currentTimeIndex]}
                    onValueChange={([v]) => setCurrentTimeIndex(v)}
                    min={0} max={DEFAULT_TIMES.length - 1} step={1}
                  />
                </div>
                <div className="text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-neutral-500">Avg Sunlight</span>
                    <span className="font-semibold">{result.avg_sunlight_pct.toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-500">Worst</span>
                    <span className="font-semibold">{result.worst_sunlight_pct.toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-500">Best</span>
                    <span className="font-semibold">{result.best_sunlight_pct.toFixed(1)}%</span>
                  </div>
                </div>
                {currentSnapshot && (
                  <div className="text-xs space-y-1 border-t pt-2">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Sun Azimuth</span>
                      <span>{currentSnapshot.sun_azimuth_deg.toFixed(1)}&deg;</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Sun Altitude</span>
                      <span>{currentSnapshot.sun_altitude_deg.toFixed(1)}&deg;</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Direct Sun</span>
                      <span className="font-semibold">{currentSnapshot.direct_sunlight_pct.toFixed(1)}%</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 3D view with shadow */}
      <div className="flex-1">
        <Scene3D
          layout={selectedLayout}
          plot={plotAnalysis}
          floorPlansMap={floorPlans}
          sunPosition={
            currentSnapshot
              ? { azimuth: currentSnapshot.sun_azimuth_deg, altitude: currentSnapshot.sun_altitude_deg }
              : undefined
          }
        />
      </div>
    </div>
  );
}
