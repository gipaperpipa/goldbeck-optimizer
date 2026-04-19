"use client";

import Link from "next/link";
import { Building2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LayoutComparison } from "@/components/optimization/layout-comparison";
import { Scene3D } from "@/components/three/scene";
import { ShadowAnalysisPanel } from "@/components/shadow/shadow-analysis-panel";
import { FinancialDashboard } from "@/components/financial/financial-dashboard";
import { CostPanel } from "@/components/floorplan/cost-panel";
import { useProjectStore } from "@/stores/project-store";

export default function ResultsPage() {
  const { activeTab, setActiveTab, selectedLayout, plotAnalysis, optimizationResult, floorPlans } = useProjectStore();

  if (!optimizationResult) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-neutral-500 mb-4">No optimization results yet.</p>
          <Link href="/project/new">
            <Button>Start New Project</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b bg-white shrink-0">
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/project/new">
              <Button variant="ghost" size="icon"><ChevronLeft className="w-5 h-5" /></Button>
            </Link>
            <Building2 className="w-5 h-5" />
            <span className="font-bold">Project Results</span>
            <span className="text-sm text-neutral-500">
              {optimizationResult.layouts.length} layouts | {optimizationResult.elapsed_seconds?.toFixed(1)}s
            </span>
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 max-w-[1600px] mx-auto w-full px-6 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="layouts">Layouts</TabsTrigger>
            <TabsTrigger value="3d-view">3D View</TabsTrigger>
            <TabsTrigger value="shadow">Shadow Analysis</TabsTrigger>
            <TabsTrigger value="costs">Baukosten</TabsTrigger>
            <TabsTrigger value="financial">Financial</TabsTrigger>
          </TabsList>

          <TabsContent value="layouts">
            <LayoutComparison />
          </TabsContent>

          <TabsContent value="3d-view">
            <Scene3D layout={selectedLayout} plot={plotAnalysis} floorPlansMap={floorPlans} />
            {!selectedLayout && (
              <p className="text-center text-neutral-500 mt-4">
                Select a layout from the Layouts tab first
              </p>
            )}
          </TabsContent>

          <TabsContent value="shadow">
            <ShadowAnalysisPanel />
          </TabsContent>

          <TabsContent value="costs">
            <CostPanel />
          </TabsContent>

          <TabsContent value="financial">
            <FinancialDashboard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
