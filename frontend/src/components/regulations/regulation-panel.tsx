"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useProjectStore } from "@/stores/project-store";
import { useRegulationLookup } from "@/hooks/use-regulation-lookup";
import type { RegulationSet, GermanRegulationSet } from "@/types/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

// ============================================================
// International Presets (US-centric)
// ============================================================
const INTL_PRESETS: Record<string, Partial<RegulationSet>> = {
  "R-3": {
    max_far: 1.5, max_height_m: 13.72, max_stories: 3,
    max_lot_coverage_pct: 50, min_open_space_pct: 25,
    setbacks: { front_m: 6.10, rear_m: 4.57, side_left_m: 3.05, side_right_m: 3.05 },
  },
  "R-4": {
    max_far: 3.0, max_height_m: 22.86, max_stories: 6,
    max_lot_coverage_pct: 60, min_open_space_pct: 20,
    setbacks: { front_m: 4.57, rear_m: 4.57, side_left_m: 2.44, side_right_m: 2.44 },
  },
  "R-5": {
    max_far: 5.0, max_height_m: 36.58, max_stories: 10,
    max_lot_coverage_pct: 65, min_open_space_pct: 15,
    setbacks: { front_m: 3.05, rear_m: 3.05, side_left_m: 1.83, side_right_m: 1.83 },
  },
};

// ============================================================
// German Presets (BauNVO §17)
// ============================================================
const GERMAN_BAUGEBIET_LABELS: Record<string, string> = {
  WR: "Reines Wohngebiet",
  WA: "Allgemeines Wohngebiet",
  WB: "Besonderes Wohngebiet",
  MI: "Mischgebiet",
  MU: "Urbanes Gebiet",
  MK: "Kerngebiet",
};

const GERMAN_STATES = [
  "Baden-Württemberg", "Bayern", "Berlin", "Brandenburg", "Bremen",
  "Hamburg", "Hessen", "Mecklenburg-Vorpommern", "Niedersachsen",
  "Nordrhein-Westfalen", "Rheinland-Pfalz", "Saarland", "Sachsen",
  "Sachsen-Anhalt", "Schleswig-Holstein", "Thüringen",
];

const DEFAULT_INTL_REGS: RegulationSet = {
  zoning_type: "R-3",
  setbacks: { front_m: 6.10, rear_m: 4.57, side_left_m: 3.05, side_right_m: 3.05 },
  max_far: 1.5, max_height_m: 13.72, max_stories: 3,
  max_lot_coverage_pct: 50, min_open_space_pct: 25,
  parking: {
    studio_ratio: 1.0, one_bed_ratio: 1.0, two_bed_ratio: 1.5,
    three_bed_ratio: 2.0, commercial_ratio_per_1000sqm: 3.0, guest_ratio: 0.25,
  },
  min_unit_sizes: { studio_sqm: 37, one_bed_sqm: 56, two_bed_sqm: 79, three_bed_sqm: 102 },
  fire_access_width_m: 6.10, min_building_separation_m: 4.57,
  allow_commercial_ground_floor: false,
};

interface RegulationPanelProps {
  onNext: () => void;
}

export function RegulationPanel({ onNext }: RegulationPanelProps) {
  const {
    plotAnalysis, regulations, setRegulations,
    regulationMode, setRegulationMode,
    germanRegulations, setGermanRegulations,
  } = useProjectStore();
  const [intlRegs, setIntlRegs] = useState<RegulationSet>(regulations || DEFAULT_INTL_REGS);
  const { lookup, isLoading: aiLoading, confidence, notes } = useRegulationLookup();

  // German-specific state
  const [bundesland, setBundesland] = useState(germanRegulations?.bundesland || "Nordrhein-Westfalen");
  const [baugebiet, setBaugebiet] = useState(germanRegulations?.baugebiet_type || "WA");
  const [buildingHeight, setBuildingHeight] = useState(germanRegulations?.max_height_m || 12.0);
  const [numStories, setNumStories] = useState(germanRegulations?.max_stories || 4);
  const [isCoreArea, setIsCoreArea] = useState(false);
  const [nearTransit, setNearTransit] = useState(false);
  const [germanRegs, setGermanRegs] = useState<GermanRegulationSet | null>(germanRegulations);
  const [loading, setLoading] = useState(false);

  // Build German regulations from backend
  const buildGermanRegs = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/v1/regulations/german/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundesland,
          baugebiet,
          building_height_m: buildingHeight,
          num_stories: numStories,
          is_core_area: isCoreArea,
          near_transit: nearTransit,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setGermanRegs(data.german);
        // Also set the compatible regulation set for the optimizer
        setIntlRegs({ ...DEFAULT_INTL_REGS, ...data.compatible });
      }
    } catch (err) {
      console.error("Failed to build German regulations:", err);
    } finally {
      setLoading(false);
    }
  }, [bundesland, baugebiet, buildingHeight, numStories, isCoreArea, nearTransit]);

  // Auto-build when German params change
  useEffect(() => {
    if (regulationMode === "german") {
      buildGermanRegs();
    }
  }, [regulationMode, bundesland, baugebiet, buildingHeight, numStories, isCoreArea, nearTransit, buildGermanRegs]);

  const updateIntlField = (path: string, value: number | string) => {
    setIntlRegs((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split(".");
      let obj = next;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts[parts.length - 1]] = value;
      return next;
    });
  };

  const applyIntlPreset = (type: string) => {
    const preset = INTL_PRESETS[type];
    if (preset) {
      setIntlRegs((prev) => ({ ...prev, ...preset, zoning_type: type } as RegulationSet));
    }
  };

  const handleAILookup = async () => {
    if (!plotAnalysis?.address_resolved) return;
    const result = await lookup(plotAnalysis.address_resolved);
    if (result) setIntlRegs(result.regulations);
  };

  const handleSave = () => {
    if (regulationMode === "german" && germanRegs) {
      setGermanRegulations(germanRegs);
    }
    setRegulations(intlRegs);
    onNext();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Bauvorschriften / Regulations</CardTitle>
            <CardDescription className="mt-1">
              {regulationMode === "german"
                ? "Deutsche Bauvorschriften (BauNVO, LBO)"
                : "International zoning regulations"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {regulationMode === "international" && confidence !== null && (
              <Badge variant={confidence > 0.6 ? "success" : "warning"}>
                AI: {(confidence * 100).toFixed(0)}%
              </Badge>
            )}
          </div>
        </div>

        {/* Mode Toggle */}
        <div className="flex gap-1 mt-3 p-1 bg-muted rounded-lg w-fit">
          <Button
            variant={regulationMode === "german" ? "default" : "ghost"}
            size="sm"
            onClick={() => setRegulationMode("german")}
          >
            🇩🇪 Deutschland
          </Button>
          <Button
            variant={regulationMode === "international" ? "default" : "ghost"}
            size="sm"
            onClick={() => setRegulationMode("international")}
          >
            🌐 International
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {regulationMode === "german" ? (
          <GermanRegulationForm
            bundesland={bundesland}
            setBundesland={setBundesland}
            baugebiet={baugebiet}
            setBaugebiet={setBaugebiet}
            buildingHeight={buildingHeight}
            setBuildingHeight={setBuildingHeight}
            numStories={numStories}
            setNumStories={setNumStories}
            isCoreArea={isCoreArea}
            setIsCoreArea={setIsCoreArea}
            nearTransit={nearTransit}
            setNearTransit={setNearTransit}
            germanRegs={germanRegs}
            setGermanRegs={setGermanRegs}
            loading={loading}
          />
        ) : (
          <InternationalRegulationForm
            regs={intlRegs}
            updateField={updateIntlField}
            applyPreset={applyIntlPreset}
            plotAnalysis={plotAnalysis}
            handleAILookup={handleAILookup}
            aiLoading={aiLoading}
            notes={notes}
          />
        )}

        <Button onClick={handleSave} className="w-full" disabled={loading}>
          {regulationMode === "german" ? "Vorschriften speichern & weiter" : "Save Regulations & Continue"}
        </Button>
      </CardContent>
    </Card>
  );
}


// ============================================================
// German Regulation Form
// ============================================================

function GermanRegulationForm({
  bundesland, setBundesland,
  baugebiet, setBaugebiet,
  buildingHeight, setBuildingHeight,
  numStories, setNumStories,
  isCoreArea, setIsCoreArea,
  nearTransit, setNearTransit,
  germanRegs, setGermanRegs, loading,
}: {
  bundesland: string;
  setBundesland: (v: string) => void;
  baugebiet: string;
  setBaugebiet: (v: string) => void;
  buildingHeight: number;
  setBuildingHeight: (v: number) => void;
  numStories: number;
  setNumStories: (v: number) => void;
  isCoreArea: boolean;
  setIsCoreArea: (v: boolean) => void;
  nearTransit: boolean;
  setNearTransit: (v: boolean) => void;
  germanRegs: GermanRegulationSet | null;
  setGermanRegs: (regs: GermanRegulationSet | null) => void;
  loading: boolean;
}) {
  // Helper to update a single field in germanRegs
  const updateGermanField = (field: string, value: number | boolean) => {
    if (!germanRegs) return;
    setGermanRegs({ ...germanRegs, [field]: value });
  };
  return (
    <div className="space-y-5">
      {/* Bundesland & Baugebiet */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs font-medium">Bundesland</Label>
          <select
            className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={bundesland}
            onChange={(e) => setBundesland(e.target.value)}
          >
            {GERMAN_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs font-medium">Baugebiet (BauNVO)</Label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {Object.entries(GERMAN_BAUGEBIET_LABELS).map(([key, label]) => (
              <Button
                key={key}
                variant={baugebiet === key ? "default" : "outline"}
                size="sm"
                className="text-xs px-2 py-1 h-7"
                onClick={() => setBaugebiet(key)}
                title={label}
              >
                {key}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Building Parameters */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs font-medium">Geschosszahl</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={numStories}
            onChange={(e) => setNumStories(Number(e.target.value))}
          />
        </div>
        <div>
          <Label className="text-xs font-medium">Gebäudehöhe (m)</Label>
          <Input
            type="number"
            step="0.5"
            value={buildingHeight}
            onChange={(e) => setBuildingHeight(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Checkboxes */}
      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={isCoreArea}
            onChange={(e) => setIsCoreArea(e.target.checked)}
            className="rounded"
          />
          Innenstadtlage (reduzierte Abstandsflächen)
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={nearTransit}
            onChange={(e) => setNearTransit(e.target.checked)}
            className="rounded"
          />
          ÖPNV-Anbindung (Stellplatz-Reduktion)
        </label>
      </div>

      {/* Computed Results */}
      {loading && (
        <div className="text-sm text-muted-foreground animate-pulse">
          Berechne Vorschriften...
        </div>
      )}

      {germanRegs && !loading && (
        <div className="space-y-4">
          {/* Density & Coverage — EDITABLE */}
          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-semibold">
              Maß der baulichen Nutzung
              <span className="text-xs font-normal text-muted-foreground ml-2">
                Obergrenzen nach BauNVO §17 — vom B-Plan abweichende Werte hier eintragen
              </span>
            </h3>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">GRZ</Label>
                <Input
                  type="number" step="0.05" min="0.1" max="1.0"
                  className="h-9 text-lg font-semibold"
                  value={germanRegs.grz}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    updateGermanField("grz", v);
                    updateGermanField("max_lot_coverage_pct", v * 100);
                    updateGermanField("min_open_space_pct", (1 - v) * 100);
                  }}
                />
                <div className="text-xs text-muted-foreground">= {germanRegs.max_lot_coverage_pct.toFixed(0)}% Überbauung</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">GFZ</Label>
                <Input
                  type="number" step="0.1" min="0.1" max="5.0"
                  className="h-9 text-lg font-semibold"
                  value={germanRegs.gfz}
                  onChange={(e) => updateGermanField("gfz", Number(e.target.value))}
                />
                <div className="text-xs text-muted-foreground">max. Geschossfl.</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Vollgeschosse</Label>
                <Input
                  type="number" step="1" min="1" max="10"
                  className="h-9 text-lg font-semibold"
                  value={germanRegs.max_stories}
                  onChange={(e) => updateGermanField("max_stories", Number(e.target.value))}
                />
                <div className="text-xs text-muted-foreground">{germanRegs.staffelgeschoss_exempt ? "+ Staffelgesch." : ""}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Max. Höhe (m)</Label>
                <Input
                  type="number" step="0.5" min="3" max="100"
                  className="h-9 text-lg font-semibold"
                  value={germanRegs.max_height_m}
                  onChange={(e) => updateGermanField("max_height_m", Number(e.target.value))}
                />
                <div className="text-xs text-muted-foreground">GK {germanRegs.gebaeudeklasse}</div>
              </div>
            </div>
          </div>

          {/* Abstandsflächen */}
          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-semibold">Abstandsflächen ({germanRegs.bundesland})</h3>
            <div className="grid grid-cols-4 gap-3">
              <MetricCard label="Faktor" value={`${germanRegs.setbacks.factor}×H`} sub={isCoreArea ? `Kern: ${germanRegs.setbacks.factor_core}×H` : ""} />
              <MetricCard label="Minimum" value={`${germanRegs.setbacks.min_m}m`} sub="Mindestabstand" />
              <MetricCard label="Berechnet" value={`${germanRegs.setbacks.front_m.toFixed(1)}m`} sub="je Seite" />
              <MetricCard label="Gebäudeabst." value={`${germanRegs.min_building_separation_m.toFixed(1)}m`} sub="zwischen Gebäuden" />
            </div>
          </div>

          {/* Parking & Fire */}
          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-semibold">Stellplätze & Brandschutz</h3>
            <div className="grid grid-cols-4 gap-3">
              <MetricCard
                label="Kfz-Stellpl."
                value={`${germanRegs.parking.spaces_per_unit.toFixed(1)}/WE`}
                sub={germanRegs.parking.near_transit_reduction_pct > 0
                  ? `−${germanRegs.parking.near_transit_reduction_pct}% ÖPNV`
                  : ""}
              />
              <MetricCard label="Fahrradstellpl." value={`${germanRegs.parking.bicycle_spaces_per_unit}/WE`} sub="" />
              <MetricCard label="Fluchtweg" value={`${germanRegs.max_escape_distance_m}m`} sub="max. Entfernung" />
              <MetricCard
                label="Treppenhaus"
                value={`≥${germanRegs.min_staircase_width_m.toFixed(2)}m`}
                sub={germanRegs.second_staircase_required ? "2. TH erforderl." : ""}
              />
            </div>
          </div>

          {/* Vollgeschoss Info */}
          <div className="text-xs text-muted-foreground px-1">
            Vollgeschoss-Definition ({germanRegs.bundesland}): Raumhöhe ≥{germanRegs.vollgeschoss_min_height_m}m
            über ≥{(germanRegs.vollgeschoss_area_fraction * 100).toFixed(0)}% der Geschossfläche.
            {germanRegs.staffelgeschoss_exempt && " Staffelgeschoss ist von Vollgeschoss-Zählung befreit."}
          </div>
        </div>
      )}
    </div>
  );
}


// ============================================================
// Metric Display Card
// ============================================================

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold leading-tight">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}


// ============================================================
// International Regulation Form (original)
// ============================================================

function InternationalRegulationForm({
  regs, updateField, applyPreset,
  plotAnalysis, handleAILookup, aiLoading, notes,
}: {
  regs: RegulationSet;
  updateField: (path: string, value: number | string) => void;
  applyPreset: (type: string) => void;
  plotAnalysis: any;
  handleAILookup: () => void;
  aiLoading: boolean;
  notes: string[];
}) {
  return (
    <div className="space-y-5">
      {notes.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
          <p className="text-sm font-medium text-yellow-800 mb-1">AI Notes:</p>
          {notes.map((note, i) => (
            <p key={i} className="text-xs text-yellow-700">{note}</p>
          ))}
        </div>
      )}

      {/* Zoning Preset + AI Lookup */}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Label>Zoning Preset</Label>
          <div className="flex gap-2 mt-1">
            {Object.keys(INTL_PRESETS).map((type) => (
              <Button
                key={type}
                variant={regs.zoning_type === type ? "default" : "outline"}
                size="sm"
                onClick={() => applyPreset(type)}
              >
                {type}
              </Button>
            ))}
          </div>
        </div>
        {plotAnalysis?.address_resolved && (
          <Button variant="outline" size="sm" onClick={handleAILookup} disabled={aiLoading}>
            {aiLoading ? "Looking up..." : "AI Lookup"}
          </Button>
        )}
      </div>

      {/* Setbacks */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Setbacks (m)</h3>
        <div className="grid grid-cols-4 gap-3">
          {(["front_m", "rear_m", "side_left_m", "side_right_m"] as const).map((key) => (
            <div key={key}>
              <Label className="text-xs">{key.replace(/_m$/, "").replace(/_/g, " ")}</Label>
              <Input
                type="number"
                value={regs.setbacks[key]}
                onChange={(e) => updateField(`setbacks.${key}`, Number(e.target.value))}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Bulk & Density */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Bulk & Density</h3>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Max FAR</Label>
            <Input type="number" step="0.1" value={regs.max_far}
              onChange={(e) => updateField("max_far", Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Max Height (m)</Label>
            <Input type="number" value={regs.max_height_m}
              onChange={(e) => updateField("max_height_m", Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Max Stories</Label>
            <Input type="number" value={regs.max_stories}
              onChange={(e) => updateField("max_stories", Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Max Lot Coverage %</Label>
            <Input type="number" value={regs.max_lot_coverage_pct}
              onChange={(e) => updateField("max_lot_coverage_pct", Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Min Open Space %</Label>
            <Input type="number" value={regs.min_open_space_pct}
              onChange={(e) => updateField("min_open_space_pct", Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Fire Access (m)</Label>
            <Input type="number" value={regs.fire_access_width_m}
              onChange={(e) => updateField("fire_access_width_m", Number(e.target.value))} />
          </div>
        </div>
      </div>

      {/* Parking */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Parking (spaces per unit)</h3>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Studio</Label>
            <Input type="number" step="0.25" value={regs.parking.studio_ratio}
              onChange={(e) => updateField("parking.studio_ratio", Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">1 BR</Label>
            <Input type="number" step="0.25" value={regs.parking.one_bed_ratio}
              onChange={(e) => updateField("parking.one_bed_ratio", Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">2 BR</Label>
            <Input type="number" step="0.25" value={regs.parking.two_bed_ratio}
              onChange={(e) => updateField("parking.two_bed_ratio", Number(e.target.value))} />
          </div>
        </div>
      </div>
    </div>
  );
}
