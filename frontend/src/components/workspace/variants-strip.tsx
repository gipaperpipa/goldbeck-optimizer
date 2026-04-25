"use client";

import type { LayoutOption } from "@/types/api";

function CompareTile({
  rank,
  fitness,
  units,
  selected,
  onClick,
  hue,
}: {
  rank: number;
  fitness: number;
  units: number;
  selected: boolean;
  onClick: () => void;
  hue: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: 8,
        background: "white",
        border: `1px solid ${
          selected ? `oklch(0.55 0.12 ${hue})` : "var(--ws-line)"
        }`,
        borderRadius: 3,
        cursor: "pointer",
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        outline: selected ? `2px solid oklch(0.85 0.08 ${hue})` : "none",
        outlineOffset: -1,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span
          className="ws-mono"
          style={{
            fontSize: 10,
            color: "var(--ws-ink-dim)",
            letterSpacing: "0.08em",
          }}
        >
          V{rank}
        </span>
        <span
          className="ws-mono"
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: selected
              ? `oklch(0.45 0.14 ${hue})`
              : "var(--ws-ink-mid)",
          }}
        >
          {fitness.toFixed(3)}
        </span>
      </div>
      {/* Mini plan thumbnail — schematic placeholder, partition lines proportional to unit count */}
      <svg
        viewBox="0 0 60 26"
        style={{ width: "100%", height: 26, display: "block" }}
      >
        <rect
          x="0"
          y="0"
          width="60"
          height="26"
          fill="oklch(0.99 0.003 85)"
          stroke="var(--ws-ink)"
          strokeWidth="0.3"
        />
        <line
          x1="0"
          y1="11"
          x2="60"
          y2="11"
          stroke="var(--ws-ink)"
          strokeWidth="0.25"
        />
        <line
          x1="0"
          y1="15"
          x2="60"
          y2="15"
          stroke="var(--ws-ink)"
          strokeWidth="0.25"
        />
        {Array.from({ length: Math.max(units, 1) }).map((_, i) => {
          const u = Math.max(units, 1);
          return (
            <line
              key={i}
              x1={(i + 1) * (60 / (u + 1))}
              y1="0"
              x2={(i + 1) * (60 / (u + 1))}
              y2="26"
              stroke="var(--ws-ink)"
              strokeWidth="0.25"
            />
          );
        })}
      </svg>
      <div
        className="ws-mono"
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
          fontSize: 9,
          color: "var(--ws-ink-dim)",
        }}
      >
        <span>{units}×WE</span>
        <span>·</span>
        <span>Goldbeck</span>
      </div>
    </button>
  );
}

export function VariantsStrip({
  variants,
  selectedId,
  onSelect,
  hue = 220,
}: {
  variants: LayoutOption[];
  selectedId?: string | null;
  onSelect: (layoutId: string) => void;
  hue?: number;
}) {
  if (variants.length === 0) return null;
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <span
          className="ws-mono"
          style={{
            fontSize: 10,
            color: "var(--ws-ink-dim)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          Top Layouts · Pareto-Front
        </span>
        <span
          className="ws-mono"
          style={{ fontSize: 10, color: "var(--ws-ink-dim)" }}
        >
          {variants.length} Varianten
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
          gap: 6,
        }}
      >
        {variants.slice(0, 5).map((v, i) => (
          <CompareTile
            key={v.id}
            rank={v.rank ?? i + 1}
            fitness={v.scores?.overall ?? 0}
            units={v.total_units ?? 0}
            selected={selectedId === v.id}
            onClick={() => onSelect(v.id)}
            hue={hue}
          />
        ))}
      </div>
    </div>
  );
}
