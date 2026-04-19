"use client";

/**
 * Construction cost panel (Phase 4.3).
 *
 * Shows a DIN-276 KG-based cost breakdown for the currently selected
 * building, plus a revenue benchmark (rent + sale price) and a
 * cost-to-value ratio / gross margin summary.
 *
 * This panel is purely client-side — it runs `estimateCost()` on the
 * BuildingFloorPlans already loaded in the store. No backend call.
 */

import { useMemo, useState } from "react";
import { Building2, TrendingUp, Euro, Hammer } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useProjectStore } from "@/stores/project-store";
import { estimateCost, formatEur, formatArea, type Market } from "@/lib/cost-estimator";

const MARKET_OPTIONS: { value: Market; label: string }[] = [
  { value: "default", label: "Deutschland Ø" },
  { value: "berlin", label: "Berlin" },
  { value: "munich", label: "München" },
  { value: "hamburg", label: "Hamburg" },
  { value: "frankfurt", label: "Frankfurt" },
  { value: "cologne", label: "Köln" },
  { value: "stuttgart", label: "Stuttgart" },
  { value: "dresden", label: "Dresden" },
  { value: "leipzig", label: "Leipzig" },
  { value: "rural", label: "Ländlich" },
];

const REGIONAL_FACTOR_PRESETS: { label: string; value: number }[] = [
  { label: "Ländlich −5 %", value: 0.95 },
  { label: "Standard", value: 1.0 },
  { label: "Großstadt +8 %", value: 1.08 },
  { label: "München / HH +15 %", value: 1.15 },
];

export function CostPanel() {
  const { floorPlans, selectedBuildingId, setSelectedBuildingId } = useProjectStore();
  const [market, setMarket] = useState<Market>("default");
  const [regionalFactor, setRegionalFactor] = useState(1.0);
  const [landCostEur, setLandCostEur] = useState<number>(0);

  const buildings = useMemo(() => Object.values(floorPlans), [floorPlans]);
  const building = selectedBuildingId ? floorPlans[selectedBuildingId] : buildings[0];

  const estimate = useMemo(() => {
    if (!building) return null;
    return estimateCost({
      building,
      market,
      regionalFactor,
      landCostEur: landCostEur > 0 ? landCostEur : undefined,
    });
  }, [building, market, regionalFactor, landCostEur]);

  if (buildings.length === 0) {
    return (
      <div className="text-center text-neutral-500 py-12">
        <Building2 className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="mb-1">Noch keine Grundrisse generiert.</p>
        <p className="text-sm">
          Öffne den Grundrissgenerator im Layouts-Tab, um eine Kostenschätzung zu erhalten.
        </p>
      </div>
    );
  }

  if (!building || !estimate) {
    return (
      <div className="text-center text-neutral-500 py-12">
        <p>Wähle ein Gebäude, um die Kostenschätzung anzuzeigen.</p>
      </div>
    );
  }

  const { areas, costs, perUnit, perSqmBgf, perSqmNgf, revenue, costToValueRatio, grossMargin, grossMarginPct } = estimate;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hammer className="w-5 h-5" />
            Baukosten & Erlösprognose
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Label>Gebäude</Label>
              <select
                value={selectedBuildingId ?? buildings[0]?.building_id ?? ""}
                onChange={(e) => setSelectedBuildingId(e.target.value)}
                className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-white"
              >
                {buildings.map((b) => (
                  <option key={b.building_id} value={b.building_id}>
                    {b.building_id} · {b.total_apartments} WE · {b.num_stories} OG
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Markt (Erlöse)</Label>
              <select
                value={market}
                onChange={(e) => setMarket(e.target.value as Market)}
                className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-white"
              >
                {MARKET_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Regionaler Kostenfaktor</Label>
              <select
                value={regionalFactor}
                onChange={(e) => setRegionalFactor(Number(e.target.value))}
                className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-white"
              >
                {REGIONAL_FACTOR_PRESETS.map((opt) => (
                  <option key={opt.label} value={opt.value}>
                    {opt.label} ({opt.value.toFixed(2)}×)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Grundstückskosten (€)</Label>
              <Input
                type="number"
                value={landCostEur}
                onChange={(e) => setLandCostEur(Math.max(0, Number(e.target.value) || 0))}
                placeholder="0"
                className="mt-1"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard
          icon={<Building2 className="w-4 h-4" />}
          label="BGF gesamt"
          value={formatArea(areas.bgfSqm)}
          sub={`NGF ${formatArea(areas.ngfSqm)}`}
        />
        <SummaryCard
          icon={<Hammer className="w-4 h-4" />}
          label="Baukosten"
          value={formatEur(costs.totalConstruction)}
          sub={`${formatEur(perSqmBgf.constructionCost)}/m² BGF`}
        />
        <SummaryCard
          icon={<Euro className="w-4 h-4" />}
          label="Gesamtkosten"
          value={formatEur(costs.total)}
          sub={landCostEur > 0 ? `inkl. ${formatEur(landCostEur)} Grund` : "ohne Grundstück"}
        />
        <SummaryCard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Verkehrswert"
          value={formatEur(revenue.saleValue)}
          sub={`${formatEur(revenue.saleValue / Math.max(1, building.total_apartments))}/WE`}
          tone={grossMargin >= 0 ? "positive" : "negative"}
        />
      </div>

      {/* Detailed breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* KG breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kostengliederung DIN 276</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                <KgRow label="KG 300 · Bauwerk Baukonstruktion" value={costs.kg300} hint={`${formatEur(perSqmBgf.kg300)}/m²`} />
                <KgRow label="KG 400 · Bauwerk Technische Anlagen" value={costs.kg400} hint={`${formatEur(perSqmBgf.kg400)}/m²`} />
                <KgRow label="KG 500 · Außenanlagen" value={costs.kg500} hint="3 % v. KG 300+400" />
                <KgRow label="KG 700 · Baunebenkosten" value={costs.kg700} hint="18 % v. hart" />
                <KgRow label="Risikozuschlag" value={costs.contingency} hint="5 %" muted />
                <tr className="border-t-2 border-neutral-900">
                  <td className="py-2 font-semibold">Summe Bau & Planung</td>
                  <td className="py-2 text-right font-semibold">{formatEur(costs.totalConstruction)}</td>
                </tr>
                {costs.land > 0 && (
                  <tr className="border-t border-neutral-200">
                    <td className="py-2">KG 100 · Grundstück</td>
                    <td className="py-2 text-right">{formatEur(costs.land)}</td>
                  </tr>
                )}
                <tr className="border-t-2 border-neutral-900 bg-neutral-50">
                  <td className="py-2 font-bold">Gesamtinvestition</td>
                  <td className="py-2 text-right font-bold">{formatEur(costs.total)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Revenue + ratios */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Erlöse & Kennzahlen</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <MetricRow label="Kaltmiete (Monat)" value={formatEur(revenue.monthlyRent)} />
              <MetricRow label="Kaltmiete (Jahr)" value={formatEur(revenue.annualRent)} />
              <MetricRow
                label={`Effektive Jahresmiete (nach ${revenue.vacancyPct} % Leerstand)`}
                value={formatEur(revenue.effectiveAnnualRent)}
                muted
              />
              <div className="border-t my-2" />
              <MetricRow label="Verkaufswert (als ETW)" value={formatEur(revenue.saleValue)} />
              <MetricRow
                label="Preis / m² NGF"
                value={formatEur(revenue.saleValue / Math.max(1, areas.ngfSqm))}
                muted
              />
              <div className="border-t my-2" />
              <MetricRow
                label="Kosten / Verkehrswert"
                value={`${(costToValueRatio * 100).toFixed(1)} %`}
                tone={costToValueRatio < 0.75 ? "positive" : costToValueRatio < 0.9 ? "neutral" : "negative"}
                hint={costToValueRatio < 0.75 ? "gesund" : costToValueRatio < 0.9 ? "knapp" : "kritisch"}
              />
              <MetricRow
                label="Rohmarge"
                value={formatEur(grossMargin)}
                tone={grossMargin > 0 ? "positive" : "negative"}
                hint={`${grossMarginPct.toFixed(1)} %`}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Per-unit / per-m² grid */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bezugsgrößen</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MiniStat label="Gesamt / WE" value={formatEur(perUnit.totalCost)} />
            <MiniStat label="Bau / WE" value={formatEur(perUnit.constructionCost)} />
            <MiniStat label="Gesamt / m² BGF" value={formatEur(perSqmBgf.totalCost)} />
            <MiniStat label="Bau / m² NGF" value={formatEur(perSqmNgf.constructionCost)} />
            <MiniStat label="Fassadenfläche" value={formatArea(areas.facadeSqm)} />
            <MiniStat label="Dachfläche" value={formatArea(areas.roofSqm)} />
            <MiniStat label="Bruttorauminhalt" value={`${areas.briCbm.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m³`} />
            <MiniStat label="Geschosse" value={String(areas.stories)} />
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-neutral-500 leading-relaxed">
        Benchmarks: BKI 2024 Wohnungsbau mittlerer Standard, angepasst um −8–12 % für Goldbeck-Elementbau
        gegenüber Ortbeton. DIN 276 Kostengliederung. Preise netto, ohne Umsatzsteuer.
        Erlös-Benchmarks: durchschnittliche Angebotspreise Immobilienscout24 & JLL Q1/2024.
        Alle Werte sind grobe Kostenrahmen und ersetzen keine Leistungsphase-3-Kostenberechnung.
      </p>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function SummaryCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    tone === "positive" ? "text-emerald-700" : tone === "negative" ? "text-rose-700" : "text-neutral-900";
  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="flex items-center gap-2 text-xs text-neutral-500 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`text-xl font-bold ${toneClass}`}>{value}</div>
      {sub && <div className="text-xs text-neutral-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function KgRow({ label, value, hint, muted }: { label: string; value: number; hint?: string; muted?: boolean }) {
  return (
    <tr className={`border-t border-neutral-100 ${muted ? "text-neutral-500" : ""}`}>
      <td className="py-1.5">
        {label}
        {hint && <span className="text-xs text-neutral-400 ml-2">({hint})</span>}
      </td>
      <td className="py-1.5 text-right tabular-nums">{formatEur(value)}</td>
    </tr>
  );
}

function MetricRow({
  label,
  value,
  hint,
  tone,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "positive" | "negative" | "neutral";
  muted?: boolean;
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "negative"
      ? "text-rose-700"
      : tone === "neutral"
      ? "text-amber-700"
      : muted
      ? "text-neutral-500"
      : "text-neutral-900";
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? "text-neutral-500" : "text-neutral-700"}>{label}</span>
      <span className={`font-semibold tabular-nums ${toneClass}`}>
        {value}
        {hint && <span className="ml-2 text-xs font-normal opacity-70">{hint}</span>}
      </span>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}
