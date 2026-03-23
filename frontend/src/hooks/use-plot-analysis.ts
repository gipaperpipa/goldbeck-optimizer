"use client";

import { useState, useCallback } from "react";
import { apiClient } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import type { PlotInput, PlotAnalysis } from "@/types/api";

export function usePlotAnalysis() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setPlotAnalysis } = useProjectStore();

  const analyze = useCallback(async (input: PlotInput) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await apiClient.post<PlotAnalysis>("/plot/analyze", input);
      setPlotAnalysis(result);
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Analysis failed";
      setError(msg);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [setPlotAnalysis]);

  return { analyze, isLoading, error };
}
