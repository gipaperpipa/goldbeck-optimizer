"use client";

import { useState, useCallback, useRef } from "react";
import { apiClient } from "@/lib/api-client";
import type { AddressSearchResult, ParcelInfo, PlotAnalysis } from "@/types/api";
import { useProjectStore } from "@/stores/project-store";

/**
 * Hook for German cadastral (Kataster) operations:
 * - Address search via Nominatim
 * - Parcel identification at a click point
 * - Parcel merging into a PlotAnalysis
 */
export function useCadastral() {
  const [searchResults, setSearchResults] = useState<AddressSearchResult[]>([]);
  const [selectedParcels, setSelectedParcels] = useState<ParcelInfo[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingParcel, setIsLoadingParcel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectedState, setDetectedState] = useState<string | null>(null);
  const { setPlotAnalysis } = useProjectStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Address search ──────────────────────────────────────

  const searchAddress = useCallback(async (query: string) => {
    if (query.length < 3) {
      setSearchResults([]);
      return;
    }

    // Debounce: cancel previous timer
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      setError(null);
      try {
        const results = await apiClient.get<AddressSearchResult[]>(
          `/cadastral/search?q=${encodeURIComponent(query)}&limit=5`
        );
        setSearchResults(results);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Address search failed";
        setError(msg);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, []);

  // ── State detection ─────────────────────────────────────

  const detectState = useCallback(async (lng: number, lat: number) => {
    try {
      const result = await apiClient.get<{ state: string; has_wms: boolean }>(
        `/cadastral/state?lng=${lng}&lat=${lat}`
      );
      setDetectedState(result.state);
      return result;
    } catch {
      setDetectedState(null);
      return null;
    }
  }, []);

  // ── Parcel selection ────────────────────────────────────

  const selectParcelAtPoint = useCallback(async (lng: number, lat: number) => {
    setIsLoadingParcel(true);
    setError(null);
    try {
      const parcel = await apiClient.get<ParcelInfo | null>(
        `/cadastral/parcel/at-point?lng=${lng}&lat=${lat}`
      );
      if (parcel && parcel.polygon_wgs84 && parcel.polygon_wgs84.length > 0) {
        setSelectedParcels((prev) => {
          // Don't add duplicates
          const exists = prev.some((p) => p.parcel_id === parcel.parcel_id);
          if (exists) {
            // Deselect if already selected
            return prev.filter((p) => p.parcel_id !== parcel.parcel_id);
          }
          return [...prev, parcel];
        });
        if (parcel.state) {
          setDetectedState(parcel.state);
        }
        return parcel;
      } else {
        setError("No parcel found at this location. Try clicking directly on a parcel boundary.");
        return null;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to fetch parcel data";
      setError(msg);
      return null;
    } finally {
      setIsLoadingParcel(false);
    }
  }, []);

  // ── Remove a parcel from selection ──────────────────────

  const removeParcel = useCallback((parcelId: string) => {
    setSelectedParcels((prev) => prev.filter((p) => p.parcel_id !== parcelId));
  }, []);

  // ── Clear all selections ────────────────────────────────

  const clearParcels = useCallback(() => {
    setSelectedParcels([]);
    setError(null);
  }, []);

  // ── Merge parcels into PlotAnalysis ─────────────────────

  const confirmSelection = useCallback(async () => {
    if (selectedParcels.length === 0) {
      setError("No parcels selected");
      return null;
    }

    setIsLoadingParcel(true);
    setError(null);
    try {
      const analysis = await apiClient.post<PlotAnalysis>("/cadastral/parcels/merge", {
        parcels: selectedParcels,
      });
      setPlotAnalysis(analysis);
      return analysis;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to merge parcels";
      setError(msg);
      return null;
    } finally {
      setIsLoadingParcel(false);
    }
  }, [selectedParcels, setPlotAnalysis]);

  return {
    // Address search
    searchResults,
    searchAddress,
    isSearching,

    // State
    detectedState,
    detectState,

    // Parcel selection
    selectedParcels,
    selectParcelAtPoint,
    removeParcel,
    clearParcels,
    isLoadingParcel,

    // Merge & confirm
    confirmSelection,

    // Error
    error,
    setError,
  };
}
