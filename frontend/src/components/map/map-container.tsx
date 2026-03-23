"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import type { CoordinatePoint } from "@/types/api";

interface MapContainerProps {
  onPolygonDrawn: (coords: CoordinatePoint[]) => void;
  center?: [number, number];
}

export function MapContainer({ onPolygonDrawn, center = [-104.9903, 39.7392] }: MapContainerProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      setIsReady(false);
      return;
    }

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center,
      zoom: 17,
    });

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true },
      defaultMode: "draw_polygon",
    });

    map.addControl(draw, "top-right");
    map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

    map.on("draw.create", () => {
      const data = draw.getAll();
      if (data.features.length > 0) {
        const feature = data.features[0];
        if (feature.geometry.type === "Polygon") {
          const coords = (feature.geometry.coordinates[0] as [number, number][]).slice(0, -1);
          onPolygonDrawn(coords.map(([lng, lat]) => ({ lng, lat })));
        }
      }
    });

    map.on("draw.update", () => {
      const data = draw.getAll();
      if (data.features.length > 0) {
        const feature = data.features[0];
        if (feature.geometry.type === "Polygon") {
          const coords = (feature.geometry.coordinates[0] as [number, number][]).slice(0, -1);
          onPolygonDrawn(coords.map(([lng, lat]) => ({ lng, lat })));
        }
      }
    });

    map.on("load", () => setIsReady(true));

    mapRef.current = map;
    drawRef.current = draw;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [center, onPolygonDrawn]);

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  if (!token) {
    return (
      <div className="w-full h-[500px] bg-neutral-100 rounded-lg flex items-center justify-center">
        <div className="text-center text-neutral-500">
          <p className="font-medium">Map requires a Mapbox token</p>
          <p className="text-sm mt-1">
            Set NEXT_PUBLIC_MAPBOX_TOKEN in frontend/.env.local
          </p>
          <p className="text-sm mt-1">Use the manual input tab instead</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div ref={mapContainer} className="w-full h-[500px] rounded-lg" />
      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 rounded-lg">
          <p className="text-neutral-500">Loading map...</p>
        </div>
      )}
      <p className="text-xs text-neutral-500 mt-2">
        Use the polygon tool (top-right) to draw your plot boundary on the map
      </p>
    </div>
  );
}
