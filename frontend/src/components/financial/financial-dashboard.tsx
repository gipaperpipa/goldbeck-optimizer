"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProjectStore } from "@/stores/project-store";
import { useFinancialAnalysis } from "@/hooks/use-financial-analysis";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from "recharts";

export function FinancialDashboard() {
  const { selectedLayout, plotAnalysis, financialAnalysis } = useProjectStore();
  const { analyze, isLoading } = useFinancialAnalysis();
  const [landCost, setLandCost] = useState("2000000");

  const handleAnalyze = async () => {
    if (!selectedLayout || !plotAnalysis) return;
    await analyze({
      layout: selectedLayout,
      plot_area_sqm: plotAnalysis.area_sqm,
      land_cost: Number(landCost),
    });
  };

  if (!selectedLayout) {
    return (
      <div className="text-center text-neutral-500 py-10">
        Select a layout first to run financial analysis
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <Label>Land Acquisition Cost ($)</Label>
              <Input
                type="number"
                value={landCost}
                onChange={(e) => setLandCost(e.target.value)}
                placeholder="2,000,000"
              />
            </div>
            <Button onClick={handleAnalyze} disabled={isLoading}>
              {isLoading ? "Analyzing..." : "Run Financial Analysis"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {financialAnalysis && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KPICard
              label="Total Dev Cost"
              value={`$${(financialAnalysis.total_development_cost / 1_000_000).toFixed(1)}M`}
            />
            <KPICard
              label="Annual NOI"
              value={`$${(financialAnalysis.annual_noi / 1_000).toFixed(0)}K`}
            />
            <KPICard
              label="Cap Rate"
              value={`${(financialAnalysis.cap_rate * 100).toFixed(2)}%`}
            />
            <KPICard
              label="ROI"
              value={`${financialAnalysis.roi_pct.toFixed(1)}%`}
            />
            <KPICard
              label="Cash-on-Cash"
              value={`${financialAnalysis.cash_on_cash_return_pct.toFixed(1)}%`}
            />
            <KPICard
              label="Yield on Cost"
              value={`${financialAnalysis.yield_on_cost_pct.toFixed(2)}%`}
            />
            <KPICard
              label="Dev Spread"
              value={`${financialAnalysis.development_spread_bps.toFixed(0)} bps`}
            />
            <KPICard
              label="Profit Margin"
              value={`${financialAnalysis.profit_margin_pct.toFixed(1)}%`}
            />
          </div>

          {/* Cost Breakdown Chart */}
          <Card>
            <CardHeader><CardTitle>Cost Breakdown</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={[
                  { name: "Land", value: financialAnalysis.cost_breakdown.land_cost },
                  { name: "Residential", value: financialAnalysis.cost_breakdown.hard_costs_residential },
                  { name: "Parking", value: financialAnalysis.cost_breakdown.hard_costs_parking },
                  { name: "Sitework", value: financialAnalysis.cost_breakdown.hard_costs_sitework },
                  { name: "Soft Costs", value: financialAnalysis.cost_breakdown.total_soft_costs },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis tickFormatter={(v) => `$${(v / 1_000_000).toFixed(1)}M`} />
                  <Tooltip formatter={(v) => `$${Number(v).toLocaleString()}`} />
                  <Bar dataKey="value" fill="#171717" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Cashflow Projection */}
          <Card>
            <CardHeader><CardTitle>10-Year Cashflow Projection</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={financialAnalysis.annual_cashflow_projection}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="year" />
                  <YAxis tickFormatter={(v) => `$${(v / 1_000).toFixed(0)}K`} />
                  <Tooltip formatter={(v) => `$${Number(v).toLocaleString()}`} />
                  <Legend />
                  <Line type="monotone" dataKey="noi" stroke="#10b981" name="NOI" strokeWidth={2} />
                  <Line type="monotone" dataKey="cashflow" stroke="#3b82f6" name="Cashflow" strokeWidth={2} />
                  <Line type="monotone" dataKey="cumulative_cashflow" stroke="#8b5cf6" name="Cumulative" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function KPICard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs text-neutral-500">{label}</p>
        <p className="text-xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}
