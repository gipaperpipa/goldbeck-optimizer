"use client";

import { useEffect, useRef } from "react";
import type { LayoutOption, PlotAnalysis } from "@/types/api";

interface SitePlan2DProps {
  layout: LayoutOption;
  plot: PlotAnalysis;
  width?: number;
  height?: number;
}

const COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316",
];

export function SitePlan2D({ layout, plot, width = 600, height = 500 }: SitePlan2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Compute transform
    const boundary = plot.boundary_polygon_local;
    const allX = boundary.map((p) => p[0]);
    const allY = boundary.map((p) => p[1]);
    const minX = Math.min(...allX);
    const maxX = Math.max(...allX);
    const minY = Math.min(...allY);
    const maxY = Math.max(...allY);
    const plotW = maxX - minX;
    const plotH = maxY - minY;

    const padding = 40;
    const scaleX = (width - 2 * padding) / plotW;
    const scaleY = (height - 2 * padding) / plotH;
    const scale = Math.min(scaleX, scaleY);

    const offsetX = padding + ((width - 2 * padding) - plotW * scale) / 2;
    const offsetY = padding + ((height - 2 * padding) - plotH * scale) / 2;

    const tx = (x: number) => offsetX + (x - minX) * scale;
    const ty = (y: number) => height - (offsetY + (y - minY) * scale);

    // Clear
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, width, height);

    // Draw plot boundary
    ctx.beginPath();
    boundary.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(tx(x), ty(y));
      else ctx.lineTo(tx(x), ty(y));
    });
    ctx.closePath();
    ctx.fillStyle = "#e2e8f0";
    ctx.fill();
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw buildings
    layout.buildings.forEach((b, i) => {
      const color = COLORS[i % COLORS.length];
      const hw = b.width_m / 2;
      const hd = b.depth_m / 2;
      const rotRad = (b.rotation_deg * Math.PI) / 180;

      const corners = [
        [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd],
      ].map(([cx, cy]) => {
        const rx = cx * Math.cos(rotRad) - cy * Math.sin(rotRad) + b.position_x;
        const ry = cx * Math.sin(rotRad) + cy * Math.cos(rotRad) + b.position_y;
        return [tx(rx), ty(ry)];
      });

      ctx.beginPath();
      corners.forEach(([px, py], j) => {
        if (j === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = color + "40";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      const centerX = tx(b.position_x);
      const centerY = ty(b.position_y);
      ctx.fillStyle = "#1e293b";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`B${i + 1}`, centerX, centerY - 6);
      ctx.font = "10px sans-serif";
      ctx.fillText(`${b.stories}F / ${b.unit_mix?.total_units || 0}u`, centerX, centerY + 8);
    });

    // Metrics label
    ctx.fillStyle = "#64748b";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(
      `FAR: ${layout.far_achieved.toFixed(2)} | Coverage: ${layout.lot_coverage_pct.toFixed(1)}% | Units: ${layout.total_units}`,
      10,
      height - 10
    );
  }, [layout, plot, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className="border rounded-lg"
    />
  );
}
