"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { PlotAnalysis } from "@/types/api";

interface PlotSummaryProps {
  analysis: PlotAnalysis;
  onNext: () => void;
}

export function PlotSummary({ analysis, onNext }: PlotSummaryProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Plot Analysis</CardTitle>
          <Badge variant="success">Analyzed</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div>
            <p className="text-sm text-neutral-500">Area</p>
            <p className="text-lg font-semibold">
              {analysis.area_sqm.toLocaleString()} m²
            </p>
            <p className="text-xs text-neutral-400">
              {analysis.area_acres.toFixed(2)} acres
            </p>
          </div>
          <div>
            <p className="text-sm text-neutral-500">Width</p>
            <p className="text-lg font-semibold">{analysis.width_m.toFixed(1)} m</p>
          </div>
          <div>
            <p className="text-sm text-neutral-500">Depth</p>
            <p className="text-lg font-semibold">{analysis.depth_m.toFixed(1)} m</p>
          </div>
          <div>
            <p className="text-sm text-neutral-500">Perimeter</p>
            <p className="text-lg font-semibold">{analysis.perimeter_m.toFixed(1)} m</p>
          </div>
        </div>

        {analysis.address_resolved && (
          <p className="text-sm text-neutral-600 mb-4">
            Address: {analysis.address_resolved}
          </p>
        )}

        <Button onClick={onNext} className="w-full">
          Continue to Regulations
        </Button>
      </CardContent>
    </Card>
  );
}
