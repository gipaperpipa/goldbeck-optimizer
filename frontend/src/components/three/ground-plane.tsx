"use client";

import { useMemo } from "react";
import * as THREE from "three";

interface GroundPlaneProps {
  boundary: [number, number][];
}

export function GroundPlane({ boundary }: GroundPlaneProps) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    boundary.forEach(([x, y], i) => {
      if (i === 0) s.moveTo(x, -y);
      else s.lineTo(x, -y);
    });
    s.closePath();
    return s;
  }, [boundary]);

  const boundaryGeometry = useMemo(() => {
    const positions = new Float32Array(boundary.flatMap(([x, y]) => [x, 0.1, -y]));
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geom;
  }, [boundary]);

  return (
    <group>
      {/* Full ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow>
        <planeGeometry args={[2000, 2000]} />
        <meshStandardMaterial color="#d4d4d4" />
      </mesh>

      {/* Plot area highlight */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color="#86efac" transparent opacity={0.3} side={THREE.DoubleSide} />
      </mesh>

      {/* Plot boundary line */}
      <lineLoop geometry={boundaryGeometry}>
        <lineBasicMaterial color="#15803d" linewidth={2} />
      </lineLoop>
    </group>
  );
}
