"use client";

import type {
  FloorPlanApartment,
  LayoutOption,
  PlotAnalysis,
} from "@/types/api";
import { Pill } from "./pill";

export interface SidebarMetric {
  label: string;
  value: string;
  sub: string;
}

interface LeftSidebarProps {
  projectName: string;
  projectAddress?: string;
  layout: LayoutOption | null;
  plot: PlotAnalysis | null | undefined;
  apartments: FloorPlanApartment[];
  selectedAptId: string | null;
  onSelectApt: (id: string) => void;
  floorLabel: string;
}

function formatAreaDe(n: number): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: 0 });
}

function deriveMetrics(
  layout: LayoutOption | null,
  plot: PlotAnalysis | null | undefined,
  apartments: FloorPlanApartment[],
): SidebarMetric[] {
  const ngfPerApt =
    apartments.length > 0
      ? apartments.reduce((s, a) => s + a.total_area_sqm, 0) / apartments.length
      : 0;
  const totalApts = layout?.total_units ?? 0;
  const stories = layout?.buildings?.[0]?.stories ?? 0;
  const aptsPerStory =
    stories > 0 && totalApts > 0 ? Math.round(totalApts / stories) : 0;

  const bgf = layout?.buildings?.reduce((s, b) => s + b.gross_floor_area_sqm, 0) ?? 0;
  const ngf = layout?.total_residential_sqm ?? 0;
  const efficiency = bgf > 0 ? (ngf / bgf) * 100 : 0;
  const grz = layout?.lot_coverage_pct ?? 0;
  const gfz = layout?.far_achieved ?? 0;
  const grzMax = layout?.regulation_check?.height_max_m
    ? undefined
    : undefined; // not directly available; show "/0.4 zul." as a hint
  void grzMax;

  return [
    {
      label: "GFZ",
      value: gfz > 0 ? gfz.toFixed(2) : "—",
      sub: layout?.regulation_check?.far_max
        ? `/ ${layout.regulation_check.far_max.toFixed(1)} zul.`
        : "",
    },
    {
      label: "GRZ",
      value: grz > 0 ? (grz / 100).toFixed(2) : "—",
      sub: "/ 0.40 zul.",
    },
    {
      label: "BGF",
      value: bgf > 0 ? `${formatAreaDe(bgf)} m²` : "—",
      sub: stories > 0 ? `${stories} Geschosse` : "",
    },
    {
      label: "WFL",
      value: ngf > 0 ? `${formatAreaDe(ngf)} m²` : "—",
      sub: efficiency > 0 ? `${efficiency.toFixed(0)}% eff.` : "",
    },
    {
      label: "WE",
      value: totalApts > 0 ? String(totalApts) : "—",
      sub: aptsPerStory > 0 ? `${aptsPerStory} × Etage` : "",
    },
    {
      label: "Ø Wfl.",
      value: ngfPerApt > 0 ? `${ngfPerApt.toFixed(1)} m²` : "—",
      sub: "Ziel 45–55",
    },
  ];
}

function aptTypeLabel(t: string): string {
  const m = /^(\d)_room$/.exec(t);
  return m ? `${m[1]} Zi` : t.replace("_", " ");
}

function aptOrientation(side: string): "S" | "N" | "—" {
  const s = side.toLowerCase();
  if (s.includes("south") || s === "s" || s.includes("süd")) return "S";
  if (s.includes("north") || s === "n" || s.includes("nord")) return "N";
  return "—";
}

function ApartmentRow({
  apt,
  selected,
  onSelect,
}: {
  apt: FloorPlanApartment;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const orientation = aptOrientation(apt.side);
  const tone =
    orientation === "S" ? "south" : orientation === "N" ? "north" : "neutral";

  return (
    <button
      type="button"
      onClick={() => onSelect(apt.id)}
      style={{
        display: "grid",
        gridTemplateColumns: "32px 1fr auto",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 12px",
        background: selected ? "var(--ws-accent-bg)" : "transparent",
        border: "none",
        borderLeft: `2px solid ${
          selected ? "var(--ws-accent)" : "transparent"
        }`,
        textAlign: "left",
        cursor: "pointer",
        color: "inherit",
        fontFamily: "inherit",
      }}
    >
      <span
        className="ws-mono"
        style={{
          fontSize: 10,
          color: selected ? "oklch(0.35 0.12 220)" : "var(--ws-ink-dim)",
          fontWeight: 500,
        }}
      >
        {apt.unit_number || apt.id.slice(0, 4)}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ws-ink)" }}>
            {aptTypeLabel(apt.apartment_type)}
          </span>
          <span
            className="ws-mono"
            style={{ fontSize: 11, color: "var(--ws-ink-dim)" }}
          >
            {apt.total_area_sqm.toFixed(1)} m²
          </span>
        </div>
      </div>
      <Pill tone={tone}>{orientation}</Pill>
    </button>
  );
}

export function LeftSidebar({
  projectName,
  projectAddress,
  layout,
  plot,
  apartments,
  selectedAptId,
  onSelectApt,
  floorLabel,
}: LeftSidebarProps) {
  const metrics = deriveMetrics(layout, plot, apartments);

  return (
    <aside
      className="ws-scrollable"
      style={{
        width: 300,
        flexShrink: 0,
        borderRight: "1px solid var(--ws-line)",
        background: "var(--ws-bg)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Project header */}
      <div
        style={{
          padding: "18px 20px 16px",
          borderBottom: "1px solid var(--ws-line)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 10,
          }}
        >
          <div
            className="ws-mono"
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              background: "var(--ws-ink)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.05em",
            }}
          >
            GB
          </div>
          <div
            className="ws-mono"
            style={{
              fontSize: 11,
              color: "var(--ws-ink-dim)",
              letterSpacing: "0.1em",
            }}
          >
            GOLDBECK · OPTIMIZER
          </div>
        </div>
        <div
          className="ws-serif"
          style={{
            fontSize: 26,
            lineHeight: 1.1,
            letterSpacing: "-0.01em",
            color: "var(--ws-ink)",
            marginBottom: 4,
          }}
        >
          {projectName}
        </div>
        {projectAddress && (
          <div style={{ fontSize: 12, color: "var(--ws-ink-dim)" }}>
            {projectAddress}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <Pill tone="ok">PLANUNG</Pill>
          {plot && (
            <Pill>
              {plot.area_sqm > 0
                ? `${formatAreaDe(plot.area_sqm)} m²`
                : "Grundstück"}
            </Pill>
          )}
          {layout?.regulation_check?.is_compliant && (
            <Pill tone="accent">§ konform</Pill>
          )}
        </div>
      </div>

      {/* Key numbers */}
      <div
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid var(--ws-line)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "14px 16px",
        }}
      >
        {metrics.map((m) => (
          <div key={m.label}>
            <div
              className="ws-mono"
              style={{
                fontSize: 10,
                color: "var(--ws-ink-dim)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: 2,
              }}
            >
              {m.label}
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: "var(--ws-ink)",
                letterSpacing: "-0.01em",
              }}
            >
              {m.value}
            </div>
            <div
              className="ws-mono"
              style={{ fontSize: 10, color: "var(--ws-ink-dim)" }}
            >
              {m.sub}
            </div>
          </div>
        ))}
      </div>

      {/* Apartments list */}
      <div className="ws-scrollable" style={{ flex: 1, overflow: "auto", paddingBottom: 20 }}>
        <div
          style={{
            padding: "14px 20px 6px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            className="ws-mono"
            style={{
              fontSize: 11,
              color: "var(--ws-ink-mid)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            Wohnungen · {floorLabel}
          </div>
          <span
            className="ws-mono"
            style={{ fontSize: 10, color: "var(--ws-ink-dim)" }}
          >
            {apartments.length}
          </span>
        </div>
        <div style={{ padding: "0 8px" }}>
          {apartments.length === 0 && (
            <div
              style={{
                padding: "12px 12px",
                fontSize: 12,
                color: "var(--ws-ink-dim)",
              }}
            >
              Keine Wohnungen — Etage zeigt Erschließung oder Gewerbe.
            </div>
          )}
          {apartments.map((apt) => (
            <ApartmentRow
              key={apt.id}
              apt={apt}
              selected={selectedAptId === apt.id}
              onSelect={onSelectApt}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
