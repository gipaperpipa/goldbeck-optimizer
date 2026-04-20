"use client";

/**
 * Thermal envelope panel (Phase 4.4).
 *
 * Shows a GEG 2023 compatibility indicator for the currently selected
 * building: envelope element breakdown (U × A × F_x), H_T', annual
 * heating demand, and KfW Effizienzhaus tier.
 *
 * Pure client-side — runs `estimateThermal()` on the
 * `BuildingFloorPlans` already in the project store. No backend call.
 */

import { useMemo, useState } from "react";
import { Building2, Flame, Thermometer, Snowflake, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useProjectStore } from "@/stores/project-store";
import {
  estimateThermal,
  U_VALUES,
  GEG_HT_PRIME_REFERENCE,
  formatU,
  formatKwhPerSqm,
  formatHt,
  formatArea,
  type ThermalStandard,
} from "@/lib/thermal-envelope";

const STANDARD_ORDER: ThermalStandard[] = [
  "geg_reference",
  "goldbeck_standard",
  "kfw_55",
  "kfw_40",
  "passivhaus",
];

const ELEMENT_LABELS: Record<string, string> = {
  wall: "Außenwand",
  window: "Fenster",
  door: "Außentür",
  roof: "Dach",
  floor: "Bodenplatte",
};

export function ThermalPanel() {
  const { floorPlans, selectedBuildingId, setSelectedBuildingId } = useProjectStore();
  const [standard, setStandard] = useState<ThermalStandard>("goldbeck_standard");

  const buildings = useMemo(() => Object.values(floorPlans), [floorPlans]);
  const building = selectedBuildingId ? floorPlans[selectedBuildingId] : buildings[0];

  const estimate = useMemo(() => {
    if (!building) return null;
    return estimateThermal({ building, standard });
  }, [building, standard]);

  if (buildings.length === 0) {
    return (
      <div className="text-center text-neutral-500 py-12">
        <Building2 className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="mb-1">Noch keine Grundrisse generiert.</p>
        <p className="text-sm">Öffne den Grundrissgenerator im Layouts-Tab, um die Energiebilanz zu sehen.</p>
      </div>
    );
  }

  if (!building || !estimate) {
    return (
      <div className="text-center text-neutral-500 py-12">
        <p>Wähle ein Gebäude, um die Energiebilanz anzuzeigen.</p>
      </div>
    );
  }

  const u = U_VALUES[standard];
  const { elements, envelopeArea, ngfSqm, heatedVolume, htTotal, htPrime, qHeating, qHeatingPerSqm, avRatio, gegStatus, kfwTier } = estimate;

  const gegTone =
    gegStatus === "pass"
      ? { cls: "text-emerald-700 border-emerald-300 bg-emerald-50", icon: <CheckCircle2 className="w-4 h-4" />, label: "GEG 2023 erfüllt" }
      : gegStatus === "warn"
      ? { cls: "text-amber-700 border-amber-300 bg-amber-50", icon: <AlertTriangle className="w-4 h-4" />, label: "Knapp — grenzwertig" }
      : { cls: "text-rose-700 border-rose-300 bg-rose-50", icon: <XCircle className="w-4 h-4" />, label: "GEG 2023 nicht erfüllt" };

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Thermometer className="w-5 h-5" />
            Energetische Hülle & GEG 2023
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              <Label>Dämmstandard</Label>
              <select
                value={standard}
                onChange={(e) => setStandard(e.target.value as ThermalStandard)}
                className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-white"
              >
                {STANDARD_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {U_VALUES[s].label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-neutral-500 mt-1">{u.description}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* GEG verdict + headline KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className={`border rounded-lg p-4 ${gegTone.cls}`}>
          <div className="flex items-center gap-2 text-xs mb-1">
            {gegTone.icon}
            <span>GEG 2023 Referenzprüfung</span>
          </div>
          <div className="text-xl font-bold">{gegTone.label}</div>
          <div className="text-xs mt-0.5 opacity-80">
            H_T′ {htPrime.toFixed(2)} vs. Grenzwert {GEG_HT_PRIME_REFERENCE.toFixed(2)} W/(m²·K)
          </div>
        </div>
        <KpiCard
          icon={<Flame className="w-4 h-4" />}
          label="Heizwärmebedarf"
          value={formatKwhPerSqm(qHeatingPerSqm)}
          sub={`${Math.round(qHeating).toLocaleString("de-DE")} kWh/a gesamt`}
          tone={qHeatingPerSqm <= 30 ? "positive" : qHeatingPerSqm <= 60 ? "neutral" : "negative"}
        />
        <KpiCard
          icon={<Snowflake className="w-4 h-4" />}
          label="H_T (Transmission)"
          value={formatHt(htTotal)}
          sub={`H_T′ ${htPrime.toFixed(2)} W/(m²·K)`}
        />
        <KpiCard
          icon={<Building2 className="w-4 h-4" />}
          label="KfW-Stufe"
          value={kfwTier ? `EH ${kfwTier}` : "—"}
          sub={kfwTier ? `H_T′ ≤ ${kfwTier === 40 ? "40 %" : "55 %"} Referenz` : "Keine Förderstufe erreicht"}
          tone={kfwTier === 40 ? "positive" : kfwTier === 55 ? "neutral" : undefined}
        />
      </div>

      {/* Envelope element breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Wärmedurchgang je Bauteil</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-neutral-500 border-b">
                  <th className="text-left py-1.5">Bauteil</th>
                  <th className="text-right py-1.5">Fläche</th>
                  <th className="text-right py-1.5">U</th>
                  <th className="text-right py-1.5">F_x</th>
                  <th className="text-right py-1.5">U·A·F_x</th>
                </tr>
              </thead>
              <tbody>
                {elements.map((el) => (
                  <tr key={el.kind} className="border-t border-neutral-100">
                    <td className="py-1.5">{ELEMENT_LABELS[el.kind]}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatArea(el.area)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatU(el.uValue)}</td>
                    <td className="py-1.5 text-right tabular-nums">{el.fx.toFixed(2)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {el.htContribution.toLocaleString("de-DE", { maximumFractionDigits: 0 })} W/K
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-neutral-900 bg-neutral-50">
                  <td className="py-2 font-bold">Σ H_T</td>
                  <td className="py-2 text-right font-bold tabular-nums">{formatArea(envelopeArea)}</td>
                  <td></td>
                  <td></td>
                  <td className="py-2 text-right font-bold tabular-nums">{formatHt(htTotal)}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-neutral-500 mt-3 leading-relaxed">
              F_x nach DIN V 4108-6: 1,0 für Außenluft, 0,8 für Dach zu unbeheiztem Spitzboden,
              0,5 für Bodenplatte gegen Erdreich.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Geometrie & Jahresbilanz</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <StatRow label="Beheizte Wohnfläche (NGF)" value={formatArea(ngfSqm)} />
              <StatRow label="Beheiztes Volumen V_e" value={`${heatedVolume.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m³`} />
              <StatRow label="Hüllfläche A" value={formatArea(envelopeArea)} />
              <StatRow
                label="A / V_e (Kompaktheit)"
                value={`${avRatio.toFixed(2)} 1/m`}
                hint={avRatio < 0.4 ? "sehr kompakt" : avRatio < 0.6 ? "kompakt" : "gestreckt"}
              />
              <div className="border-t my-2" />
              <StatRow
                label="Transmissionsverlust Q_T"
                value={`${estimate.qTransmission.toLocaleString("de-DE", { maximumFractionDigits: 0 })} kWh/a`}
              />
              <StatRow
                label="Lüftungsverlust Q_V"
                value={`${estimate.qVentilation.toLocaleString("de-DE", { maximumFractionDigits: 0 })} kWh/a`}
                hint="n=0,5 1/h"
              />
              <StatRow
                label="Interne & solare Gewinne"
                value={`−${(20 * ngfSqm).toLocaleString("de-DE", { maximumFractionDigits: 0 })} kWh/a`}
                hint="η·20 kWh/m²"
              />
              <div className="border-t my-2" />
              <StatRow
                label="Heizwärmebedarf Q_h"
                value={`${Math.round(qHeating).toLocaleString("de-DE")} kWh/a`}
                hint={formatKwhPerSqm(qHeatingPerSqm)}
                tone={qHeatingPerSqm <= 30 ? "positive" : qHeatingPerSqm <= 60 ? "neutral" : "negative"}
                bold
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-neutral-500 leading-relaxed">
        Vereinfachte Energiebilanz nach DIN V 4108-6 mit HGT = 3.500 K·d/a (84 kKh/a) und einer
        utilization factor-korrigierten Gewinnabschätzung (η·20 kWh/(m²·a)). Ersetzt keinen
        GEG-Nachweis in Hottgenroth/ZUB Helena; dient als Planungs-Indikator zur Abgrenzung der
        Dämmstufen gegenüber dem Referenzgebäude und KfW-Stufen 40/55.
      </p>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function KpiCard({
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
  tone?: "positive" | "negative" | "neutral";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "negative"
      ? "text-rose-700"
      : tone === "neutral"
      ? "text-amber-700"
      : "text-neutral-900";
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

function StatRow({
  label,
  value,
  hint,
  tone,
  bold,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "positive" | "negative" | "neutral";
  bold?: boolean;
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "negative"
      ? "text-rose-700"
      : tone === "neutral"
      ? "text-amber-700"
      : "text-neutral-900";
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-700">{label}</span>
      <span className={`tabular-nums ${bold ? "font-bold" : "font-semibold"} ${toneClass}`}>
        {value}
        {hint && <span className="ml-2 text-xs font-normal opacity-70">{hint}</span>}
      </span>
    </div>
  );
}
