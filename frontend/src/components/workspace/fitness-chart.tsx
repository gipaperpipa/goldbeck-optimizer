"use client";

import { useMemo } from "react";

export interface FitnessPoint {
  generation: number;
  best: number;
  current: number;
}

export function FitnessChart({
  points,
  hue = 220,
  width = 220,
  height = 60,
}: {
  /** Generation-by-generation fitness samples. If empty/undefined, a
   *  decorative placeholder curve is rendered so the panel never feels
   *  blank before the GA has produced data. */
  points?: FitnessPoint[];
  hue?: number;
  width?: number;
  height?: number;
}) {
  const series = useMemo(() => {
    if (points && points.length > 0) {
      const maxGen = Math.max(...points.map((p) => p.generation), 1);
      return points.map((p) => ({
        x: (p.generation / maxGen) * width,
        cy: height - p.current * height * 0.95 - 2,
        by: height - p.best * height * 0.95 - 2,
      }));
    }
    // Placeholder: monotonic-ish climb from 0.42 → ~0.92.
    const arr: { x: number; cy: number; by: number }[] = [];
    let v = 0.42;
    let best = v;
    for (let i = 0; i <= 47; i++) {
      v = Math.min(0.92, v + 0.012 + ((i * 17) % 7) * 0.001);
      best = Math.max(best, v);
      arr.push({
        x: (i / 47) * width,
        cy: height - (v + Math.sin(i * 0.6) * 0.01) * height * 0.95 - 2,
        by: height - best * height * 0.95 - 2,
      });
    }
    return arr;
  }, [points, width, height]);

  const toPath = (key: "cy" | "by") =>
    series
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p[key].toFixed(2)}`)
      .join(" ");

  const last = series[series.length - 1];
  const fillPath = `${toPath("by")} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id="ws-fitgrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={`oklch(0.55 0.12 ${hue})`} stopOpacity="0.25" />
          <stop offset="100%" stopColor={`oklch(0.55 0.12 ${hue})`} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((y) => (
        <line
          key={y}
          x1="0"
          y1={height - y * height * 0.95 - 2}
          x2={width}
          y2={height - y * height * 0.95 - 2}
          stroke="oklch(0.92 0.005 85)"
          strokeWidth="0.5"
          strokeDasharray="2 2"
        />
      ))}
      <path d={fillPath} fill="url(#ws-fitgrad)" />
      <path
        d={toPath("cy")}
        stroke="oklch(0.7 0.01 60)"
        strokeWidth="1"
        fill="none"
        strokeLinejoin="round"
      />
      <path
        d={toPath("by")}
        stroke={`oklch(0.45 0.14 ${hue})`}
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
      />
      {last && (
        <circle
          cx={last.x}
          cy={last.by}
          r="2.5"
          fill={`oklch(0.45 0.14 ${hue})`}
        />
      )}
    </svg>
  );
}
