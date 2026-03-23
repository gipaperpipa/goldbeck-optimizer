"use client";

import { useState, useCallback } from "react";
import { apiClient } from "@/lib/api-client";
import { useProjectStore } from "@/stores/project-store";
import type { RegulationLookupResponse } from "@/types/api";

export function useRegulationLookup() {
  const [isLoading, setIsLoading] = useState(false);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const { setRegulations } = useProjectStore();

  const lookup = useCallback(async (address: string, city?: string, state?: string) => {
    setIsLoading(true);
    try {
      const result = await apiClient.post<RegulationLookupResponse>(
        "/regulations/lookup",
        { address, city, state }
      );
      setRegulations(result.regulations);
      setConfidence(result.confidence);
      setNotes(result.notes);
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [setRegulations]);

  return { lookup, isLoading, confidence, notes };
}
