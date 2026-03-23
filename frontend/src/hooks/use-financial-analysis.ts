"use client";

import { useState, useCallback } from "react";
import { apiClient } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import type { FinancialAnalysisRequest, FinancialAnalysis } from "@/types/api";

export function useFinancialAnalysis() {
  const [isLoading, setIsLoading] = useState(false);
  const { setFinancialAnalysis } = useProjectStore();

  const analyze = useCallback(async (request: FinancialAnalysisRequest) => {
    setIsLoading(true);
    try {
      const result = await apiClient.post<FinancialAnalysis>("/financial/analyze", request);
      setFinancialAnalysis(result);
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [setFinancialAnalysis]);

  return { analyze, isLoading };
}
