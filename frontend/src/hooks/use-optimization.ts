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
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track active job so stale polls from a previous run are ignored
  const activeJobRef = useRef<string | null>(null);
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

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    activeJobRef.current = null;
  }, []);

  const startOptimization = useCallback(async (request: OptimizationRequest) => {
    // Cancel any previous run
    stopPolling();
    setIsRunning(true);
    setError(null);
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
      activeJobRef.current = jobId;

      pollRef.current = setInterval(async () => {
        // If a newer optimization was started, ignore this stale poll
        if (activeJobRef.current !== jobId) {
          return;
        }
        try {
          const result = await apiClient.get<OptimizationResult>(`/optimize/${jobId}`);

          // Double-check after await
          if (activeJobRef.current !== jobId) {
            return;
          }

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

          if (result.status === "completed") {
            // Persist the final fitness history before stopping
            if (result.fitness_history?.length) {
              setCompletedFitnessHistory(result.fitness_history);
            }
            stopPolling();
            setIsRunning(false);
            setOptimizationResult(result);
            // L15: Browser notification when tab is not focused
            if (document.hidden && "Notification" in window && Notification.permission === "granted") {
              new Notification("Optimierung abgeschlossen", {
                body: `${result.layouts?.length ?? 0} Layouts generiert`,
              });
            }
          } else if (result.status === "failed") {
            if (result.fitness_history?.length) {
              setCompletedFitnessHistory(result.fitness_history);
            }
            setError(result.error || "Optimization failed");
            stopPolling();
            setIsRunning(false);
            setOptimizationResult(result);
          }
        } catch (err) {
          // If a newer job superseded us, silently stop
          if (activeJobRef.current !== jobId) {
            return;
          }
          stopPolling();
          setIsRunning(false);
          const msg = err instanceof Error ? err.message : "Polling error";
          if (msg.includes("Job not found") || msg.includes("404")) {
            setError("Server restarted during optimization — please run again.");
          } else {
            setError(msg);
          }
        }
      }, 1000);
    } catch (err) {
      setIsRunning(false);
      setError(err instanceof Error ? err.message : "Failed to start optimization");
    }
  }, [setOptimizationResult, stopPolling]);

  const cancel = useCallback(() => {
    stopPolling();
    setIsRunning(false);
  }, [stopPolling]);

  return { startOptimization, estimateRuntime, cancel, isRunning, error, progress, completedFitnessHistory };
}
