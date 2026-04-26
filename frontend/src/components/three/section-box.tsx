"use client";

import { useState, useCallback } from "react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Scissors, RotateCcw } from "lucide-react";
import type { SectionBox } from "@/lib/section-clip";

interface SectionBoxControlsProps {
  /** Tightest box that fully contains the scene — used to clamp slider
   *  ranges and to populate the default when the user toggles ON. */
  bounds: SectionBox;
  /** Per-floor stack height (used by the legacy floor quick-select). */
  storyHeight: number;
  numStories: number;
  /** Active section box, or null when disabled. */
  box: SectionBox | null;
  onChange: (box: SectionBox | null) => void;
}

/**
 * Phase 11a — section *box* with six independent faces. The legacy
 * `sectionY` (single horizontal cut) used to drop floors above a Y
 * threshold; now we feed all six faces into Three.js material
 * clippingPlanes for true mid-mesh slicing. Floor quick-select
 * remains for muscle memory and just nudges yMax.
 */
export function SectionBoxControls({
  bounds,
  storyHeight,
  numStories,
  box,
  onChange,
}: SectionBoxControlsProps) {
  const enabled = box !== null;
  const [open, setOpen] = useState(true);

  const handleToggle = useCallback(() => {
    if (enabled) {
      onChange(null);
    } else {
      // Default to scene bounds so the box is visibly active without
      // changing what's drawn — the user then drags faces inward.
      onChange({ ...bounds });
    }
  }, [enabled, onChange, bounds]);

  const handleReset = useCallback(() => onChange(null), [onChange]);

  const setRange = useCallback(
    (axis: "x" | "y" | "z", lo: number, hi: number) => {
      if (!box) return;
      onChange({
        ...box,
        [`${axis}Min`]: lo,
        [`${axis}Max`]: hi,
      } as SectionBox);
    },
    [box, onChange],
  );

  const handleFloorClick = useCallback(
    (floorIndex: number) => {
      // Show floors 0..floorIndex inclusive — set yMax accordingly.
      if (!box) return;
      onChange({
        ...box,
        yMin: bounds.yMin,
        yMax: (floorIndex + 1) * storyHeight,
      });
    },
    [box, bounds.yMin, onChange, storyHeight],
  );

  const floorLabels = Array.from({ length: numStories }, (_, i) =>
    i === 0 ? "GF" : `F${i}`,
  );
  const currentTopFloor = box
    ? Math.ceil(box.yMax / storyHeight) - 1
    : numStories - 1;

  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-lg border shadow-sm p-3 space-y-2 w-64">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700"
          title={open ? "Einklappen" : "Aufklappen"}
        >
          <Scissors className="w-3.5 h-3.5" />
          Section Box
        </button>
        <Button
          size="sm"
          variant={enabled ? "default" : "outline"}
          className="h-6 px-2 text-xs"
          onClick={handleToggle}
        >
          {enabled ? "On" : "Off"}
        </Button>
      </div>

      {enabled && open && box && (
        <>
          {/* Floor quick-select (legacy muscle memory) */}
          <div className="flex flex-wrap gap-1">
            {floorLabels.map((label, i) => (
              <button
                key={i}
                type="button"
                onClick={() => handleFloorClick(i)}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  currentTopFloor === i
                    ? "bg-blue-100 border-blue-300 text-blue-700 font-medium"
                    : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Per-axis range sliders */}
          <AxisRange
            label="X"
            min={bounds.xMin}
            max={bounds.xMax}
            lo={box.xMin}
            hi={box.xMax}
            onChange={(lo, hi) => setRange("x", lo, hi)}
          />
          <AxisRange
            label="Y"
            min={bounds.yMin}
            max={bounds.yMax}
            lo={box.yMin}
            hi={box.yMax}
            onChange={(lo, hi) => setRange("y", lo, hi)}
          />
          <AxisRange
            label="Z"
            min={bounds.zMin}
            max={bounds.zMax}
            lo={box.zMin}
            hi={box.zMax}
            onChange={(lo, hi) => setRange("z", lo, hi)}
          />

          <Button
            size="sm"
            variant="ghost"
            className="w-full h-6 text-xs text-neutral-500"
            onClick={handleReset}
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Show Full Model
          </Button>
        </>
      )}
    </div>
  );
}

function AxisRange({
  label,
  min,
  max,
  lo,
  hi,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
}) {
  const span = max - min;
  const step = span > 100 ? 0.5 : 0.1;
  // The native single-handle Slider can't do dual handles, so we
  // stack two sliders — one drives the lo bound, the other drives
  // hi. Each is clamped against the other so the box never inverts.
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px] text-neutral-500">
        <span>
          {label}{" "}
          <span className="font-mono text-neutral-700">
            {lo.toFixed(1)} … {hi.toFixed(1)}
          </span>
        </span>
        <span className="text-neutral-400">m</span>
      </div>
      <Slider
        min={min}
        max={hi - 0.5}
        step={step}
        value={[lo]}
        onValueChange={(v) => onChange(Math.min(v[0], hi - 0.5), hi)}
      />
      <Slider
        min={lo + 0.5}
        max={max}
        step={step}
        value={[hi]}
        onValueChange={(v) => onChange(lo, Math.max(v[0], lo + 0.5))}
      />
    </div>
  );
}
