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
import { Building2, TrendingUp, Euro, Hammer, Sliders, RotateCcw } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useProjectStore } from "@/stores/project-store";
import {
  estimateCost,
  formatEur,
  formatArea,
  type Market,
  type CostOverrides,
  DEFAULT_KG300_PER_SQM_BGF,
  DEFAULT_KG400_PER_SQM_BGF,
  DEFAULT_KG500_RATIO_OF_300_400,
  DEFAULT_KG700_RATIO_OF_HARD_COSTS,
  DEFAULT_CONTINGENCY_RATIO,
  RENT_PER_SQM_MONTH_BY_MARKET,
  SALE_PRICE_PER_SQM_NGF_BY_MARKET,
} from "@/lib/cost-estimator";

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
  const [overrides, setOverrides] = useState<CostOverrides>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const buildings = useMemo(() => Object.values(floorPlans), [floorPlans]);
  const building = selectedBuildingId ? floorPlans[selectedBuildingId] : buildings[0];

  const hasOverrides = Object.values(overrides).some((v) => v !== undefined);

  const estimate = useMemo(() => {
    if (!building) return null;
    return estimateCost({
      building,
      market,
      regionalFactor,
      landCostEur: landCostEur > 0 ? landCostEur : undefined,
      overrides: hasOverrides ? overrides : undefined,
    });
  }, [building, market, regionalFactor, landCostEur, overrides, hasOverrides]);

  const defaultRent =
    RENT_PER_SQM_MONTH_BY_MARKET[market] ?? RENT_PER_SQM_MONTH_BY_MARKET.default;
  const defaultSale =
    SALE_PRICE_PER_SQM_NGF_BY_MARKET[market] ?? SALE_PRICE_PER_SQM_NGF_BY_MARKET.default;
  const defaultVacancy =
    market === "munich" || market === "frankfurt"
      ? 3
      : market === "rural" || market === "leipzig"
        ? 8
        : 5;

  const updateOverride = <K extends keyof CostOverrides>(
    key: K,
    raw: string,
  ) => {
    const trimmed = raw.trim();
    setOverrides((prev) => {
      const next = { ...prev };
      if (trimmed === "") {
        delete next[key];
      } else {
        const num = Number(trimmed);
        if (Number.isFinite(num) && num >= 0) {
          next[key] = num as CostOverrides[K];
        }
      }
      return next;
    });
  };

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

      {/* Erweiterte Parameter — per-site overrides for BKI defaults */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sliders className="w-4 h-4" />
            Erweiterte Parameter
            {hasOverrides && (
              <span className="text-xs font-normal bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                {Object.values(overrides).filter((v) => v !== undefined).length} Override
                {Object.values(overrides).filter((v) => v !== undefined).length === 1 ? "" : "s"}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {hasOverrides && (
              <button
                onClick={() => setOverrides({})}
                className="flex items-center gap-1 text-xs text-neutral-600 hover:text-neutral-900 px-2 py-1 rounded hover:bg-neutral-100"
                title="Alle Overrides zurücksetzen"
              >
                <RotateCcw className="w-3 h-3" />
                Zurücksetzen
              </button>
            )}
            <button
              onClick={() => setAdvancedOpen((o) => !o)}
              className="text-xs text-neutral-600 hover:text-neutral-900 px-2 py-1 rounded hover:bg-neutral-100"
            >
              {advancedOpen ? "Schließen" : "Öffnen"}
            </button>
          </div>
        </CardHeader>
        {advancedOpen && (
          <CardContent>
            <p className="text-xs text-neutral-500 mb-4 leading-relaxed">
              Überschreibt die BKI 2024 Bundesmittelwerte mit projektspezifischen Sätzen
              (z.B. aus einer frischen Vergleichswertanalyse). Leerlassen = Standardwert
              verwenden. Der regionale Kostenfaktor oben wird zusätzlich auf KG 300 angewendet.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <OverrideInput
                label="KG 300 (€/m² BGF)"
                placeholder={DEFAULT_KG300_PER_SQM_BGF.toString()}
                value={overrides.kg300PerSqmBgf}
                onChange={(v) => updateOverride("kg300PerSqmBgf", v)}
                hint="Bauwerk Baukonstruktion"
              />
              <OverrideInput
                label="KG 400 (€/m² BGF)"
                placeholder={DEFAULT_KG400_PER_SQM_BGF.toString()}
                value={overrides.kg400PerSqmBgf}
                onChange={(v) => updateOverride("kg400PerSqmBgf", v)}
                hint="Technische Anlagen"
              />
              <OverrideInput
                label="KG 500 Anteil (%)"
                placeholder={(DEFAULT_KG500_RATIO_OF_300_400 * 100).toFixed(1)}
                value={
                  overrides.kg500Ratio !== undefined
                    ? overrides.kg500Ratio * 100
                    : undefined
                }
                onChange={(v) => {
                  const t = v.trim();
                  if (t === "") updateOverride("kg500Ratio", "");
                  else updateOverride("kg500Ratio", String(Number(t) / 100));
                }}
                hint="v. KG 300+400"
              />
              <OverrideInput
                label="KG 700 Anteil (%)"
                placeholder={(DEFAULT_KG700_RATIO_OF_HARD_COSTS * 100).toFixed(1)}
                value={
                  overrides.kg700Ratio !== undefined
                    ? overrides.kg700Ratio * 100
                    : undefined
                }
                onChange={(v) => {
                  const t = v.trim();
                  if (t === "") updateOverride("kg700Ratio", "");
                  else updateOverride("kg700Ratio", String(Number(t) / 100));
                }}
                hint="Baunebenkosten"
              />
              <OverrideInput
                label="Risikozuschlag (%)"
                placeholder={(DEFAULT_CONTINGENCY_RATIO * 100).toFixed(1)}
                value={
                  overrides.contingencyRatio !== undefined
                    ? overrides.contingencyRatio * 100
                    : undefined
                }
                onChange={(v) => {
                  const t = v.trim();
                  if (t === "") updateOverride("contingencyRatio", "");
                  else updateOverride("contingencyRatio", String(Number(t) / 100));
                }}
                hint="Reserve"
              />
              <OverrideInput
                label="Kaltmiete (€/m² Monat)"
                placeholder={defaultRent.toFixed(2)}
                value={overrides.rentPerSqmMonth}
                onChange={(v) => updateOverride("rentPerSqmMonth", v)}
                hint="pro NGF"
                step="0.1"
              />
              <OverrideInput
                label="Verkaufspreis (€/m² NGF)"
                placeholder={defaultSale.toString()}
                value={overrides.salePricePerSqmNgf}
                onChange={(v) => updateOverride("salePricePerSqmNgf", v)}
                hint="ETW"
              />
              <OverrideInput
                label="Leerstand (%)"
                placeholder={defaultVacancy.toString()}
                value={overrides.vacancyPct}
                onChange={(v) => updateOverride("vacancyPct", v)}
                hint="p.a."
                step="0.5"
              />
            </div>
          </CardContent>
        )}
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

function OverrideInput({
  label,
  placeholder,
  value,
  onChange,
  hint,
  step,
}: {
  label: string;
  placeholder: string;
  value: number | undefined;
  onChange: (raw: string) => void;
  hint?: string;
  step?: string;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={value !== undefined ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        step={step ?? "1"}
        min={0}
        className={`mt-1 ${value !== undefined ? "border-amber-400 bg-amber-50" : ""}`}
      />
      {hint && <div className="text-[10px] text-neutral-400 mt-0.5">{hint}</div>}
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
