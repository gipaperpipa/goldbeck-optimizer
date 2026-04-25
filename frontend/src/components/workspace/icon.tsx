"use client";

/**
 * Custom CAD-style icon set for the Workspace chrome (Phase 5i).
 * Stroke-based, 16×16 viewBox, currentColor.
 */

import type { ReactElement } from "react";

export type IconName =
  | "cursor"
  | "move"
  | "rect"
  | "door"
  | "window"
  | "layers"
  | "grid"
  | "ruler"
  | "zoom"
  | "play"
  | "pause"
  | "download"
  | "share"
  | "compare"
  | "sun"
  | "rotate"
  | "home"
  | "map"
  | "chart"
  | "check"
  | "undo"
  | "redo"
  | "settings"
  | "floor";

const PATHS: Record<IconName, ReactElement> = {
  cursor: <path d="M3 3 L3 13 L6 10 L8 14 L10 13 L8 9 L13 9 Z" />,
  move: (
    <g>
      <path d="M8 2 L8 14 M2 8 L14 8" />
      <path d="M8 2 L6 4 M8 2 L10 4 M8 14 L6 12 M8 14 L10 12 M2 8 L4 6 M2 8 L4 10 M14 8 L12 6 M14 8 L12 10" />
    </g>
  ),
  rect: <rect x="3" y="3" width="10" height="10" fill="none" />,
  door: (
    <g>
      <path d="M4 14 L4 3 L12 4 L12 14" />
      <path d="M12 4 A8 8 0 0 0 4 12" fill="none" />
    </g>
  ),
  window: (
    <g>
      <rect x="3" y="5" width="10" height="6" fill="none" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </g>
  ),
  layers: (
    <g>
      <path d="M8 2 L14 5 L8 8 L2 5 Z" />
      <path d="M2 8 L8 11 L14 8" fill="none" />
      <path d="M2 11 L8 14 L14 11" fill="none" />
    </g>
  ),
  grid: (
    <g>
      <rect x="2" y="2" width="12" height="12" fill="none" />
      <line x1="6" y1="2" x2="6" y2="14" />
      <line x1="10" y1="2" x2="10" y2="14" />
      <line x1="2" y1="6" x2="14" y2="6" />
      <line x1="2" y1="10" x2="14" y2="10" />
    </g>
  ),
  ruler: (
    <g>
      <rect x="2" y="6" width="12" height="4" fill="none" />
      <line x1="4" y1="6" x2="4" y2="8" />
      <line x1="6" y1="6" x2="6" y2="8" />
      <line x1="8" y1="6" x2="8" y2="9" />
      <line x1="10" y1="6" x2="10" y2="8" />
      <line x1="12" y1="6" x2="12" y2="8" />
    </g>
  ),
  zoom: (
    <g>
      <circle cx="7" cy="7" r="4" fill="none" />
      <line x1="10" y1="10" x2="14" y2="14" />
    </g>
  ),
  play: <path d="M4 3 L13 8 L4 13 Z" />,
  pause: (
    <g>
      <rect x="4" y="3" width="3" height="10" />
      <rect x="9" y="3" width="3" height="10" />
    </g>
  ),
  download: (
    <g>
      <path d="M8 2 L8 11 M4 8 L8 12 L12 8" fill="none" />
      <line x1="3" y1="14" x2="13" y2="14" />
    </g>
  ),
  share: (
    <g>
      <circle cx="4" cy="8" r="2" fill="none" />
      <circle cx="12" cy="4" r="2" fill="none" />
      <circle cx="12" cy="12" r="2" fill="none" />
      <line x1="6" y1="7" x2="10" y2="5" />
      <line x1="6" y1="9" x2="10" y2="11" />
    </g>
  ),
  compare: (
    <g>
      <rect x="2" y="3" width="5" height="10" fill="none" />
      <rect x="9" y="3" width="5" height="10" fill="none" />
    </g>
  ),
  sun: (
    <g>
      <circle cx="8" cy="8" r="3" fill="none" />
      <line x1="8" y1="1" x2="8" y2="3" />
      <line x1="8" y1="13" x2="8" y2="15" />
      <line x1="1" y1="8" x2="3" y2="8" />
      <line x1="13" y1="8" x2="15" y2="8" />
      <line x1="3" y1="3" x2="4" y2="4" />
      <line x1="12" y1="12" x2="13" y2="13" />
      <line x1="13" y1="3" x2="12" y2="4" />
      <line x1="3" y1="13" x2="4" y2="12" />
    </g>
  ),
  rotate: (
    <g>
      <path d="M3 8 A5 5 0 0 1 13 8" fill="none" />
      <path d="M11 6 L13 8 L15 6" fill="none" />
    </g>
  ),
  home: <path d="M2 8 L8 3 L14 8 L14 14 L10 14 L10 10 L6 10 L6 14 L2 14 Z" fill="none" />,
  map: (
    <g>
      <path d="M2 3 L6 5 L10 3 L14 5 L14 13 L10 11 L6 13 L2 11 Z" fill="none" />
      <line x1="6" y1="5" x2="6" y2="13" />
      <line x1="10" y1="3" x2="10" y2="11" />
    </g>
  ),
  chart: (
    <g>
      <line x1="2" y1="14" x2="14" y2="14" />
      <path d="M3 11 L6 7 L9 9 L13 3" fill="none" />
    </g>
  ),
  check: <path d="M3 8 L7 12 L13 4" fill="none" />,
  undo: <path d="M4 8 A5 5 0 0 1 14 8 M4 8 L4 4 M4 8 L8 8" fill="none" />,
  redo: <path d="M12 8 A5 5 0 0 0 2 8 M12 8 L12 4 M12 8 L8 8" fill="none" />,
  settings: (
    <g>
      <circle cx="8" cy="8" r="2" fill="none" />
      <path d="M8 1 L8 3 M8 13 L8 15 M1 8 L3 8 M13 8 L15 8 M3 3 L4.5 4.5 M11.5 11.5 L13 13 M13 3 L11.5 4.5 M4.5 11.5 L3 13" />
    </g>
  ),
  floor: (
    <g>
      <rect x="2" y="10" width="12" height="3" fill="none" />
      <rect x="2" y="6" width="12" height="3" fill="none" />
      <rect x="2" y="2" width="12" height="3" fill="none" />
    </g>
  ),
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      strokeLinecap="round"
      fill="none"
    >
      {PATHS[name]}
    </svg>
  );
}
