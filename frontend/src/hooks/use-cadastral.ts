"use client";

import { useState, useCallback, useRef } from "react";
import { apiClient } from "@/lib/api-client";
import type { AddressSearchResult, ParcelInfo, PlotAnalysis } from "@/types/api";
import { useProjectStore } from "@/stores/project-store";

/**
 * Hook for German cadastral (Kataster) operations:
 * - Address search via Nominatim
 * - Cache-first parcel loading (DB → WFS → store)
 * - Parcel identification at a click point
 * - Parcel merging into a PlotAnalysis
 */
export function useCadastral() {
  const [searchResults, setSearchResults] = useState<AddressSearchResult[]>([]);
  const [selectedParcels, setSelectedParcels] = useState<ParcelInfo[]>([]);
  const [nearbyParcels, setNearbyParcels] = useState<ParcelInfo[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingParcel, setIsLoadingParcel] = useState(false);
  const [isLoadingNearby, setIsLoadingNearby] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectedState, setDetectedState] = useState<string | null>(null);
  const { setPlotAnalysis } = useProjectStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nearbyAbortRef = useRef<AbortController | null>(null);

  // ── Address search ──────────────────────────────────────

  const searchAddress = useCallback(async (query: string) => {
    if (query.length < 3) {
      setSearchResults([]);
      return;
    }

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

  // ── Cache-first radius loading ──────────────────────────

  const loadParcelsInRadius = useCallback(async (
    lng: number,
    lat: number,
    radiusM: number = 500,
  ) => {
    // Abort previous request
    if (nearbyAbortRef.current) {
      nearbyAbortRef.current.abort();
    }
    const controller = new AbortController();
    nearbyAbortRef.current = controller;

    setIsLoadingNearby(true);
    try {
      const url = `/parcels/in-radius?lng=${lng}&lat=${lat}&radius_m=${radiusM}`;
      const parcels = await apiClient.get<ParcelInfo[]>(url);
      if (!controller.signal.aborted) {
        setNearbyParcels(parcels);
      }
      return parcels;
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return [];
      console.warn("Failed to load nearby parcels:", e);
      return [];
    } finally {
      if (!controller.signal.aborted) {
        setIsLoadingNearby(false);
      }
    }
  }, []);

  // ── Cache-first parcel selection (click) ────────────────

  const selectParcelAtPoint = useCallback(async (lng: number, lat: number) => {
    setIsLoadingParcel(true);
    setError(null);
    try {
      // Use new cache-first endpoint
      const parcel = await apiClient.get<ParcelInfo | null>(
        `/parcels/at-point?lng=${lng}&lat=${lat}`
      );
      if (parcel && parcel.polygon_wgs84 && parcel.polygon_wgs84.length > 0) {
        // Use the DB id as the unique key if available
        const parcelKey = parcel.id || parcel.parcel_id;
        setSelectedParcels((prev) => {
          const exists = prev.some((p) => (p.id || p.parcel_id) === parcelKey);
          if (exists) {
            // Deselect if already selected
            return prev.filter((p) => (p.id || p.parcel_id) !== parcelKey);
          }
          return [...prev, parcel];
        });
        if (parcel.state) {
          setDetectedState(parcel.state);
        }
        return parcel;
      } else {
        setError("Kein Flurstück gefunden. Versuchen Sie einen anderen Punkt.");
        return null;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Flurstück konnte nicht geladen werden";
      setError(msg);
      return null;
    } finally {
      setIsLoadingParcel(false);
    }
  }, []);

  // ── Remove a parcel from selection ──────────────────────

  const removeParcel = useCallback((parcelId: string) => {
    setSelectedParcels((prev) =>
      prev.filter((p) => p.parcel_id !== parcelId && p.id !== parcelId)
    );
  }, []);

  // ── Clear all selections ────────────────────────────────

  const clearParcels = useCallback(() => {
    setSelectedParcels([]);
    setError(null);
  }, []);

  // ── Merge parcels into PlotAnalysis ─────────────────────

  const confirmSelection = useCallback(async () => {
    if (selectedParcels.length === 0) {
      setError("Keine Flurstücke ausgewählt");
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
      const msg = e instanceof Error ? e.message : "Zusammenführung fehlgeschlagen";
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

    // Nearby parcels (radius loading)
    nearbyParcels,
    loadParcelsInRadius,
    isLoadingNearby,

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
