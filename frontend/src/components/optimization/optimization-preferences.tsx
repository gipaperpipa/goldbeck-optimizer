"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useProjectStore } from "@/stores/project-store";
import { useOptimization } from "@/hooks/use-optimization";
import { FitnessChart } from "./fitness-chart";
import type { FloorPlanWeights } from "@/types/api";

interface OptimizationPreferencesProps {
  onComplete: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  }
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

export function OptimizationPreferences({ onComplete }: OptimizationPreferencesProps) {
  const { plotAnalysis, regulations, optimizationResult } = useProjectStore();
  const { startOptimization, estimateRuntime, isRunning, progress, completedFitnessHistory } = useOptimization();

  const [objective, setObjective] = useState("balanced");
  const [unitMix, setUnitMix] = useState({
    studio_pct: 0.15, one_bed_pct: 0.40,
    two_bed_pct: 0.30, three_bed_pct: 0.15,
  });
  const [weights, setWeights] = useState({
    efficiency: 0.30, financial: 0.30,
    livability: 0.20, compliance: 0.20,
  });
  const [maxBuildings, setMaxBuildings] = useState(4);
  const [generations, setGenerations] = useState(100);
  const [populationSize, setPopulationSize] = useState(100);
  const [estimatedTime, setEstimatedTime] = useState<number | null>(null);

  // Combined mode settings
  const [includeFloorPlans, setIncludeFloorPlans] = useState(true);
  const [fpGenerations, setFpGenerations] = useState(20);
  const [fpPopulationSize, setFpPopulationSize] = useState(20);
  const [fpStoryHeight, setFpStoryHeight] = useState(2.90);
  const [fpWeights, setFpWeights] = useState<FloorPlanWeights>({
    efficiency: 0.25, livability: 0.25,
    revenue: 0.25, compliance: 0.25,
  });

  const buildRequest = useCallback(() => {
    if (!plotAnalysis || !regulations) return null;
    return {
      plot: plotAnalysis,
      regulations,
      objective,
      unit_mix_preference: unitMix,
      weights,
      max_buildings: maxBuildings,
      min_buildings: 1,
      allow_podium_parking: true,
      allow_surface_parking: true,
      allow_structured_parking: false,
      population_size: populationSize,
      generations,
      include_floor_plans: includeFloorPlans,
      floor_plan_settings: {
        generations: fpGenerations,
        population_size: fpPopulationSize,
        story_height_m: fpStoryHeight,
        weights: fpWeights,
      },
    };
  }, [plotAnalysis, regulations, objective, unitMix, weights, maxBuildings, populationSize, generations, includeFloorPlans, fpGenerations, fpPopulationSize, fpStoryHeight, fpWeights]);

  // Update estimated time when settings change
  const estimateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (estimateTimerRef.current) clearTimeout(estimateTimerRef.current);
    estimateTimerRef.current = setTimeout(async () => {
      const request = buildRequest();
      if (request) {
        const est = await estimateRuntime(request);
        setEstimatedTime(est);
      }
    }, 300);
    return () => {
      if (estimateTimerRef.current) clearTimeout(estimateTimerRef.current);
    };
  }, [generations, populationSize, includeFloorPlans, fpGenerations, fpPopulationSize, buildRequest, estimateRuntime]);

  const handleRun = async () => {
    const request = buildRequest();
    if (!request) return;
    // L15: Request notification permission for long-running jobs
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    await startOptimization(request);
  };

  // Auto-advance when done
  const hasAdvanced = useRef(false);
  useEffect(() => {
    if (
      optimizationResult?.status === "completed" &&
      optimizationResult.layouts.length > 0 &&
      !hasAdvanced.current
    ) {
      hasAdvanced.current = true;
      onComplete();
    }
  }, [optimizationResult, onComplete]);

  const objectives = [
    { value: "balanced", label: "Balanced" },
    { value: "max_units", label: "Max Units" },
    { value: "max_far", label: "Max FAR" },
    { value: "max_roi", label: "Max ROI" },
    { value: "max_open_space", label: "Max Open Space" },
  ];

  const unitTypes = [
    { key: "studio_pct" as const, label: "Studio" },
    { key: "one_bed_pct" as const, label: "1 Bedroom" },
    { key: "two_bed_pct" as const, label: "2 Bedroom" },
    { key: "three_bed_pct" as const, label: "3 Bedroom" },
  ];

  const weightTypes = [
    { key: "efficiency" as const, label: "Efficiency" },
    { key: "financial" as const, label: "Financial" },
    { key: "livability" as const, label: "Livability" },
    { key: "compliance" as const, label: "Compliance" },
  ];

  const fpWeightSliders = [
    { key: "efficiency" as const, label: "Efficiency", desc: "Net/gross ratio, regularity" },
    { key: "livability" as const, label: "Livability", desc: "Natural light, noise, room proportions" },
    { key: "revenue" as const, label: "Revenue", desc: "Unit count, mix match, areas" },
    { key: "compliance" as const, label: "Compliance", desc: "Fire egress, barrier-free" },
  ];

  const handleFpWeightChange = (key: keyof FloorPlanWeights, value: number) => {
    const raw = { ...fpWeights, [key]: value / 100 };
    const total = raw.efficiency + raw.livability + raw.revenue + raw.compliance;
    if (total > 0) {
      setFpWeights({
        efficiency: raw.efficiency / total,
        livability: raw.livability / total,
        revenue: raw.revenue / total,
        compliance: raw.compliance / total,
      });
    }
  };

  const phaseLabel = progress.phase === "floor_plans" ? "Floor Plans" : "Layouts";

  return (
    <Card>
      <CardHeader><CardTitle>Optimization Preferences</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        {/* Objective */}
        <div>
          <Label>Optimization Objective</Label>
          <div className="flex gap-2 mt-1 flex-wrap">
            {objectives.map((obj) => (
              <Button
                key={obj.value}
                variant={objective === obj.value ? "default" : "outline"}
                size="sm"
                onClick={() => setObjective(obj.value)}
              >
                {obj.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Unit Mix */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Unit Mix Targets</h3>
          {unitTypes.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-4">
              <Label className="w-24 text-xs">{label}</Label>
              <Slider
                value={[unitMix[key] * 100]}
                onValueChange={([v]) => setUnitMix({ ...unitMix, [key]: v / 100 })}
                min={0} max={100} step={5}
                aria-label={`${label} Anteil`}
              />
              <span className="w-12 text-right text-sm">{(unitMix[key] * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>

        {/* Layout Weights */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Layout Optimization Weights</h3>
          {weightTypes.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-4">
              <Label className="w-24 text-xs">{label}</Label>
              <Slider
                value={[weights[key] * 100]}
                onValueChange={([v]) => setWeights({ ...weights, [key]: v / 100 })}
                min={0} max={100} step={5}
                aria-label={`${label} Gewichtung`}
              />
              <span className="w-12 text-right text-sm">{(weights[key] * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>

        {/* Max Buildings */}
        <div className="flex items-center gap-4">
          <Label className="w-24 text-xs">Max Buildings</Label>
          <Slider value={[maxBuildings]} onValueChange={([v]) => setMaxBuildings(v)} min={1} max={10} step={1} aria-label="Max Buildings" />
          <span className="w-12 text-right text-sm">{maxBuildings}</span>
        </div>

        {/* Layout Run Configuration */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Layout Run Configuration</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Generations</Label>
              <Input
                type="number"
                min={1}
                max={500}
                value={generations}
                onChange={(e) => setGenerations(Math.min(500, Math.max(1, parseInt(e.target.value) || 1)))}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Versions per Generation</Label>
              <Input
                type="number"
                min={2}
                max={200}
                value={populationSize}
                onChange={(e) => setPopulationSize(Math.min(200, Math.max(2, parseInt(e.target.value) || 2)))}
                className="mt-1"
              />
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            Layout evaluations: {(generations * populationSize).toLocaleString()}
          </p>
        </div>

        {/* Generation Mode Toggle */}
        <div className="border rounded-lg p-4 space-y-4">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold">Generation Mode</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setIncludeFloorPlans(false)}
              className={`p-3 rounded-lg border-2 text-left transition-colors ${
                !includeFloorPlans
                  ? "border-neutral-900 bg-neutral-50"
                  : "border-neutral-200 hover:border-neutral-300"
              }`}
            >
              <div className="text-sm font-medium">Layout Only</div>
              <div className="text-xs text-neutral-500 mt-1">
                Generate building footprints (outer walls only). Run floor plans separately later.
              </div>
            </button>
            <button
              onClick={() => setIncludeFloorPlans(true)}
              className={`p-3 rounded-lg border-2 text-left transition-colors ${
                includeFloorPlans
                  ? "border-neutral-900 bg-neutral-50"
                  : "border-neutral-200 hover:border-neutral-300"
              }`}
            >
              <div className="text-sm font-medium">Combined</div>
              <div className="text-xs text-neutral-500 mt-1">
                Generate layouts + fill each building with optimized apartment floor plans.
              </div>
            </button>
          </div>

          {/* Floor Plan Settings (only shown in combined mode) */}
          {includeFloorPlans && (
            <div className="mt-4 pt-4 border-t space-y-4">
              <h4 className="text-sm font-semibold text-neutral-700">Floor Plan Settings</h4>

              <div className="flex items-center gap-4">
                <Label className="w-28 text-xs">Story Height</Label>
                <select
                  className="border rounded px-3 py-1.5 text-sm bg-white flex-1"
                  value={fpStoryHeight}
                  onChange={(e) => setFpStoryHeight(parseFloat(e.target.value))}
                >
                  <option value={2.90}>2.90m (Standard)</option>
                  <option value={3.07}>3.07m (Standard B)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">FP Generations</Label>
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={fpGenerations}
                    onChange={(e) => setFpGenerations(Math.min(500, Math.max(1, parseInt(e.target.value) || 1)))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">FP Variants per Gen</Label>
                  <Input
                    type="number"
                    min={2}
                    max={200}
                    value={fpPopulationSize}
                    onChange={(e) => setFpPopulationSize(Math.min(200, Math.max(2, parseInt(e.target.value) || 2)))}
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <h5 className="text-xs font-medium text-neutral-600">Floor Plan Weights</h5>
                {fpWeightSliders.map(({ key, label, desc }) => (
                  <div key={key} className="flex items-center gap-3">
                    <Label className="w-24 text-xs" title={desc}>{label}</Label>
                    <Slider
                      value={[fpWeights[key] * 100]}
                      onValueChange={([v]) => handleFpWeightChange(key, v)}
                      min={0} max={100} step={5}
                      aria-label={`${label} Gewichtung`}
                    />
                    <span className="w-10 text-right text-xs">{(fpWeights[key] * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>

              <p className="text-xs text-neutral-500">
                Floor plan evaluations per building: {(fpGenerations * fpPopulationSize).toLocaleString()}
              </p>
            </div>
          )}
        </div>

        {/* Estimated Time */}
        {estimatedTime !== null && (
          <p className="text-xs text-neutral-500">
            Estimated total run time: <span className="font-medium text-neutral-700">{formatDuration(estimatedTime)}</span>
            {includeFloorPlans && " (layouts + floor plans)"}
          </p>
        )}

        {/* Run / Progress */}
        {isRunning ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-neutral-700">
              <span>Phase: {phaseLabel}</span>
            </div>
            <Progress value={progress.pct} />
            <div className="flex justify-between text-xs text-neutral-500">
              <span>
                {progress.phase === "floor_plans"
                  ? `Building ${progress.currentGeneration + 1} / ${progress.totalGenerations}`
                  : `Generation ${progress.currentGeneration} / ${progress.totalGenerations}`}
              </span>
              <span>{progress.pct.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between text-xs text-neutral-400">
              <span>
                {progress.elapsedSeconds !== null
                  ? `Elapsed: ${formatDuration(progress.elapsedSeconds)}`
                  : "Starting..."}
              </span>
              <span>
                {progress.estimatedRemainingSeconds !== null
                  ? `Remaining: ~${formatDuration(progress.estimatedRemainingSeconds)}`
                  : ""}
              </span>
            </div>
            {progress.bestFitness !== null && progress.phase !== "floor_plans" && (
              <p className="text-xs text-neutral-400 text-center">
                Best fitness: {progress.bestFitness.toFixed(4)}
              </p>
            )}
            {progress.phase === "layout" && progress.fitnessHistory.length >= 2 && (
              <FitnessChart
                data={progress.fitnessHistory}
                title="Layout Fitness Over Generations"
              />
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <Button onClick={handleRun} className="w-full" size="lg"
              disabled={!plotAnalysis || !regulations}>
              {includeFloorPlans ? "Run Combined Optimization" : "Run Layout Optimization"}
              {estimatedTime !== null && (
                <span className="ml-2 text-xs opacity-70">~{formatDuration(estimatedTime)}</span>
              )}
            </Button>
            {/* Show completed fitness chart after run finishes */}
            {completedFitnessHistory.length >= 2 && (
              <FitnessChart
                data={completedFitnessHistory}
                title="Layout Fitness Over Generations (Completed)"
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
