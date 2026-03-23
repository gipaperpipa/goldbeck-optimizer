"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useProjectStore } from "@/stores/project-store";
import { SitePlan2D } from "./site-plan-2d";
import type { LayoutOption } from "@/types/api";

export function LayoutComparison() {
  const { optimizationResult, plotAnalysis, selectedLayout, setSelectedLayout } = useProjectStore();

  if (!optimizationResult || !plotAnalysis) return null;
  const layouts = optimizationResult.layouts;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">
        Layout Options ({layouts.length} generated in {optimizationResult.elapsed_seconds?.toFixed(1)}s)
      </h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {layouts.map((layout) => (
          <LayoutCard
            key={layout.id}
            layout={layout}
            plot={plotAnalysis}
            isSelected={selectedLayout?.id === layout.id}
            onSelect={() => setSelectedLayout(layout)}
          />
        ))}
      </div>
    </div>
  );
}

function LayoutCard({
  layout,
  plot,
  isSelected,
  onSelect,
}: {
  layout: LayoutOption;
  plot: NonNullable<ReturnType<typeof useProjectStore.getState>["plotAnalysis"]>;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <Card className={isSelected ? "ring-2 ring-neutral-900" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Layout #{layout.rank}</CardTitle>
          <div className="flex gap-1">
            <Badge variant={layout.regulation_check.is_compliant ? "success" : "destructive"}>
              {layout.regulation_check.is_compliant ? "Compliant" : "Violations"}
            </Badge>
            <Badge variant="secondary">
              Score: {(layout.scores.overall * 100).toFixed(0)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <SitePlan2D layout={layout} plot={plot} width={350} height={280} />

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <span className="text-neutral-500">Units</span>
            <p className="font-semibold">{layout.total_units}</p>
          </div>
          <div>
            <span className="text-neutral-500">FAR</span>
            <p className="font-semibold">{layout.far_achieved.toFixed(2)}</p>
          </div>
          <div>
            <span className="text-neutral-500">Coverage</span>
            <p className="font-semibold">{layout.lot_coverage_pct.toFixed(1)}%</p>
          </div>
          <div>
            <span className="text-neutral-500">Buildings</span>
            <p className="font-semibold">{layout.buildings.length}</p>
          </div>
          <div>
            <span className="text-neutral-500">Open Space</span>
            <p className="font-semibold">{layout.open_space_pct.toFixed(1)}%</p>
          </div>
          <div>
            <span className="text-neutral-500">Parking</span>
            <p className="font-semibold">{layout.total_parking_spaces}</p>
          </div>
        </div>

        {/* Score bars */}
        <div className="space-y-1">
          {(["efficiency", "financial", "livability", "compliance"] as const).map((key) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-xs text-neutral-500 w-16 capitalize">{key}</span>
              <div className="flex-1 h-1.5 bg-neutral-100 rounded-full">
                <div
                  className="h-full bg-neutral-900 rounded-full"
                  style={{ width: `${Math.min(100, layout.scores[key] * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        <Button
          onClick={onSelect}
          variant={isSelected ? "default" : "outline"}
          className="w-full"
          size="sm"
        >
          {isSelected ? "Selected" : "Select Layout"}
        </Button>
      </CardContent>
    </Card>
  );
}
