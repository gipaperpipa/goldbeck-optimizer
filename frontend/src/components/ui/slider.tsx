"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SliderProps {
  value: number[];
  onValueChange: (value: number[]) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

function Slider({ value, onValueChange, min = 0, max = 100, step = 1, className }: SliderProps) {
  const pct = ((value[0] - min) / (max - min)) * 100;
  return (
    <div className={cn("relative flex w-full touch-none select-none items-center", className)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value[0]}
        onChange={(e) => onValueChange([Number(e.target.value)])}
        className="w-full h-2 bg-neutral-200 rounded-full appearance-none cursor-pointer accent-neutral-900"
        style={{
          background: `linear-gradient(to right, #171717 0%, #171717 ${pct}%, #e5e5e5 ${pct}%, #e5e5e5 100%)`,
        }}
      />
    </div>
  );
}

export { Slider };
