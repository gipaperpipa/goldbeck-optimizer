"use client";

/**
 * Workspace Tweaks panel (Phase 14c).
 *
 * Floating settings popover for workspace-level visual preferences:
 * density (compact / balanced / spacious), layout (split / stacked /
 * focus), accent hue, and "Zeichnung" toggles for grid / dimensions.
 *
 * State lives in the workspace page; this component is purely
 * presentational.
 */

import { useEffect } from "react";

export type WorkspaceDensity = "compact" | "balanced" | "spacious";
export type WorkspaceLayout = "split" | "stacked" | "focus";

export interface WorkspaceTweaks {
  density: WorkspaceDensity;
  layout: WorkspaceLayout;
  /** Hue in degrees (0-360) feeding the OKLCH `--ws-accent` variable. */
  accentHue: number;
  showGrid: boolean;
  showDims: boolean;
}

export const DEFAULT_TWEAKS: WorkspaceTweaks = {
  density: "balanced",
  layout: "split",
  accentHue: 220,
  showGrid: true,
  showDims: true,
};

/** Padding (px) for canvas containers, derived from density. */
export function paddingForDensity(d: WorkspaceDensity): number {
  return d === "compact" ? 10 : d === "spacious" ? 28 : 18;
}

/** Grid-template-columns for the main canvas split, derived from layout. */
export function gridForLayout(l: WorkspaceLayout): {
  columns: string;
  rows: string;
} {
  switch (l) {
    case "split":
      return { columns: "1.45fr 1fr", rows: "1fr" };
    case "stacked":
      return { columns: "1fr", rows: "1fr 1fr" };
    case "focus":
      return { columns: "1fr", rows: "1fr" };
  }
}

const HUE_PRESETS = [
  { hue: 220, label: "Cyan" },
  { hue: 40, label: "Amber" },
  { hue: 150, label: "Sage" },
  { hue: 300, label: "Violett" },
  { hue: 15, label: "Terra" },
] as const;

interface TweaksPanelProps {
  open: boolean;
  state: WorkspaceTweaks;
  onChange: (next: WorkspaceTweaks) => void;
  onClose: () => void;
}

export function TweaksPanel({ open, state, onChange, onClose }: TweaksPanelProps) {
  // Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = <K extends keyof WorkspaceTweaks>(k: K, v: WorkspaceTweaks[K]) => {
    onChange({ ...state, [k]: v });
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 40,
        left: 60,
        zIndex: 60,
        width: 280,
        background: "white",
        border: "1px solid var(--ws-line-strong)",
        borderRadius: 4,
        boxShadow:
          "0 12px 40px oklch(0.18 0.01 60 / 0.12), 0 2px 6px oklch(0.18 0.01 60 / 0.04)",
        padding: "14px 16px 16px",
        fontSize: 12,
        color: "var(--ws-ink)",
      }}
      role="dialog"
      aria-label="Workspace-Einstellungen"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
          paddingBottom: 10,
          borderBottom: "1px solid var(--ws-line)",
        }}
      >
        <span
          className="ws-mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--ws-ink-mid)",
            fontWeight: 500,
          }}
        >
          Tweaks
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--ws-ink-dim)",
            padding: 2,
            fontSize: 14,
          }}
        >
          ✕
        </button>
      </div>

      <Row label="Dichte">
        <Segmented
          options={[
            ["compact", "Dicht"],
            ["balanced", "Balance"],
            ["spacious", "Weit"],
          ]}
          value={state.density}
          onChange={(v) => set("density", v as WorkspaceDensity)}
        />
      </Row>

      <Row label="Layout">
        <Segmented
          options={[
            ["split", "Split"],
            ["stacked", "Gestapelt"],
            ["focus", "Fokus"],
          ]}
          value={state.layout}
          onChange={(v) => set("layout", v as WorkspaceLayout)}
        />
      </Row>

      <Row label={`Akzentfarbe · ${state.accentHue}°`}>
        <input
          type="range"
          min={0}
          max={360}
          step={5}
          value={state.accentHue}
          onChange={(e) => set("accentHue", Number(e.target.value))}
          style={{
            width: "100%",
            accentColor: `oklch(0.55 0.12 ${state.accentHue})`,
          }}
        />
        <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
          {HUE_PRESETS.map((p) => (
            <button
              key={p.hue}
              type="button"
              onClick={() => set("accentHue", p.hue)}
              title={`${p.label} (${p.hue}°)`}
              style={{
                width: 22,
                height: 22,
                background: `oklch(0.55 0.12 ${p.hue})`,
                border:
                  state.accentHue === p.hue
                    ? "2px solid var(--ws-ink)"
                    : "1px solid var(--ws-line)",
                cursor: "pointer",
                borderRadius: 2,
                padding: 0,
              }}
            />
          ))}
        </div>
      </Row>

      <Row label="Zeichnung">
        <Checkbox
          checked={state.showGrid}
          onChange={(v) => set("showGrid", v)}
          label="Raster anzeigen"
        />
        <Checkbox
          checked={state.showDims}
          onChange={(v) => set("showDims", v)}
          label="Maßketten anzeigen"
        />
      </Row>

      <button
        type="button"
        onClick={() => onChange(DEFAULT_TWEAKS)}
        style={{
          width: "100%",
          marginTop: 6,
          padding: "6px 8px",
          background: "var(--ws-neutral-bg)",
          border: "1px solid var(--ws-line)",
          borderRadius: 3,
          cursor: "pointer",
          fontSize: 11,
          color: "var(--ws-ink-mid)",
        }}
      >
        Zurücksetzen
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}
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
        {label}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        background: "var(--ws-neutral-bg)",
        padding: 2,
        borderRadius: 3,
      }}
    >
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          style={{
            flex: 1,
            padding: "6px 8px",
            background: value === k ? "white" : "transparent",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 11,
            fontWeight: 500,
            color: value === k ? "var(--ws-ink)" : "var(--ws-ink-dim)",
            borderRadius: 2,
            boxShadow:
              value === k ? "0 1px 2px oklch(0.18 0.01 60 / 0.08)" : "none",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        fontSize: 12,
        color: "var(--ws-ink)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
