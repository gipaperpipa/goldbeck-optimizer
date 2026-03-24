"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCadastral } from "@/hooks/use-cadastral";
import type { AddressSearchResult, ParcelInfo } from "@/types/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

interface CadastralMapProps {
  onPlotConfirmed: () => void;
}

export function CadastralMap({ onPlotConfirmed }: CadastralMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [currentState, setCurrentState] = useState<string | null>(null);
  const [wmsAdded, setWmsAdded] = useState(false);

  const {
    searchResults,
    searchAddress,
    isSearching,
    selectedParcels,
    selectParcelAtPoint,
    removeParcel,
    clearParcels,
    isLoadingParcel,
    confirmSelection,
    error,
    setError,
    detectedState,
  } = useCadastral();

  // ── Initialize map ────────────────────────────────────────

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [10.45, 51.16], // Center of Germany
      zoom: 6,
    });

    map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

    map.on("load", () => {
      setIsMapReady(true);

      // Add empty source for selected parcels
      map.addSource("selected-parcels", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Fill for selected parcels (amber for synthetic, blue for real)
      map.addLayer({
        id: "selected-parcels-fill",
        type: "fill",
        source: "selected-parcels",
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "is_synthetic"], 1], "#f59e0b",
            "#3b82f6",
          ],
          "fill-opacity": 0.25,
        },
      });

      // Outline for real parcels (solid blue)
      map.addLayer({
        id: "selected-parcels-outline",
        type: "line",
        source: "selected-parcels",
        filter: ["!=", ["get", "is_synthetic"], 1],
        paint: {
          "line-color": "#2563eb",
          "line-width": 2.5,
        },
      });

      // Outline for synthetic parcels (dashed amber)
      map.addLayer({
        id: "selected-parcels-outline-synthetic",
        type: "line",
        source: "selected-parcels",
        filter: ["==", ["get", "is_synthetic"], 1],
        paint: {
          "line-color": "#d97706",
          "line-width": 2.5,
          "line-dasharray": [3, 3],
        },
      });

      // Add source for hover parcel
      map.addSource("hover-parcel", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "hover-parcel-fill",
        type: "fill",
        source: "hover-parcel",
        paint: {
          "fill-color": "#f59e0b",
          "fill-opacity": 0.15,
        },
      });
    });

    // Click handler for parcel selection
    map.on("click", async (e) => {
      if (map.getZoom() < 15) {
        // Too zoomed out for parcel selection
        return;
      }
      selectParcelAtPoint(e.lngLat.lng, e.lngLat.lat);
    });

    // Change cursor at appropriate zoom levels
    map.on("zoom", () => {
      const zoom = map.getZoom();
      map.getCanvas().style.cursor = zoom >= 15 ? "crosshair" : "";
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [selectParcelAtPoint]);

  // ── Add WMS cadastral overlay when state is detected ────

  const addWmsLayer = useCallback(
    (state: string) => {
      const map = mapRef.current;
      if (!map || !isMapReady) return;

      // Remove old WMS layer if exists
      if (map.getLayer("cadastral-wms")) {
        map.removeLayer("cadastral-wms");
      }
      if (map.getSource("cadastral-wms")) {
        map.removeSource("cadastral-wms");
      }

      // Add WMS as raster tile source (proxied through our backend)
      const tileUrl =
        `${API_BASE}/v1/cadastral/wms/tile?state=${encodeURIComponent(state)}` +
        `&bbox={bbox-epsg-3857}&width=256&height=256&crs=EPSG:3857`;

      map.addSource("cadastral-wms", {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
      });

      map.addLayer(
        {
          id: "cadastral-wms",
          type: "raster",
          source: "cadastral-wms",
          paint: {
            "raster-opacity": 0.7,
          },
          minzoom: 14,
        },
        "selected-parcels-fill" // Insert below selected parcels
      );

      setWmsAdded(true);
      setCurrentState(state);
    },
    [isMapReady]
  );

  // ── Update WMS when state changes ─────────────────────

  useEffect(() => {
    if (detectedState && detectedState !== currentState && isMapReady) {
      addWmsLayer(detectedState);
    }
  }, [detectedState, currentState, isMapReady, addWmsLayer]);

  // ── Update selected parcels on map ────────────────────

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
          is_synthetic: p.parcel_id === "synthetic" ? 1 : 0,
        },
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [...p.polygon_wgs84.map((c) => [c[0], c[1]]), [p.polygon_wgs84[0][0], p.polygon_wgs84[0][1]]],
          ],
        },
      }));

    source.setData({
      type: "FeatureCollection",
      features,
    });
  }, [selectedParcels, isMapReady]);

  // ── Address search handler ────────────────────────────

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

    // Fly to location
    map.flyTo({
      center: [result.lng, result.lat],
      zoom: 17,
      duration: 2000,
    });

    // Detect state and add WMS
    if (result.state) {
      addWmsLayer(result.state);
    }
  };

  // ── Confirm selection ─────────────────────────────────

  const handleConfirm = async () => {
    const analysis = await confirmSelection();
    if (analysis) {
      onPlotConfirmed();
    }
  };

  // ── Total area calculation ────────────────────────────

  const totalArea = selectedParcels.reduce((sum, p) => sum + p.area_sqm, 0);

  // ── Render ────────────────────────────────────────────

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  if (!token) {
    return (
      <div className="w-full h-[600px] bg-neutral-100 rounded-lg flex items-center justify-center">
        <div className="text-center text-neutral-500">
          <p className="font-medium">Map requires a Mapbox token</p>
          <p className="text-sm mt-1">Set NEXT_PUBLIC_MAPBOX_TOKEN in frontend/.env.local</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Address Search */}
      <div className="relative">
        <Input
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
          placeholder="Adresse eingeben... (z.B. Berliner Str. 10, München)"
          className="w-full"
        />
        {isSearching && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 border-2 border-neutral-300 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}

        {/* Dropdown results */}
        {showDropdown && searchResults.length > 0 && (
          <div className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-60 overflow-y-auto">
            {searchResults.map((result, i) => (
              <button
                key={i}
                className="w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 border-b last:border-b-0"
                onClick={() => handleSelectAddress(result)}
              >
                <span className="font-medium">{result.display_name.split(",")[0]}</span>
                <span className="text-neutral-500 text-xs block truncate">
                  {result.display_name.split(",").slice(1).join(",")}
                </span>
              </button>
            ))}
          </div>
        )}
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
            Flurstück wird geladen...
          </div>
        )}

        {/* Zoom hint */}
        {isMapReady && mapRef.current && mapRef.current.getZoom() < 15 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/70 text-white text-xs px-3 py-1.5 rounded-full">
            Näher heranzoomen um Flurstücke auszuwählen
          </div>
        )}

        {/* State badge */}
        {currentState && (
          <div className="absolute top-3 right-3 bg-white/90 px-2 py-1 rounded text-xs text-neutral-600 shadow">
            Kataster: {currentState}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm text-red-700">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* Selected Parcels Summary */}
      {selectedParcels.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-blue-900">
              {selectedParcels.length} Flurstück{selectedParcels.length > 1 ? "e" : ""} ausgewählt
            </h4>
            <button className="text-xs text-blue-600 hover:underline" onClick={clearParcels}>
              Alle entfernen
            </button>
          </div>

          <div className="space-y-1">
            {selectedParcels.map((p) => {
              const isSynthetic = p.parcel_id === "synthetic";
              const isOverpass = p.parcel_id?.startsWith("overpass_");
              return (
                <div key={p.parcel_id} className="flex items-center justify-between text-xs">
                  <span className={isSynthetic ? "text-amber-700" : "text-blue-800"}>
                    {isSynthetic
                      ? `⚠ Platzhalter — ${p.area_sqm.toFixed(0)} m² (bitte anpassen)`
                      : (
                        <>
                          {p.gemarkung ? `${p.gemarkung} ` : ""}
                          Flst. {p.flurstueck_nr || p.parcel_id.slice(-8)}
                          {p.area_sqm > 0 && ` — ${p.area_sqm.toFixed(0)} m²`}
                          {isOverpass && " (OSM)"}
                        </>
                      )
                    }
                  </span>
                  <button
                    className="text-red-500 hover:text-red-700 ml-2"
                    onClick={() => removeParcel(p.parcel_id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          {selectedParcels.length > 1 && (
            <div className="mt-2 pt-2 border-t border-blue-200 text-xs text-blue-800">
              Gesamtfläche: <strong>{totalArea.toFixed(0)} m²</strong> (
              {(totalArea / 10000).toFixed(2)} ha)
            </div>
          )}

          <Button className="w-full mt-3" onClick={handleConfirm} disabled={isLoadingParcel}>
            {isLoadingParcel
              ? "Wird berechnet..."
              : `Grundstück übernehmen (${totalArea.toFixed(0)} m²)`}
          </Button>
        </div>
      )}

      {/* Instructions */}
      {selectedParcels.length === 0 && (
        <p className="text-xs text-neutral-500">
          Suchen Sie eine Adresse, zoomen Sie auf das Grundstück und klicken Sie auf die
          Flurstücke, die zum Grundstück gehören. Die Katastergrenzen werden ab Zoomstufe 14
          eingeblendet.
        </p>
      )}
    </div>
  );
}
