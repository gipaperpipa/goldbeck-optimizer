"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCadastral } from "@/hooks/use-cadastral";
import type { AddressSearchResult, ParcelInfo } from "@/types/api";
import { API_BASE } from "@/lib/api-client";

/**
 * Minimum zoom level for cadastral interactions (parcel click, radius load).
 * At zoom < 15, parcels are too small to identify and WFS bounding boxes
 * would return too many results.
 */
const MIN_CADASTRAL_ZOOM = 15;

// Status → color mapping for parcels
const STATUS_COLORS: Record<string, string> = {
  available: "#6b7280",       // gray
  under_negotiation: "#f59e0b", // amber
  acquired: "#22c55e",        // green
  rejected: "#ef4444",        // red
};

/** Props for the Mapbox GL cadastral map with parcel selection.
 * @property onPlotConfirmed - Called after the user confirms parcel selection
 *   and the merge API returns a PlotAnalysis.
 */
interface CadastralMapProps {
  onPlotConfirmed: () => void;
}

export function CadastralMap({ onPlotConfirmed }: CadastralMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const mountedRef = useRef(true);
  const [isMapReady, setIsMapReady] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [currentState, setCurrentState] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(6);
  const [radiusM, setRadiusM] = useState(300);
  const lastLoadCenter = useRef<string>("");
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickDebounceRef = useRef(false);

  const {
    searchResults,
    searchAddress,
    isSearching,
    selectedParcels,
    selectParcelAtPoint,
    removeParcel,
    clearParcels,
    isLoadingParcel,
    isLoadingNearby,
    nearbyParcels,
    loadParcelsInRadius,
    confirmSelection,
    error,
    setError,
    detectedState,
    detectState,
  } = useCadastral();

  // ── Update nearby parcels on map ────────────────────────

  const updateNearbyLayer = useCallback(
    (parcels: ParcelInfo[]) => {
      const map = mapRef.current;
      if (!map || !isMapReady) return;

      const source = map.getSource("nearby-parcels") as mapboxgl.GeoJSONSource;
      if (!source) return;

      const features = parcels
        .filter((p) => p.polygon_wgs84 && p.polygon_wgs84.length >= 3)
        .map((p) => {
          const status = p.metadata?.status || "available";
          const isSelected = selectedParcels.some(
            (sp) => (sp.id || sp.parcel_id) === (p.id || p.parcel_id)
          );
          return {
            type: "Feature" as const,
            properties: {
              id: p.id || p.parcel_id,
              parcel_id: p.parcel_id || "",
              flurstueck_nr: p.flurstueck_nr || "",
              gemarkung: p.gemarkung || "",
              area_sqm: p.area_sqm || 0,
              status,
              is_selected: isSelected ? 1 : 0,
              color: isSelected ? "#3b82f6" : (STATUS_COLORS[status] || "#6b7280"),
              project_count: p.project_count || 0,
            },
            geometry: {
              type: "Polygon" as const,
              coordinates: [
                [
                  ...p.polygon_wgs84.map((c) => [c[0], c[1]]),
                  [p.polygon_wgs84[0][0], p.polygon_wgs84[0][1]],
                ],
              ],
            },
          };
        });

      source.setData({ type: "FeatureCollection", features });
    },
    [isMapReady, selectedParcels]
  );

  // ── Trigger nearby parcel loading ───────────────────────

  const triggerNearbyLoad = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < MIN_CADASTRAL_ZOOM) return;

    const center = map.getCenter();
    detectState(center.lng, center.lat);
    const parcels = await loadParcelsInRadius(center.lng, center.lat, radiusM);
    if (parcels && parcels.length > 0) {
      lastLoadCenter.current = `${center.lng.toFixed(4)},${center.lat.toFixed(4)},${radiusM}`;
    }
  }, [loadParcelsInRadius, detectState, radiusM]);

  // ── Update map when nearby parcels change ───────────────

  useEffect(() => {
    updateNearbyLayer(nearbyParcels);
  }, [nearbyParcels, updateNearbyLayer]);

  // ── Initialize map ────────────────────────────────────────

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [10.45, 51.16],
      zoom: 6,
    });

    map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

    map.on("load", () => {
      setIsMapReady(true);

      // ── WMS cadastral overlay placeholder (added dynamically per state) ─────

      // ── Nearby parcels (from DB, cache-first) ─────────
      map.addSource("nearby-parcels", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Parcel fills — color by status
      map.addLayer({
        id: "nearby-parcels-fill",
        type: "fill",
        source: "nearby-parcels",
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": [
            "case",
            ["==", ["get", "is_selected"], 1], 0.3,
            ["!=", ["get", "status"], "available"], 0.15,
            0.05,
          ],
        },
        minzoom: 15,
      });

      // Parcel outlines — thicker for selected, color by status
      map.addLayer({
        id: "nearby-parcels-outline",
        type: "line",
        source: "nearby-parcels",
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "case",
            ["==", ["get", "is_selected"], 1], 3,
            1.5,
          ],
          "line-opacity": 0.9,
        },
        minzoom: 15,
      });

      // Parcel labels at high zoom
      map.addLayer({
        id: "nearby-parcels-labels",
        type: "symbol",
        source: "nearby-parcels",
        minzoom: 18,
        layout: {
          "text-field": ["get", "flurstueck_nr"],
          "text-size": 10,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#374151",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      // ── Selected parcels (explicit user selection) ─────
      map.addSource("selected-parcels", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "selected-parcels-fill",
        type: "fill",
        source: "selected-parcels",
        paint: {
          "fill-color": "#3b82f6",
          "fill-opacity": 0.3,
        },
      });

      map.addLayer({
        id: "selected-parcels-outline",
        type: "line",
        source: "selected-parcels",
        paint: {
          "line-color": "#2563eb",
          "line-width": 3,
        },
      });
    });

    // Click handler — select/deselect parcels (debounced to prevent rapid duplicates)
    map.on("click", async (e) => {
      if (map.getZoom() < MIN_CADASTRAL_ZOOM) return;
      if (clickDebounceRef.current) return;
      clickDebounceRef.current = true;
      setTimeout(() => { clickDebounceRef.current = false; }, 300);
      selectParcelAtPoint(e.lngLat.lng, e.lngLat.lat);
    });

    // Track zoom reactively
    map.on("zoom", () => {
      const z = map.getZoom();
      setZoomLevel(z);
      map.getCanvas().style.cursor = z >= MIN_CADASTRAL_ZOOM ? "crosshair" : "";
    });

    // Load parcels + detect state on map move (debounced)
    map.on("moveend", () => {
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = setTimeout(async () => {
        if (map.getZoom() >= MIN_CADASTRAL_ZOOM) {
          const center = map.getCenter();
          // Detect state for WMS overlay (cheap API call, cached on backend)
          detectState(center.lng, center.lat);
          // Load parcel polygons via WFS
          const key = `${center.lng.toFixed(4)},${center.lat.toFixed(4)},${radiusM}`;
          if (key !== lastLoadCenter.current) {
            const parcels = await loadParcelsInRadius(center.lng, center.lat, radiusM);
            // Only cache key if we got results — allow retry on failure
            if (parcels && parcels.length > 0) {
              lastLoadCenter.current = key;
            }
          }
        }
      }, 500);
    });

    mapRef.current = map;

    return () => {
      mountedRef.current = false;
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, [selectParcelAtPoint, loadParcelsInRadius, detectState, radiusM]);

  // ── Update state badge + WMS cadastral overlay ──────────

  useEffect(() => {
    if (detectedState && detectedState !== currentState) {
      setCurrentState(detectedState);
    }
  }, [detectedState, currentState]);

  // Add/update the WMS cadastral tile overlay when state changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !currentState) return;

    const sourceId = "cadastral-wms";
    const layerId = "cadastral-wms-layer";

    // Remove existing WMS layer/source if switching states
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    const tileUrl =
      `${API_BASE}/v1/cadastral/wms/tile` +
      `?state=${encodeURIComponent(currentState)}` +
      `&bbox={bbox-epsg-3857}&width=256&height=256&crs=EPSG:3857`;

    map.addSource(sourceId, {
      type: "raster",
      tiles: [tileUrl],
      tileSize: 256,
    });

    // Insert below the GeoJSON parcel layers so interactive fills stay on top
    const beforeLayer = map.getLayer("nearby-parcels-fill")
      ? "nearby-parcels-fill"
      : undefined;

    map.addLayer(
      {
        id: layerId,
        type: "raster",
        source: sourceId,
        paint: { "raster-opacity": 0.55 },
        minzoom: MIN_CADASTRAL_ZOOM,
      },
      beforeLayer
    );
  }, [currentState, isMapReady]);

  // ── Update selected parcels layer ───────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const source = map.getSource("selected-parcels") as mapboxgl.GeoJSONSource;
    if (!source) return;

    const features = selectedParcels
      .filter((p) => p.polygon_wgs84 && p.polygon_wgs84.length >= 3)
      .map((p) => ({
        type: "Feature" as const,
        properties: {
          parcel_id: p.parcel_id,
          area_sqm: p.area_sqm,
        },
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              ...p.polygon_wgs84.map((c) => [c[0], c[1]]),
              [p.polygon_wgs84[0][0], p.polygon_wgs84[0][1]],
            ],
          ],
        },
      }));

    source.setData({ type: "FeatureCollection", features });

    // Also refresh nearby layer to update is_selected flags
    updateNearbyLayer(nearbyParcels);
  }, [selectedParcels, isMapReady, nearbyParcels, updateNearbyLayer]);

  // ── Address search ──────────────────────────────────────

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    searchAddress(value);
    setShowDropdown(true);
  };

  const handleSelectAddress = (result: AddressSearchResult) => {
    const map = mapRef.current;
    if (!map) return;

    setSearchQuery(result.display_name);
    setShowDropdown(false);

    map.flyTo({
      center: [result.lng, result.lat],
      zoom: 17,
      duration: 2000,
    });

    if (result.state) {
      setCurrentState(result.state);
    }

    // Trigger parcel loading at destination (guard against unmount)
    setTimeout(() => {
      if (mountedRef.current) {
        loadParcelsInRadius(result.lng, result.lat, radiusM);
      }
    }, 2200);
  };

  // ── Confirm selection ───────────────────────────────────

  const handleConfirm = async () => {
    const analysis = await confirmSelection();
    if (analysis) {
      onPlotConfirmed();
    }
  };

  // ── Total area ──────────────────────────────────────────

  const totalArea = selectedParcels.reduce((sum, p) => sum + p.area_sqm, 0);

  // ── Render ──────────────────────────────────────────────

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  if (!token) {
    return (
      <div className="w-full h-[600px] bg-neutral-100 rounded-lg flex items-center justify-center">
        <div className="text-center text-neutral-500">
          <p className="font-medium">Map requires a Mapbox token</p>
          <p className="text-sm mt-1">
            Set NEXT_PUBLIC_MAPBOX_TOKEN in frontend/.env.local
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Address Search + Radius Selector */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
            placeholder="Adresse eingeben... (z.B. Berliner Str. 10, M\u00FCnchen)"
            className="w-full"
          />
          {isSearching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="h-4 w-4 border-2 border-neutral-300 border-t-blue-500 rounded-full animate-spin" />
            </div>
          )}

          {showDropdown && searchResults.length > 0 && (
            <div className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-60 overflow-y-auto">
              {searchResults.map((result, i) => (
                <button
                  key={i}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 border-b last:border-b-0"
                  onClick={() => handleSelectAddress(result)}
                >
                  <span className="font-medium">
                    {result.display_name.split(",")[0]}
                  </span>
                  <span className="text-neutral-500 text-xs block truncate">
                    {result.display_name.split(",").slice(1).join(",")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Radius selector */}
        <select
          value={radiusM}
          onChange={(e) => {
            setRadiusM(Number(e.target.value));
            lastLoadCenter.current = ""; // Force reload
          }}
          className="border rounded-md px-2 py-1.5 text-sm bg-white min-w-[100px]"
        >
          <option value={200}>200m</option>
          <option value={300}>300m</option>
          <option value={500}>500m</option>
          <option value={1000}>1 km</option>
          <option value={2000}>2 km</option>
        </select>
      </div>

      {/* Map */}
      <div className="relative">
        <div ref={mapContainer} className="w-full h-[550px] rounded-lg border" />

        {!isMapReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 rounded-lg">
            <p className="text-neutral-500">Karte wird geladen...</p>
          </div>
        )}

        {isLoadingParcel && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-white/90 px-3 py-1.5 rounded-full shadow text-sm">
            <span className="inline-block h-3 w-3 border-2 border-neutral-300 border-t-blue-500 rounded-full animate-spin mr-2 align-middle" />
            Flurst\u00FCck wird geladen...
          </div>
        )}

        {isLoadingNearby && (
          <div className="absolute top-3 left-3 bg-white/90 px-2 py-1 rounded text-xs text-neutral-600 shadow flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 border-2 border-neutral-300 border-t-blue-500 rounded-full animate-spin" />
            Katasterdaten laden...
          </div>
        )}

        {/* WMS-only hint: shown when zoomed in but no polygons loaded */}
        {isMapReady && zoomLevel >= MIN_CADASTRAL_ZOOM && !isLoadingNearby && nearbyParcels.length === 0 && currentState && (
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-1.5 rounded-lg shadow max-w-xs text-center">
            Katastergrenzen sichtbar (WMS). Klicken Sie auf ein Flurst&uuml;ck um es auszuw&auml;hlen.
          </div>
        )}

        {/* Zoom hint */}
        {isMapReady && zoomLevel < 15 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/70 text-white text-xs px-3 py-1.5 rounded-full">
            N\u00E4her heranzoomen um Flurst\u00FCcke zu sehen (Zoom{" "}
            {Math.round(zoomLevel)}/15)
          </div>
        )}

        {/* Parcel count + state badge */}
        <div className="absolute top-3 right-3 flex flex-col gap-1.5 items-end">
          {currentState && (
            <div className="bg-white/90 px-2 py-1 rounded text-xs text-neutral-600 shadow">
              {currentState}
            </div>
          )}
          {nearbyParcels.length > 0 && (
            <div className="bg-white/90 px-2 py-1 rounded text-xs text-neutral-600 shadow">
              {nearbyParcels.length} Flurst\u00FCcke geladen
            </div>
          )}
        </div>

        {/* Legend */}
        {nearbyParcels.length > 0 && (
          <div className="absolute bottom-3 right-3 bg-white/90 px-2.5 py-2 rounded shadow text-xs space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm border-2 border-blue-500 bg-blue-500/30" />
              Ausgew\u00E4hlt
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm border-2 border-gray-500 bg-gray-500/10" />
              Verf\u00FCgbar
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm border-2 border-amber-500 bg-amber-500/15" />
              In Verhandlung
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm border-2 border-green-500 bg-green-500/15" />
              Erworben
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm text-red-700">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            &times;
          </button>
        </div>
      )}

      {/* Selected Parcels Summary */}
      {selectedParcels.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-blue-900">
              {selectedParcels.length} Flurst\u00FCck
              {selectedParcels.length > 1 ? "e" : ""} ausgew\u00E4hlt
            </h4>
            <button
              className="text-xs text-blue-600 hover:underline"
              onClick={clearParcels}
            >
              Alle entfernen
            </button>
          </div>

          <div className="space-y-1">
            {selectedParcels.map((p) => {
              const key = p.id || p.parcel_id;
              const isSynthetic =
                p.parcel_id === "synthetic" || p.parcel_id === "not_found";
              const isOverpass = p.parcel_id?.startsWith("overpass_");
              return (
                <div
                  key={key}
                  className="flex items-center justify-between text-xs"
                >
                  <span
                    className={
                      isSynthetic ? "text-amber-700" : "text-blue-800"
                    }
                  >
                    {isSynthetic ? (
                      `\u26A0 Platzhalter \u2014 ${p.area_sqm.toFixed(0)} m\u00B2 (bitte anpassen)`
                    ) : (
                      <>
                        {p.gemarkung ? `${p.gemarkung} ` : ""}
                        Flst. {p.flurstueck_nr || p.parcel_id?.slice(-8)}
                        {p.area_sqm > 0 &&
                          ` \u2014 ${p.area_sqm.toFixed(0)} m\u00B2`}
                        {isOverpass && " (OSM)"}
                        {p.source && !isOverpass && ` [${p.source}]`}
                      </>
                    )}
                  </span>
                  <button
                    className="text-red-500 hover:text-red-700 ml-2"
                    onClick={() => removeParcel(key)}
                  >
                    &times;
                  </button>
                </div>
              );
            })}
          </div>

          {selectedParcels.length > 1 && (
            <div className="mt-2 pt-2 border-t border-blue-200 text-xs text-blue-800">
              Gesamtfl\u00E4che:{" "}
              <strong>{totalArea.toFixed(0)} m\u00B2</strong> (
              {(totalArea / 10000).toFixed(2)} ha)
            </div>
          )}

          <div className="flex gap-2 mt-3">
            <Button
              className="flex-1"
              onClick={handleConfirm}
              disabled={isLoadingParcel}
            >
              {isLoadingParcel
                ? "Wird berechnet..."
                : `Grundst\u00FCck \u00FCbernehmen (${totalArea.toFixed(0)} m\u00B2)`}
            </Button>
          </div>
        </div>
      )}

      {/* Instructions */}
      {selectedParcels.length === 0 && (
        <p className="text-xs text-neutral-500">
          Suchen Sie eine Adresse und zoomen Sie heran. Alle Flurst\u00FCcke im
          gew\u00E4hlten Radius werden automatisch geladen und in der Datenbank
          gespeichert. Klicken Sie auf Flurst\u00FCcke, um sie f\u00FCr Ihr
          Projekt auszuw\u00E4hlen.
        </p>
      )}
    </div>
  );
}
