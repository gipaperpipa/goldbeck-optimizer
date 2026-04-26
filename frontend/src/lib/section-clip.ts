/**
 * Helpers for the 3D section box (Phase 11a).
 *
 * Three.js supports per-material clipping planes when the renderer is
 * created with `localClippingEnabled: true`. A "section box" is the
 * union of six axis-aligned half-spaces — keep everything inside the
 * box, clip everything outside. We model it as `{ xMin, xMax, yMin,
 * yMax, zMin, zMax }` in world coords (Three.js convention: +Y up,
 * the building's plan-y maps to scene -Z).
 */

import * as THREE from "three";

export interface SectionBox {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

/**
 * Build the six clipping planes for a section box.
 *
 * Three.js `Plane(normal, constant)` keeps points where
 * `normal·p + constant > 0`. To "keep x > xMin" we use normal=(1,0,0)
 * and constant=-xMin → x − xMin > 0 ⟺ x > xMin.
 */
export function planesForSectionBox(box: SectionBox): THREE.Plane[] {
  return [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -box.xMin), // keep x > xMin
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), box.xMax), // keep x < xMax
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -box.yMin), // keep y > yMin
    new THREE.Plane(new THREE.Vector3(0, -1, 0), box.yMax), // keep y < yMax
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -box.zMin), // keep z > zMin
    new THREE.Plane(new THREE.Vector3(0, 0, -1), box.zMax), // keep z < zMax
  ];
}

/**
 * Reasonable starting bounds for a freshly-toggled section box: the
 * scene's overall extent expanded slightly so the user sees the full
 * model on first enable, then they drag faces inward.
 */
export function defaultSectionBox(
  buildings: Array<{
    position_x: number;
    position_y: number;
    width_m: number;
    depth_m: number;
    rotation_deg: number;
    total_height_m: number;
  }>,
  pad = 5,
): SectionBox {
  let xMin = Infinity, xMax = -Infinity;
  let zMin = Infinity, zMax = -Infinity;
  let yMax = 0;
  for (const b of buildings) {
    // Worst-case axis-aligned bbox of the rotated rectangle: half the
    // diagonal in each direction.
    const half = Math.hypot(b.width_m, b.depth_m) / 2;
    xMin = Math.min(xMin, b.position_x - half);
    xMax = Math.max(xMax, b.position_x + half);
    // Plan-y maps to scene -Z.
    zMin = Math.min(zMin, -b.position_y - half);
    zMax = Math.max(zMax, -b.position_y + half);
    yMax = Math.max(yMax, b.total_height_m);
  }
  if (!isFinite(xMin)) {
    return { xMin: -50, xMax: 50, yMin: 0, yMax: 30, zMin: -50, zMax: 50 };
  }
  return {
    xMin: xMin - pad,
    xMax: xMax + pad,
    yMin: 0,
    yMax: yMax + pad,
    zMin: zMin - pad,
    zMax: zMax + pad,
  };
}

/** Clamp every face so the box can't invert (e.g. xMax < xMin). */
export function normalizeSectionBox(box: SectionBox, eps = 0.5): SectionBox {
  return {
    xMin: Math.min(box.xMin, box.xMax - eps),
    xMax: Math.max(box.xMax, box.xMin + eps),
    yMin: Math.min(box.yMin, box.yMax - eps),
    yMax: Math.max(box.yMax, box.yMin + eps),
    zMin: Math.min(box.zMin, box.zMax - eps),
    zMax: Math.max(box.zMax, box.zMin + eps),
  };
}
