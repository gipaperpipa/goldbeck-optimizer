"use client";

import { useState, useCallback, useRef } from "react";
import { apiClient } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import type {
  FloorPlanRequest,
  FloorPlanResult,
  FloorPlanWeights,
  BuildingFootprint,
  FitnessHistoryEntry,
} from "@/types/api";

interface FloorPlanProgress {
  progressPct: number;
  currentGeneration: number;
  totalGenerations: number;
  bestFitness: number;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number;
  fitnessHistory: FitnessHistoryEntry[];
}

export function useFloorPlan() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FloorPlanProgress | null>(null);
  const [estimatedSeconds, setEstimatedSeconds] = useState<number | null>(null);
  // Persisted fitness history that survives isLoading=false
  const [completedFitnessHistory, setCompletedFitnessHistory] = useState<FitnessHistoryEntry[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { setFloorPlan, setFloorPlanVariants, clearFloorPlans } = useProjectStore();

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const estimate = useCallback(
    async (
      building: BuildingFootprint,
      generations: number,
      populationSize: number,
      storyHeight: number = 2.90,
      weights?: FloorPlanWeights,
    ) => {
      try {
        const request: FloorPlanRequest = {
          building_id: building.id,
          building_width_m: building.width_m,
          building_depth_m: building.depth_m,
          stories: building.stories,
          construction_system: "goldbeck",
          story_height_m: storyHeight,
          generations,
          population_size: populationSize,
          weights,
        };
        const result = await apiClient.post<{ estimated_seconds: number }>(
          "/floorplan/estimate",
          request
        );
        setEstimatedSeconds(result.estimated_seconds);
        return result.estimated_seconds;
      } catch {
        setEstimatedSeconds(null);
        return null;
      }
    },
    []
  );

  const generate = useCallback(
    async (
      building: BuildingFootprint,
      storyHeight: number = 2.90,
      generations: number = 1,
      populationSize: number = 1,
      weights?: FloorPlanWeights,
      useAiGeneration: boolean = false,
    ) => {
      setIsLoading(true);
      setError(null);
      setProgress(null);
      setCompletedFitnessHistory([]);
      stopPolling();

      // Clear old results so UI doesn't show stale data during the run
      clearFloorPlans(building.id);

      try {
        const request: FloorPlanRequest = {
          building_id: building.id,
          building_width_m: building.width_m,
          building_depth_m: building.depth_m,
          stories: building.stories,
          rotation_deg: building.rotation_deg,
          unit_mix: building.unit_mix,
          construction_system: "goldbeck",
          story_height_m: storyHeight,
          prefer_barrier_free: true,
          generations,
          population_size: populationSize,
          weights,
          use_ai_generation: useAiGeneration,
        };

        const initial = await apiClient.post<FloorPlanResult>(
          "/floorplan",
          request
        );

        if (initial.status === "completed") {
          if (initial.building_floor_plans) {
            setFloorPlan(building.id, initial.building_floor_plans);
          }
          if (initial.variants?.length > 0) {
            setFloorPlanVariants(building.id, initial.variants);
          }
          setIsLoading(false);
          return;
        }

        if (initial.status === "failed") {
          setError(initial.error || "Floor plan generation failed");
          setIsLoading(false);
          return;
        }

        // Poll for result with progress
        const jobId = initial.job_id;
        intervalRef.current = setInterval(async () => {
          try {
            const result = await apiClient.get<FloorPlanResult>(
              `/floorplan/${jobId}`
            );

            setProgress({
              progressPct: result.progress_pct,
              currentGeneration: result.current_generation,
              totalGenerations: result.total_generations,
              bestFitness: result.best_fitness,
              elapsedSeconds: result.elapsed_seconds,
              estimatedRemainingSeconds: result.estimated_remaining_seconds,
              fitnessHistory: result.fitness_history ?? [],
            });

            if (result.status === "completed") {
              if (result.building_floor_plans) {
                setFloorPlan(building.id, result.building_floor_plans);
              }
              if (result.variants?.length > 0) {
                setFloorPlanVariants(building.id, result.variants);
              }
              // Persist fitness history before clearing progress
              if (result.fitness_history?.length) {
                setCompletedFitnessHistory(result.fitness_history);
              }
              setIsLoading(false);
              setProgress(null);
              stopPolling();
            } else if (result.status === "failed") {
              setError(result.error || "Floor plan generation failed");
              // Still persist whatever history we got
              if (result.fitness_history?.length) {
                setCompletedFitnessHistory(result.fitness_history);
              }
              setIsLoading(false);
              setProgress(null);
              stopPolling();
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Polling error";
            // If server restarted (404 = job lost), show a clear message
            if (msg.includes("Job not found") || msg.includes("404")) {
              setError("Server restarted during generation — please run again.");
            } else {
              setError(msg);
            }
            setIsLoading(false);
            setProgress(null);
            stopPolling();
          }
        }, 1000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start generation");
        setIsLoading(false);
      }
    },
    [setFloorPlan, setFloorPlanVariants, clearFloorPlans, stopPolling]
  );

  const cancel = useCallback(() => {
    stopPolling();
    setIsLoading(false);
    setProgress(null);
  }, [stopPolling]);

  return { generate, estimate, cancel, isLoading, error, progress, estimatedSeconds, completedFitnessHistory };
}
