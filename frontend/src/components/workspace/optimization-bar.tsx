"use client";

import { Icon } from "./icon";
import { FitnessChart, type FitnessPoint } from "./fitness-chart";

export function OptimizationBar({
  generation,
  generationsTotal,
  bestFitness,
  fitnessDelta,
  hue = 220,
  points,
  isRunning = false,
  onTogglePlay,
  onOpenWeights,
}: {
  generation?: number;
  generationsTotal?: number;
  bestFitness?: number;
  fitnessDelta?: number;
  hue?: number;
  points?: FitnessPoint[];
  isRunning?: boolean;
  onTogglePlay?: () => void;
  onOpenWeights?: () => void;
}) {
  const gen = generation ?? 47;
  const total = generationsTotal ?? 100;
  const fit = bestFitness ?? 0.912;
  const delta = fitnessDelta ?? 0.042;

  return (
    <div
      style={{
        background: "white",
        border: "1px solid var(--ws-line)",
        borderRadius: 3,
        padding: 14,
        display: "grid",
        gridTemplateColumns: "auto 1fr auto auto",
        gap: 22,
        alignItems: "center",
      }}
    >
      <div>
        <div
          className="ws-mono"
          style={{
            fontSize: 10,
            color: "var(--ws-ink-dim)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            marginBottom: 3,
          }}
        >
          Generation
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span
            className="ws-serif"
            style={{ fontSize: 26, lineHeight: 1, color: "var(--ws-ink)" }}
          >
            {gen}
          </span>
          <span
            className="ws-mono"
            style={{ fontSize: 11, color: "var(--ws-ink-dim)" }}
          >
            / {total}
          </span>
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          className="ws-mono"
          style={{
            fontSize: 10,
            color: "var(--ws-ink-dim)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            marginBottom: 3,
          }}
        >
          Fitness · Best-of-Generation
        </div>
        <FitnessChart points={points} hue={hue} />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 3,
        }}
      >
        <div
          className="ws-mono"
          style={{
            fontSize: 10,
            color: "var(--ws-ink-dim)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Beste Bewertung
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span
            className="ws-serif"
            style={{
              fontSize: 26,
              lineHeight: 1,
              color: `oklch(0.35 0.14 ${hue})`,
            }}
          >
            {fit.toFixed(3)}
          </span>
        </div>
        {delta !== 0 && (
          <span
            className="ws-mono"
            style={{
              fontSize: 10,
              color: delta > 0 ? "oklch(0.38 0.09 150)" : "oklch(0.6 0.12 25)",
            }}
          >
            {delta > 0 ? "+" : ""}
            {delta.toFixed(3)} seit Start
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={onTogglePlay}
          style={{
            width: 34,
            height: 34,
            background: "var(--ws-neutral-bg)",
            border: "1px solid var(--ws-line)",
            cursor: "pointer",
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ws-ink)",
          }}
          aria-label={isRunning ? "Pause" : "Fortsetzen"}
        >
          <Icon name={isRunning ? "pause" : "play"} size={14} />
        </button>
        <button
          type="button"
          onClick={onOpenWeights}
          style={{
            padding: "8px 12px",
            height: 34,
            background: "white",
            border: "1px solid var(--ws-line)",
            cursor: "pointer",
            borderRadius: 3,
            color: "var(--ws-ink-mid)",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Icon name="settings" size={13} /> Gewichte
        </button>
      </div>
    </div>
  );
}
