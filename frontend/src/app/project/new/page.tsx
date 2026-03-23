"use client";

import { useState } from "react";
import Link from "next/link";
import { Building2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PlotInputStep } from "@/components/plot/plot-input-step";
import { RegulationPanel } from "@/components/regulations/regulation-panel";
import { OptimizationPreferences } from "@/components/optimization/optimization-preferences";
import { LayoutComparison } from "@/components/optimization/layout-comparison";
import { Scene3D } from "@/components/three/scene";
import { ShadowAnalysisPanel } from "@/components/shadow/shadow-analysis-panel";
import { FinancialDashboard } from "@/components/financial/financial-dashboard";
import { FloorPlanPanel } from "@/components/floorplan/floor-plan-panel";
import { useProjectStore } from "@/stores/project-store";

const STEPS = [
  { id: 0, label: "Plot Input" },
  { id: 1, label: "Regulations" },
  { id: 2, label: "Optimize" },
  { id: 3, label: "Results" },
];

export default function NewProjectPage() {
  const [step, setStep] = useState(0);
  const [resultsTab, setResultsTab] = useState("layouts");
  const { plotAnalysis, regulations, optimizationResult, selectedLayout, floorPlans } = useProjectStore();

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon"><ChevronLeft className="w-5 h-5" /></Button>
          </Link>
          <Building2 className="w-5 h-5" />
          <span className="font-bold">{step < 3 ? "New Project" : "Project Results"}</span>
          {step === 3 && optimizationResult && (
            <span className="text-sm text-neutral-500">
              {optimizationResult.layouts.length} layouts | {optimizationResult.elapsed_seconds?.toFixed(1)}s
            </span>
          )}
        </div>
      </header>

      {/* Step indicators */}
      <div className={`${step < 3 ? "max-w-4xl" : "max-w-[1600px]"} mx-auto px-6 py-6`}>
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (s.id <= step) setStep(s.id);
                }}
                disabled={s.id > step}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  s.id === step
                    ? "bg-neutral-900 text-white"
                    : s.id < step
                    ? "bg-green-100 text-green-800 hover:bg-green-200 cursor-pointer"
                    : "bg-neutral-100 text-neutral-400"
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-xs">
                  {s.id < step ? "\u2713" : s.id + 1}
                </span>
                {s.label}
              </button>
              {s.id < STEPS.length - 1 && (
                <div className={`w-8 h-0.5 ${s.id < step ? "bg-green-300" : "bg-neutral-200"}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        {step === 0 && (
          <PlotInputStep onNext={() => setStep(1)} />
        )}

        {step === 1 && plotAnalysis && (
          <RegulationPanel onNext={() => setStep(2)} />
        )}

        {step === 2 && plotAnalysis && regulations && (
          <div className="space-y-6">
            <OptimizationPreferences
              onComplete={() => setStep(3)}
            />
          </div>
        )}

        {step === 3 && optimizationResult && (
          <Tabs value={resultsTab} onValueChange={setResultsTab}>
            <TabsList className="mb-6">
              <TabsTrigger value="layouts">Layouts</TabsTrigger>
              <TabsTrigger value="3d-view">3D View</TabsTrigger>
              <TabsTrigger value="shadow">Shadow Analysis</TabsTrigger>
              <TabsTrigger value="financial">Financial</TabsTrigger>
              <TabsTrigger value="floor-plans">Floor Plans</TabsTrigger>
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

            <TabsContent value="financial">
              <FinancialDashboard />
            </TabsContent>

            <TabsContent value="floor-plans">
              <FloorPlanPanel />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
