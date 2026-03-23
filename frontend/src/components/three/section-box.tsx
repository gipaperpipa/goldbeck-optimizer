"use client";

import { useState, useCallback } from "react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Scissors, RotateCcw } from "lucide-react";

interface SectionBoxControlsProps {
  maxHeight: number;      // total building height in meters
  storyHeight: number;    // height per story
  numStories: number;
  sectionY: number | null;
  onSectionYChange: (y: number | null) => void;
}

export function SectionBoxControls({
  maxHeight,
  storyHeight,
  numStories,
  sectionY,
  onSectionYChange,
}: SectionBoxControlsProps) {
  const [enabled, setEnabled] = useState(sectionY !== null);

  const handleToggle = useCallback(() => {
    if (enabled) {
      setEnabled(false);
      onSectionYChange(null);
    } else {
      setEnabled(true);
      // Default to showing all but the top floor
      onSectionYChange(Math.max(storyHeight, maxHeight - storyHeight));
    }
  }, [enabled, maxHeight, storyHeight, onSectionYChange]);

  const handleSlider = useCallback(
    (values: number[]) => {
      onSectionYChange(values[0]);
    },
    [onSectionYChange]
  );

  const handleFloorClick = useCallback(
    (floorIndex: number) => {
      // Show up to and including this floor
      onSectionYChange((floorIndex + 1) * storyHeight);
    },
    [storyHeight, onSectionYChange]
  );

  const floorLabels = Array.from({ length: numStories }, (_, i) =>
    i === 0 ? "GF" : `F${i}`
  );

  // Determine which floor is currently visible as the top
  const currentTopFloor =
    sectionY !== null ? Math.ceil(sectionY / storyHeight) - 1 : numStories - 1;

  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-lg border shadow-sm p-3 space-y-2 w-56">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700">
          <Scissors className="w-3.5 h-3.5" />
          Section Box
        </div>
        <Button
          size="sm"
          variant={enabled ? "default" : "outline"}
          className="h-6 px-2 text-xs"
          onClick={handleToggle}
        >
          {enabled ? "On" : "Off"}
        </Button>
      </div>

      {enabled && (
        <>
          {/* Floor quick-select buttons */}
          <div className="flex flex-wrap gap-1">
            {floorLabels.map((label, i) => (
              <button
                key={i}
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

          {/* Continuous slider */}
          <div className="pt-1">
            <Slider
              min={storyHeight}
              max={maxHeight}
              step={0.1}
              value={[sectionY ?? maxHeight]}
              onValueChange={handleSlider}
            />
            <div className="flex justify-between text-[10px] text-neutral-400 mt-0.5">
              <span>Floor 0</span>
              <span>{sectionY?.toFixed(1)}m</span>
              <span>{maxHeight.toFixed(1)}m</span>
            </div>
          </div>

          {/* Reset button */}
          <Button
            size="sm"
            variant="ghost"
            className="w-full h-6 text-xs text-neutral-500"
            onClick={() => {
              setEnabled(false);
              onSectionYChange(null);
            }}
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Show Full Model
          </Button>
        </>
      )}
    </div>
  );
}
