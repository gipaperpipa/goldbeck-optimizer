"use client";

import { useMemo } from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import type { BuildingFootprint } from "@/types/api";

const BUILDING_COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316",
];

interface BuildingModelProps {
  building: BuildingFootprint;
  index: number;
  showLabel?: boolean;
}

export function BuildingModel({ building, index, showLabel = true }: BuildingModelProps) {
  const color = BUILDING_COLORS[index % BUILDING_COLORS.length];
  const rotationRad = (building.rotation_deg * Math.PI) / 180;

  // Floor line positions
  const floorLines = useMemo(() => {
    const lines: number[] = [];
    for (let f = 1; f < building.stories; f++) {
      lines.push(f * building.floor_height_m);
    }
    return lines;
  }, [building.stories, building.floor_height_m]);

  return (
    <group
      position={[building.position_x, building.total_height_m / 2, -building.position_y]}
      rotation={[0, rotationRad, 0]}
    >
      {/* Main building body */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[building.width_m, building.total_height_m, building.depth_m]} />
        <meshStandardMaterial
          color={color}
          transparent
          opacity={0.75}
          roughness={0.7}
          metalness={0.1}
        />
      </mesh>

      {/* Edges */}
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(building.width_m, building.total_height_m, building.depth_m)]} />
        <lineBasicMaterial color="#1e293b" linewidth={1} />
      </lineSegments>

      {/* Floor lines */}
      {floorLines.map((h) => (
        <mesh key={h} position={[0, h - building.total_height_m / 2, 0]}>
          <boxGeometry args={[building.width_m + 0.5, 0.3, building.depth_m + 0.5]} />
          <meshStandardMaterial color="#e2e8f0" />
        </mesh>
      ))}

      {/* Roof accent */}
      <mesh position={[0, building.total_height_m / 2 + 0.5, 0]} castShadow>
        <boxGeometry args={[building.width_m, 1, building.depth_m]} />
        <meshStandardMaterial color="#334155" roughness={0.3} />
      </mesh>

      {/* Label */}
      {showLabel && (
        <Text
          position={[0, building.total_height_m / 2 + 8, 0]}
          fontSize={6}
          color="#1e293b"
          anchorX="center"
          anchorY="bottom"
        >
          {`B${index + 1} (${building.stories}F)`}
        </Text>
      )}
    </group>
  );
}
