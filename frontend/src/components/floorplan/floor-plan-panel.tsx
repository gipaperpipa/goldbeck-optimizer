"use client";

import { useState, useEffect, useCallback } from "react";
import { Building2, Loader2, AlertTriangle, Clock, Zap, Trophy, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/project-store";
import { useFloorPlan } from "@/hooks/use-floor-plan";
import { FloorPlanViewer } from "./floor-plan-viewer";
import { FloorPlanLegend } from "./floor-plan-legend";
import { ApartmentDetail } from "./apartment-detail";
import { FitnessChart } from "../optimization/fitness-chart";
import type { FloorPlanApartment, FloorPlanWeights } from "@/types/api";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

const CRITERION_LABELS: Record<string, string> = {
  net_to_gross: "Net/Gross",
  construction_regularity: "Regularity",
  room_aspect_ratios: "Room Ratios",
  natural_light: "Natural Light",
  noise_separation: "Noise Sep.",
  unit_mix_match: "Mix Match",
  room_size_compliance: "Size Compliance",
  area_balance: "Area Balance",
  fire_egress: "Fire Egress",
  barrier_free: "Barrier Free",
};

const CRITERION_COLORS: Record<string, string> = {
  net_to_gross: "bg-blue-500",
  construction_regularity: "bg-blue-400",
  room_aspect_ratios: "bg-emerald-500",
  natural_light: "bg-amber-500",
  noise_separation: "bg-emerald-400",
  unit_mix_match: "bg-violet-500",
  room_size_compliance: "bg-violet-400",
  area_balance: "bg-violet-300",
  fire_egress: "bg-rose-500",
  barrier_free: "bg-rose-400",
};

export function FloorPlanPanel() {
  const {
    selectedLayout,
    floorPlans,
    floorPlanVariants,
    selectedBuildingId,
    setSelectedBuildingId,
    selectedFloorIndex,
    setSelectedFloorIndex,
    selectedVariantIndex,
    setSelectedVariantIndex,
    setFloorPlan,
  } = useProjectStore();

  const { generate, estimate, isLoading, error, progress, estimatedSeconds, completedFitnessHistory } = useFloorPlan();
  const [selectedApt, setSelectedApt] = useState<FloorPlanApartment | null>(null);
  const [storyHeight, setStoryHeight] = useState(2.90);
  const [generations, setGenerations] = useState(50);
  const [populationSize, setPopulationSize] = useState(20);
  const [useAiGeneration, setUseAiGeneration] = useState(false);
  const [enableStaffelgeschoss, setEnableStaffelgeschoss] = useState(false);
  const [weights, setWeights] = useState<FloorPlanWeights>({
    efficiency: 0.25,
    livability: 0.25,
    revenue: 0.25,
    compliance: 0.25,
  });

  const buildings = selectedLayout?.buildings || [];

  useEffect(() => {
    if (buildings.length > 0 && !selectedBuildingId) {
      setSelectedBuildingId(buildings[0].id);
    }
  }, [buildings, selectedBuildingId, setSelectedBuildingId]);

  const currentBuilding = buildings.find((b) => b.id === selectedBuildingId);
  const currentVariants = selectedBuildingId ? floorPlanVariants[selectedBuildingId] || [] : [];

  const currentFloorPlans = currentVariants.length > 0
    ? currentVariants[Math.min(selectedVariantIndex, currentVariants.length - 1)]?.building_floor_plans
    : selectedBuildingId
      ? floorPlans[selectedBuildingId]
      : null;

  const currentVariant = currentVariants.length > 0
    ? currentVariants[Math.min(selectedVariantIndex, currentVariants.length - 1)]
    : null;

  const currentFloor = currentFloorPlans?.floor_plans[selectedFloorIndex] || null;

  // Estimate runtime
  const updateEstimate = useCallback(() => {
    if (currentBuilding && (generations > 1 || populationSize > 1)) {
      estimate(currentBuilding, generations, populationSize, storyHeight, weights);
    }
  }, [currentBuilding, generations, populationSize, storyHeight, weights, estimate]);

  useEffect(() => {
    const timer = setTimeout(updateEstimate, 300);
    return () => clearTimeout(timer);
  }, [updateEstimate]);

  const handleWeightChange = (key: keyof FloorPlanWeights, value: number) => {
    const raw = { ...weights, [key]: value / 100 };
    const total = raw.efficiency + raw.livability + raw.revenue + raw.compliance;
    if (total > 0) {
      setWeights({
        efficiency: raw.efficiency / total,
        livability: raw.livability / total,
        revenue: raw.revenue / total,
        compliance: raw.compliance / total,
      });
    }
  };

  const handleGenerate = () => {
    if (!currentBuilding) return;
    setSelectedApt(null);
    setSelectedFloorIndex(0);
    setSelectedVariantIndex(0);
    generate(currentBuilding, storyHeight, generations, populationSize, weights, useAiGeneration, enableStaffelgeschoss);
  };

  const handleVariantSelect = (index: number) => {
    setSelectedVariantIndex(index);
    setSelectedFloorIndex(0);
    setSelectedApt(null);
    if (selectedBuildingId && currentVariants[index]) {
      setFloorPlan(selectedBuildingId, currentVariants[index].building_floor_plans);
    }
  };

  if (!selectedLayout) {
    return (
      <div className="text-center py-16">
        <Building2 className="w-12 h-12 mx-auto text-neutral-300 mb-4" />
        <p className="text-neutral-500">Select a layout from the Layouts tab first</p>
      </div>
    );
  }

  const totalEvaluations = generations * populationSize;

  const weightSliders: { key: keyof FloorPlanWeights; label: string; desc: string; color: string }[] = [
    { key: "efficiency", label: "Efficiency", desc: "Net/gross ratio, construction regularity", color: "accent-blue-600" },
    { key: "livability", label: "Livability", desc: "Natural light, noise separation, room proportions", color: "accent-emerald-600" },
    { key: "revenue", label: "Revenue", desc: "Unit count, mix match, area optimization", color: "accent-violet-600" },
    { key: "compliance", label: "Compliance", desc: "Fire egress, barrier-free, room sizes", color: "accent-rose-600" },
  ];

  return (
    <div className="space-y-6">
      {/* Controls bar */}
      <div className="bg-white border rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-neutral-700">Building:</label>
            <select
              className="border rounded px-3 py-1.5 text-sm bg-white"
              value={selectedBuildingId || ""}
              onChange={(e) => {
                setSelectedBuildingId(e.target.value);
                setSelectedApt(null);
                setSelectedFloorIndex(0);
                setSelectedVariantIndex(0);
              }}
            >
              {buildings.map((b, i) => (
                <option key={b.id} value={b.id}>
                  B{i + 1} - {b.width_m.toFixed(1)}x{b.depth_m.toFixed(1)}m, {b.stories}F
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-neutral-700">Story Height:</label>
            <select
              className="border rounded px-3 py-1.5 text-sm bg-white"
              value={storyHeight}
              onChange={(e) => setStoryHeight(parseFloat(e.target.value))}
            >
              <option value={2.90}>2.90m (Standard)</option>
              <option value={3.07}>3.07m (Standard B)</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5 bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-xs font-medium">
            <Building2 className="w-3 h-3" />
            Goldbeck System
          </div>
        </div>

        {/* Generations & Population Size */}
        <div className="flex flex-wrap items-end gap-4 border-t pt-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-neutral-600">Generations</label>
            <input
              type="number"
              min={1}
              max={100000}
              value={generations}
              onChange={(e) => setGenerations(Math.max(1, parseInt(e.target.value) || 1))}
              className="border rounded px-3 py-1.5 text-sm w-28 bg-white"
              disabled={isLoading}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-neutral-600">Variants per Generation</label>
            <input
              type="number"
              min={2}
              max={100000}
              value={populationSize}
              onChange={(e) => setPopulationSize(Math.max(2, parseInt(e.target.value) || 2))}
              className="border rounded px-3 py-1.5 text-sm w-28 bg-white"
              disabled={isLoading}
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 px-3 py-1.5 rounded border border-amber-200 bg-amber-50 hover:bg-amber-100 transition-colors cursor-pointer" style={{ opacity: isLoading ? 0.5 : 1, pointerEvents: isLoading ? "none" : "auto" }}>
              <input
                type="checkbox"
                checked={useAiGeneration}
                onChange={(e) => setUseAiGeneration(e.target.checked)}
                disabled={isLoading}
                className="w-4 h-4 rounded"
              />
              <Sparkles className="w-3.5 h-3.5 text-amber-600" />
              <span className="text-xs font-medium text-amber-900">AI-Assisted</span>
            </label>
            <div className="text-[10px] text-neutral-500 max-w-xs">
              {useAiGeneration && (
                <p className="text-amber-700">Enhanced: +generations, +50% variants, more exploration</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 px-3 py-1.5 rounded border border-sky-200 bg-sky-50 hover:bg-sky-100 transition-colors cursor-pointer" style={{ opacity: isLoading ? 0.5 : 1, pointerEvents: isLoading ? "none" : "auto" }}>
              <input
                type="checkbox"
                checked={enableStaffelgeschoss}
                onChange={(e) => setEnableStaffelgeschoss(e.target.checked)}
                disabled={isLoading}
                className="w-4 h-4 rounded"
              />
              <span className="text-xs font-medium text-sky-900">Staffelgeschoss</span>
            </label>
            {enableStaffelgeschoss && (
              <span className="text-[10px] text-sky-700">Top floor setback (2m) — not counted as Vollgeschoss</span>
            )}
          </div>

          <div className="flex items-center gap-4 text-xs text-neutral-500">
            <div className="flex items-center gap-1">
              <Zap className="w-3 h-3" />
              <span>{totalEvaluations.toLocaleString()} evaluations</span>
            </div>
            {estimatedSeconds !== null && (generations > 1 || populationSize > 1) && (
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <span>Est. {formatDuration(estimatedSeconds)}</span>
              </div>
            )}
          </div>

          <Button
            onClick={handleGenerate}
            disabled={isLoading || !currentBuilding}
            className="ml-auto"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Optimizing...
              </>
            ) : currentFloorPlans ? (
              "Regenerate Floor Plans"
            ) : (
              "Generate Floor Plans"
            )}
          </Button>
        </div>

        {/* Optimization Weights */}
        <div className="border-t pt-4">
          <h4 className="text-xs font-semibold text-neutral-700 mb-3 uppercase tracking-wide">
            Optimization Priorities
          </h4>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            {weightSliders.map(({ key, label, desc, color }) => (
              <div key={key} className="flex items-center gap-3">
                <div className="w-24">
                  <p className="text-xs font-medium text-neutral-700">{label}</p>
                  <p className="text-[10px] text-neutral-400 leading-tight">{desc}</p>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(weights[key] * 100)}
                  onChange={(e) => handleWeightChange(key, parseInt(e.target.value))}
                  className={`flex-1 h-1.5 rounded-lg cursor-pointer ${color}`}
                  disabled={isLoading}
                />
                <span className="text-xs font-mono text-neutral-500 w-8 text-right">
                  {Math.round(weights[key] * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Progress bar */}
        {isLoading && progress && (
          <div className="border-t pt-4 space-y-2">
            <div className="flex items-center justify-between text-xs text-neutral-600">
              <span>
                Generation {progress.currentGeneration} / {progress.totalGenerations}
              </span>
              <div className="flex items-center gap-2">
                {progress.livePreview && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-semibold uppercase">
                    <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                    Live Preview
                  </span>
                )}
                <span>Best fitness: {progress.bestFitness.toFixed(1)}</span>
              </div>
            </div>
            <div className="w-full bg-neutral-200 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-blue-600 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.min(100, progress.progressPct)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>Elapsed: {formatDuration(progress.elapsedSeconds)}</span>
              <span>
                {progress.estimatedRemainingSeconds > 0
                  ? `Remaining: ~${formatDuration(progress.estimatedRemainingSeconds)}`
                  : "Calculating..."}
              </span>
            </div>
            {progress.fitnessHistory && progress.fitnessHistory.length >= 2 && (
              <FitnessChart
                data={progress.fitnessHistory}
                title="Floor Plan Fitness Over Generations"
              />
            )}
          </div>
        )}

        {/* Show completed fitness chart after run finishes */}
        {!isLoading && completedFitnessHistory.length >= 2 && (
          <FitnessChart
            data={completedFitnessHistory}
            title="Floor Plan Fitness Over Generations (Completed)"
          />
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-2 rounded">
            <AlertTriangle className="w-4 h-4" />
            {error}
          </div>
        )}
      </div>

      {/* Variant selector with fitness breakdown */}
      {currentVariants.length > 1 && (
        <div className="bg-white border rounded-lg p-4">
          <h4 className="text-sm font-semibold text-neutral-700 mb-3 flex items-center gap-1.5">
            <Trophy className="w-4 h-4 text-amber-500" />
            Top Variants
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
            {currentVariants.map((variant, idx) => (
              <button
                key={idx}
                onClick={() => handleVariantSelect(idx)}
                className={`p-3 rounded-lg text-left transition-colors border ${
                  selectedVariantIndex === idx
                    ? "bg-blue-50 border-blue-300"
                    : "bg-white border-neutral-200 hover:bg-neutral-50"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-neutral-500">#{variant.rank}</span>
                  <span className="text-sm font-bold text-neutral-800">
                    {variant.fitness_score.toFixed(1)}
                  </span>
                </div>
                {variant.fitness_breakdown && (
                  <div className="space-y-1">
                    {Object.entries(variant.fitness_breakdown).map(([key, value]) => (
                      <div key={key} className="flex items-center gap-1.5">
                        <div className="w-full bg-neutral-100 rounded-full h-1 overflow-hidden flex-1">
                          <div
                            className={`h-full rounded-full ${CRITERION_COLORS[key] || "bg-neutral-400"}`}
                            style={{ width: `${(value / 10) * 100}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-neutral-400 w-16 text-right truncate">
                          {CRITERION_LABELS[key] || key}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Floor selector */}
      {currentFloorPlans && (
        <div className="flex items-center gap-1">
          {currentFloorPlans.floor_plans.map((fp) => (
            <button
              key={fp.floor_index}
              onClick={() => {
                setSelectedFloorIndex(fp.floor_index);
                setSelectedApt(null);
              }}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                selectedFloorIndex === fp.floor_index
                  ? "bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {fp.floor_index === 0 ? "Ground" : `Floor ${fp.floor_index}`}
            </button>
          ))}
        </div>
      )}

      {/* Main content */}
      {currentFloor && currentFloorPlans ? (
        <div className="grid grid-cols-[1fr_280px] gap-4">
          <div>
            <FloorPlanViewer
              floorPlan={currentFloor}
              width={900}
              height={600}
              selectedApartmentId={selectedApt?.id}
              onApartmentSelect={setSelectedApt}
            />
          </div>

          <div className="space-y-4">
            {/* Summary card */}
            <div className="bg-white border rounded-lg p-4 space-y-2">
              <h4 className="font-semibold text-sm text-neutral-700">Building Summary</h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-neutral-500">Dimensions</span>
                  <p className="font-medium">
                    {currentFloorPlans.building_width_m.toFixed(1)} x{" "}
                    {currentFloorPlans.building_depth_m.toFixed(1)}m
                  </p>
                </div>
                <div>
                  <span className="text-neutral-500">Stories</span>
                  <p className="font-medium">{currentFloorPlans.num_stories}</p>
                </div>
                <div>
                  <span className="text-neutral-500">Total Apts</span>
                  <p className="font-medium">{currentFloorPlans.total_apartments}</p>
                </div>
                <div>
                  <span className="text-neutral-500">Access</span>
                  <p className="font-medium capitalize">
                    {currentFloorPlans.access_type === "ganghaus" ? "Corridor" : currentFloorPlans.access_type === "laubengang" ? "Gallery" : "Direct"}
                  </p>
                </div>
              </div>

              {/* Fitness breakdown for selected variant */}
              {currentVariant?.fitness_breakdown && (
                <div className="border-t pt-2 mt-2">
                  <p className="text-xs text-neutral-500 mb-1.5">Fitness Breakdown:</p>
                  <div className="grid grid-cols-2 gap-1">
                    {Object.entries(currentVariant.fitness_breakdown).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between text-[10px]">
                        <span className="text-neutral-500">{CRITERION_LABELS[key] || key}</span>
                        <span className="font-medium text-neutral-700">{value.toFixed(1)}/10</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Apartment breakdown */}
              <div className="border-t pt-2 mt-2">
                <p className="text-xs text-neutral-500 mb-1">Apartment Mix (total):</p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(currentFloorPlans.apartment_summary).map(([type, count]) => (
                    <span
                      key={type}
                      className="bg-neutral-100 text-neutral-700 px-2 py-0.5 rounded text-xs"
                    >
                      {type.replace("_", "-")}: {count}
                    </span>
                  ))}
                </div>
              </div>

              {/* Grid info */}
              <div className="border-t pt-2 mt-2">
                <p className="text-xs text-neutral-500 mb-1">Structural Grid:</p>
                <p className="text-xs font-mono text-neutral-600">
                  {currentFloorPlans.structural_grid.bay_widths
                    .map((w) => `${w.toFixed(2)}m`)
                    .join(" | ")}
                </p>
              </div>
            </div>

            {selectedApt ? (
              <ApartmentDetail apartment={selectedApt} />
            ) : (
              <div className="bg-neutral-50 border border-dashed rounded-lg p-4 text-center text-sm text-neutral-400">
                Click an apartment to see details
              </div>
            )}

            <FloorPlanLegend />
          </div>
        </div>
      ) : !isLoading ? (
        <div className="text-center py-16 bg-neutral-50 rounded-lg border border-dashed">
          <Building2 className="w-16 h-16 mx-auto text-neutral-300 mb-4" />
          <p className="text-neutral-500 mb-2">No floor plan generated yet</p>
          <p className="text-sm text-neutral-400 mb-6">
            Select a building, configure generations, variants &amp; priorities, then click
            &quot;Generate Floor Plans&quot; to optimize the internal layout.
          </p>
          <Button onClick={handleGenerate} disabled={!currentBuilding}>
            Generate Floor Plans
          </Button>
        </div>
      ) : null}
    </div>
  );
}
