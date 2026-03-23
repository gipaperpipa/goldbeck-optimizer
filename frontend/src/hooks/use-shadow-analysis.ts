"use client";

import { useState, useCallback } from "react";
import { apiClient } from "@/lib/api-client";
import type { ShadowResult } from "@/types/api";

export function useShadowAnalysis() {
  const [result, setResult] = useState<ShadowResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const analyze = useCallback(async (request: unknown) => {
    setIsLoading(true);
    try {
      const data = await apiClient.post<ShadowResult>("/shadow/analyze", request);
      setResult(data);
      return data;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { analyze, result, isLoading };
}
