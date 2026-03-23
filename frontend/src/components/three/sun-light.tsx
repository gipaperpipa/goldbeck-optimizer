"use client";

import { useMemo } from "react";
import { Vector3 } from "three";

interface SunLightProps {
  azimuth: number;
  altitude: number;
  distance?: number;
}

export function SunLight({ azimuth, altitude, distance = 500 }: SunLightProps) {
  const position = useMemo(() => {
    const azRad = (azimuth * Math.PI) / 180;
    const altRad = (altitude * Math.PI) / 180;
    return new Vector3(
      distance * Math.sin(azRad) * Math.cos(altRad),
      distance * Math.sin(altRad),
      distance * Math.cos(azRad) * Math.cos(altRad)
    );
  }, [azimuth, altitude, distance]);

  const intensity = Math.max(0.3, Math.sin((altitude * Math.PI) / 180) * 2);

  return (
    <directionalLight
      castShadow
      position={position}
      intensity={intensity}
      shadow-mapSize={[4096, 4096]}
      shadow-camera-far={1500}
      shadow-camera-left={-400}
      shadow-camera-right={400}
      shadow-camera-top={400}
      shadow-camera-bottom={-400}
      shadow-bias={-0.0005}
    />
  );
}
