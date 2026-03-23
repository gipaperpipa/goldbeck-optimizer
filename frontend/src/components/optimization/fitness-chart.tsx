"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { FitnessHistoryEntry } from "@/types/api";

interface FitnessChartProps {
  data: FitnessHistoryEntry[];
  title?: string;
  height?: number;
}

export function FitnessChart({
  data,
  title = "Fitness Over Generations",
  height = 220,
}: FitnessChartProps) {
  // Downsample if too many points (keep chart responsive)
  const chartData = useMemo(() => {
    if (data.length <= 200) return data;
    const step = Math.ceil(data.length / 200);
    const sampled = data.filter((_, i) => i % step === 0);
    // Always include the last point
    if (sampled[sampled.length - 1] !== data[data.length - 1]) {
      sampled.push(data[data.length - 1]);
    }
    return sampled;
  }, [data]);

  if (data.length < 2) return null;

  const yMin = Math.floor(
    Math.min(...chartData.map((d) => Math.min(d.best_fitness, d.avg_fitness || d.best_fitness))) * 0.95
  );
  const yMax = Math.ceil(
    Math.max(...chartData.map((d) => d.best_fitness)) * 1.05
  );

  return (
    <div className="w-full">
      <p className="text-xs font-semibold text-neutral-600 mb-1">{title}</p>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
          <XAxis
            dataKey="generation"
            tick={{ fontSize: 10 }}
            stroke="#a3a3a3"
            label={{ value: "Generation", position: "insideBottom", offset: -2, fontSize: 10, fill: "#737373" }}
          />
          <YAxis
            domain={[yMin, yMax]}
            tick={{ fontSize: 10 }}
            stroke="#a3a3a3"
            label={{ value: "Fitness", angle: -90, position: "insideLeft", offset: 15, fontSize: 10, fill: "#737373" }}
          />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              borderRadius: 6,
              border: "1px solid #e5e5e5",
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            }}
            formatter={(value: number, name: string) => [
              value.toFixed(2),
              name === "best_fitness" ? "Best" : "Average",
            ]}
            labelFormatter={(label) => `Gen ${label}`}
          />
          <Legend
            verticalAlign="top"
            height={24}
            iconSize={8}
            formatter={(value: string) =>
              value === "best_fitness" ? "Best" : "Average"
            }
            wrapperStyle={{ fontSize: 10 }}
          />
          <Line
            type="monotone"
            dataKey="best_fitness"
            stroke="#2563eb"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="avg_fitness"
            stroke="#a3a3a3"
            strokeWidth={1}
            strokeDasharray="4 2"
            dot={false}
            activeDot={{ r: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
