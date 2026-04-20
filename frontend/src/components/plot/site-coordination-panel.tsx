"use client";

/**
 * Multi-building site coordination panel (Phase 4.5).
 *
 * Shows Abstandsflächen (BauO NRW §6) compliance between every pair
 * of buildings in the current layout, plus plot coverage (GRZ),
 * height homogeneity, and axis alignment. Includes a top-down SVG
 * diagram colored by Abstandsflächen status.
 */

import { useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle, Ruler, Grid3x3 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useProjectStore } from "@/stores/project-store";
import { analyzeSite, formatMeters, DEFAULT_H_COEFF } from "@/lib/site-coordination";

const H_COEFF_PRESETS: { label: string; value: number; hint: string }[] = [
  { label: "§6 Regelfall 0,4 H", value: 0.4, hint: "Wohngebiet / Mischgebiet" },
  { label: "§6 Kerngebiet 0,25 H", value: 0.25, hint: "Innenstadtkern" },
  { label: "§6 Nebengebäude 0,2 H", value: 0.2, hint: "Garagen, Schuppen" },
];

export function SiteCoordinationPanel() {
  const { selectedLayout, plotAnalysis } = useProjectStore();
  const [hCoeff, setHCoeff] = useState(DEFAULT_H_COEFF);

  const result = useMemo(() => {
    if (!selectedLayout) return null;
    return analyzeSite({
      layout: selectedLayout,
      plotAreaSqm: plotAnalysis?.area_sqm,
      hCoeff,
    });
  }, [selectedLayout, plotAnalysis, hCoeff]);

  if (!selectedLayout) {
    return (
      <div className="text-center text-neutral-500 py-12">
        <Grid3x3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p>Wähle zunächst ein Layout im Layouts-Tab.</p>
      </div>
    );
  }

  if (!result) return null;

  const { buildings, pairs, totalFootprintSqm, grz, heightStats, isAligned, commonRotationDeg, summary } = result;

  const verdict =
    summary.pairFails > 0
      ? { cls: "text-rose-700 border-rose-300 bg-rose-50", icon: <XCircle className="w-4 h-4" />, label: "Abstandsflächen verletzt" }
      : summary.pairWarns > 0
      ? { cls: "text-amber-700 border-amber-300 bg-amber-50", icon: <AlertTriangle className="w-4 h-4" />, label: "Grenzwertig" }
      : { cls: "text-emerald-700 border-emerald-300 bg-emerald-50", icon: <CheckCircle2 className="w-4 h-4" />, label: "BauO-konform" };

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ruler className="w-5 h-5" />
            Abstandsflächen & Standortkoordination
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Abstandsflächen-Koeffizient</Label>
              <select
                value={hCoeff}
                onChange={(e) => setHCoeff(Number(e.target.value))}
                className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-white"
              >
                {H_COEFF_PRESETS.map((opt) => (
                  <option key={opt.label} value={opt.value}>
                    {opt.label} — {opt.hint}
                  </option>
                ))}
              </select>
              <p className="text-xs text-neutral-500 mt-1">
                Erforderlicher Abstand = {hCoeff} · H (min. 3 m). Abweichungen müssen bei der unteren
                Bauaufsichtsbehörde beantragt werden.
              </p>
            </div>
            <div className="flex items-center">
              <div className={`w-full border rounded-lg p-4 ${verdict.cls}`}>
                <div className="flex items-center gap-2 text-xs mb-1">
                  {verdict.icon}
                  <span>Gesamt-Status</span>
                </div>
                <div className="text-lg font-bold">{verdict.label}</div>
                <div className="text-xs mt-0.5 opacity-80">
                  {summary.pairFails} Verletzung(en) · {summary.pairWarns} grenzwertig · {pairs.length - summary.pairFails - summary.pairWarns} OK
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Gebäude" value={String(buildings.length)} sub={`${pairs.length} Paare geprüft`} />
        <KpiCard
          label="Gesamtfußabdruck"
          value={`${totalFootprintSqm.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m²`}
          sub={grz !== null ? `GRZ ${grz.toFixed(2)}` : "GRZ unbekannt"}
          tone={summary.grzOver ? "negative" : grz !== null ? "positive" : undefined}
        />
        <KpiCard
          label="Höhenspanne"
          value={`${heightStats.min.toFixed(1)} – ${heightStats.max.toFixed(1)} m`}
          sub={`σ ${heightStats.stdDev.toFixed(1)} m`}
          tone={summary.heightSpread ? "negative" : "positive"}
        />
        <KpiCard
          label="Achsausrichtung"
          value={isAligned ? "Einheitlich" : "Heterogen"}
          sub={isAligned && commonRotationDeg !== null ? `${commonRotationDeg.toFixed(0)}°` : "> 5° Abweichung"}
          tone={isAligned ? "positive" : "negative"}
        />
      </div>

      {/* Diagram + pair table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lageplan (Top-Down)</CardTitle>
          </CardHeader>
          <CardContent>
            <SiteDiagram result={result} />
            <LegendRow />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paarweise Abstandsflächenprüfung</CardTitle>
          </CardHeader>
          <CardContent>
            {pairs.length === 0 ? (
              <p className="text-sm text-neutral-500">Nur ein Gebäude — keine Paare.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-neutral-500 border-b">
                    <th className="text-left py-1.5">Paar</th>
                    <th className="text-right py-1.5">Abstand</th>
                    <th className="text-right py-1.5">erford.</th>
                    <th className="text-right py-1.5">Δ</th>
                    <th className="text-center py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((p) => (
                    <tr key={`${p.a}-${p.b}`} className="border-t border-neutral-100">
                      <td className="py-1.5 font-mono text-xs">
                        {p.a} ↔ {p.b}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{formatMeters(p.minDistance)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatMeters(p.required)}</td>
                      <td
                        className={`py-1.5 text-right tabular-nums ${
                          p.status === "fail" ? "text-rose-700" : p.status === "warn" ? "text-amber-700" : "text-emerald-700"
                        }`}
                      >
                        {p.status === "fail" ? `−${formatMeters(p.shortfall)}` : `+${formatMeters(p.minDistance - p.required)}`}
                      </td>
                      <td className="py-1.5 text-center">
                        <StatusPill status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-neutral-500 leading-relaxed">
        Screening nach MBO §6 / BauO NRW §6. Prüft nur interne
        Abstandsflächen zwischen eigenen Gebäuden. Ein vollständiger
        Abstandsflächennachweis erfordert zusätzlich die Bemessung gegen
        Grundstücksgrenzen und Nachbarbauten — fallen diese in den
        Bebauungsplan-Baulinien, gilt §6 Abs. 1 S. 3 (Einhaltung
        verzichtbar). Diese Panel-Prüfung ersetzt keinen Nachweis durch
        den Entwurfsverfasser.
      </p>
    </div>
  );
}

// ── Diagram ───────────────────────────────────────────────────────

function SiteDiagram({ result }: { result: ReturnType<typeof analyzeSite> }) {
  const { buildings, pairs } = result;
  const padding = 20;
  const svgW = 520;
  const svgH = 360;

  // Compute bbox of all corners
  const all = buildings.flatMap((b) => b.corners);
  if (all.length === 0) {
    return <div className="text-sm text-neutral-500">Kein Gebäude gefunden.</div>;
  }
  const minX = Math.min(...all.map((p) => p[0]));
  const maxX = Math.max(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1]));
  const maxY = Math.max(...all.map((p) => p[1]));
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min((svgW - 2 * padding) / spanX, (svgH - 2 * padding) / spanY);

  const tx = (x: number) => padding + (x - minX) * scale;
  const ty = (y: number) => svgH - padding - (y - minY) * scale;

  const buildingColor = (id: string): string => {
    const statuses = pairs
      .filter((p) => p.a === id || p.b === id)
      .map((p) => p.status);
    if (statuses.includes("fail")) return "#fecaca"; // rose-200
    if (statuses.includes("warn")) return "#fde68a"; // amber-200
    return "#d1fae5"; // emerald-200
  };

  const buildingStroke = (id: string): string => {
    const statuses = pairs
      .filter((p) => p.a === id || p.b === id)
      .map((p) => p.status);
    if (statuses.includes("fail")) return "#be123c";
    if (statuses.includes("warn")) return "#b45309";
    return "#047857";
  };

  return (
    <svg width={svgW} height={svgH} className="w-full h-auto border rounded bg-neutral-50">
      {/* Connection lines between building centroids */}
      {pairs.map((p) => {
        const A = buildings.find((b) => b.id === p.a);
        const B = buildings.find((b) => b.id === p.b);
        if (!A || !B) return null;
        const ax = A.corners.reduce((s, c) => s + c[0], 0) / 4;
        const ay = A.corners.reduce((s, c) => s + c[1], 0) / 4;
        const bx = B.corners.reduce((s, c) => s + c[0], 0) / 4;
        const by = B.corners.reduce((s, c) => s + c[1], 0) / 4;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const col =
          p.status === "fail" ? "#e11d48" : p.status === "warn" ? "#d97706" : "#059669";
        return (
          <g key={`${p.a}-${p.b}`}>
            <line
              x1={tx(ax)}
              y1={ty(ay)}
              x2={tx(bx)}
              y2={ty(by)}
              stroke={col}
              strokeWidth={1.5}
              strokeDasharray={p.status === "pass" ? undefined : "4 3"}
              opacity={0.7}
            />
            <text
              x={tx(mx)}
              y={ty(my)}
              fontSize={10}
              fill={col}
              textAnchor="middle"
              dy={-3}
              style={{ paintOrder: "stroke", stroke: "#fff", strokeWidth: 2 }}
            >
              {formatMeters(p.minDistance, 1)}
            </text>
          </g>
        );
      })}
      {/* Buildings */}
      {buildings.map((b) => {
        const pts = b.corners.map((c) => `${tx(c[0])},${ty(c[1])}`).join(" ");
        const cx = b.corners.reduce((s, c) => s + c[0], 0) / 4;
        const cy = b.corners.reduce((s, c) => s + c[1], 0) / 4;
        return (
          <g key={b.id}>
            <polygon points={pts} fill={buildingColor(b.id)} stroke={buildingStroke(b.id)} strokeWidth={1.5} />
            <text
              x={tx(cx)}
              y={ty(cy)}
              fontSize={11}
              fontWeight={600}
              textAnchor="middle"
              dy={4}
              fill="#111"
            >
              {b.id}
            </text>
            <text
              x={tx(cx)}
              y={ty(cy)}
              fontSize={9}
              textAnchor="middle"
              dy={16}
              fill="#555"
            >
              h={b.height.toFixed(1)} m
            </text>
          </g>
        );
      })}
      {/* North arrow */}
      <g transform={`translate(${svgW - 30}, ${28})`}>
        <line x1={0} y1={14} x2={0} y2={-14} stroke="#666" strokeWidth={1.5} />
        <polygon points="0,-14 -4,-6 4,-6" fill="#666" />
        <text x={0} y={26} fontSize={10} fill="#666" textAnchor="middle">N</text>
      </g>
    </svg>
  );
}

function LegendRow() {
  return (
    <div className="flex items-center gap-3 mt-2 text-xs text-neutral-600">
      <LegendSwatch color="#d1fae5" stroke="#047857" label="OK" />
      <LegendSwatch color="#fde68a" stroke="#b45309" label="grenzwertig" />
      <LegendSwatch color="#fecaca" stroke="#be123c" label="Verletzung" />
      <span className="ml-auto text-neutral-400">Entfernungen in m entlang kürzester Facade-Facade-Linie</span>
    </div>
  );
}

function LegendSwatch({ color, stroke, label }: { color: string; stroke: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className="w-4 h-3 inline-block rounded-sm border"
        style={{ background: color, borderColor: stroke }}
      />
      <span>{label}</span>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative";
}) {
  const cls =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "negative"
      ? "text-rose-700"
      : "text-neutral-900";
  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="text-xs text-neutral-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${cls}`}>{value}</div>
      {sub && <div className="text-xs text-neutral-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: "pass" | "warn" | "fail" }) {
  if (status === "pass") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-3 h-3" /> OK
      </span>
    );
  }
  if (status === "warn") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-amber-50 text-amber-700 border border-amber-200">
        <AlertTriangle className="w-3 h-3" /> Knapp
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-rose-50 text-rose-700 border border-rose-200">
      <XCircle className="w-3 h-3" /> Fehler
    </span>
  );
}
