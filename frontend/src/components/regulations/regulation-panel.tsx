"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useProjectStore } from "@/stores/project-store";
import { useRegulationLookup } from "@/hooks/use-regulation-lookup";
import type { RegulationSet } from "@/types/api";

const PRESETS: Record<string, Partial<RegulationSet>> = {
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
  "MX-1": {
    max_far: 2.0, max_height_m: 16.76, max_stories: 4,
    max_lot_coverage_pct: 70, min_open_space_pct: 15,
    setbacks: { front_m: 0, rear_m: 3.05, side_left_m: 0, side_right_m: 1.52 },
  },
};

const DEFAULT_REGS: RegulationSet = {
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
  const { plotAnalysis, regulations, setRegulations } = useProjectStore();
  const [regs, setRegs] = useState<RegulationSet>(regulations || DEFAULT_REGS);
  const { lookup, isLoading: aiLoading, confidence, notes } = useRegulationLookup();

  const updateField = (path: string, value: number | string) => {
    setRegs((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split(".");
      let obj = next;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      return next;
    });
  };

  const applyPreset = (type: string) => {
    const preset = PRESETS[type];
    if (preset) {
      setRegs((prev) => ({ ...prev, ...preset, zoning_type: type } as RegulationSet));
    }
  };

  const handleAILookup = async () => {
    if (!plotAnalysis?.address_resolved) return;
    const result = await lookup(plotAnalysis.address_resolved);
    if (result) {
      setRegs(result.regulations);
    }
  };

  const handleSave = () => {
    setRegulations(regs);
    onNext();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Zoning Regulations</CardTitle>
          <div className="flex items-center gap-2">
            {confidence !== null && (
              <Badge variant={confidence > 0.6 ? "success" : "warning"}>
                AI Confidence: {(confidence * 100).toFixed(0)}%
              </Badge>
            )}
            {plotAnalysis?.address_resolved && (
              <Button variant="outline" size="sm" onClick={handleAILookup} disabled={aiLoading}>
                {aiLoading ? "Looking up..." : "AI Lookup"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {notes.length > 0 && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
            <p className="text-sm font-medium text-yellow-800 mb-1">AI Notes:</p>
            {notes.map((note, i) => (
              <p key={i} className="text-xs text-yellow-700">{note}</p>
            ))}
          </div>
        )}

        {/* Zoning Preset */}
        <div>
          <Label>Zoning Preset</Label>
          <div className="flex gap-2 mt-1">
            {Object.keys(PRESETS).map((type) => (
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

        <Button onClick={handleSave} className="w-full">Save Regulations & Continue</Button>
      </CardContent>
    </Card>
  );
}
