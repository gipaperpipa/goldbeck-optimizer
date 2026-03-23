"use client";

import { useState, useCallback, useRef } from "react";
import { apiClient } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import type { OptimizationRequest, OptimizationResult, FitnessHistoryEntry } from "@/types/api";

export interface OptimizationProgress {
  pct: number;
  currentGeneration: number;
  totalGenerations: number;
  elapsedSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  bestFitness: number | null;
  phase: "layout" | "floor_plans";
  fitnessHistory: FitnessHistoryEntry[];
}

export function useOptimization() {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<OptimizationProgress>({
    pct: 0,
    currentGeneration: 0,
    totalGenerations: 0,
    elapsedSeconds: null,
    estimatedRemainingSeconds: null,
    bestFitness: null,
    phase: "layout",
    fitnessHistory: [],
  });
  // Persisted fitness history that survives isRunning=false
  const [completedFitnessHistory, setCompletedFitnessHistory] = useState<FitnessHistoryEntry[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { setOptimizationResult } = useProjectStore();

  const estimateRuntime = useCallback(async (request: OptimizationRequest): Promise<number> => {
    try {
      const result = await apiClient.post<{ estimated_seconds: number }>("/optimize/estimate", request);
      return result.estimated_seconds;
    } catch {
      // Fallback client-side estimate
      return (request.population_size * request.generations * 0.0005);
    }
  }, []);

  const startOptimization = useCallback(async (request: OptimizationRequest) => {
    setIsRunning(true);
    setCompletedFitnessHistory([]);
    setProgress({
      pct: 0,
      currentGeneration: 0,
      totalGenerations: request.generations,
      elapsedSeconds: null,
      estimatedRemainingSeconds: null,
      bestFitness: null,
      phase: "layout",
      fitnessHistory: [],
    });

    try {
      const initial = await apiClient.post<OptimizationResult>("/optimize", request);
      const jobId = initial.job_id;

      pollRef.current = setInterval(async () => {
        try {
          const result = await apiClient.get<OptimizationResult>(`/optimize/${jobId}`);
          setProgress({
            pct: result.progress_pct,
            currentGeneration: result.current_generation,
            totalGenerations: result.total_generations,
            elapsedSeconds: result.elapsed_seconds ?? null,
            estimatedRemainingSeconds: result.estimated_remaining_seconds ?? null,
            bestFitness: result.best_fitness ?? null,
            phase: result.phase ?? "layout",
            fitnessHistory: result.fitness_history ?? [],
          });

          if (result.status === "completed" || result.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            // Persist the final fitness history before stopping
            if (result.fitness_history?.length) {
              setCompletedFitnessHistory(result.fitness_history);
            }
            setIsRunning(false);
            setOptimizationResult(result);
          }
        } catch (err) {
          if (pollRef.current) clearInterval(pollRef.current);
          setIsRunning(false);
          // If the server restarted, the job is lost
          const msg = err instanceof Error ? err.message : "";
          if (msg.includes("Job not found") || msg.includes("404")) {
            console.error("Server restarted during optimization — job lost");
          }
        }
      }, 1000);
    } catch (error) {
      setIsRunning(false);
      throw error;
    }
  }, [setOptimizationResult]);

  const cancel = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setIsRunning(false);
  }, []);

  return { startOptimization, estimateRuntime, cancel, isRunning, progress, completedFitnessHistory };
}
