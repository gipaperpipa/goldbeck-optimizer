"use client";

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, MapPin, BarChart3, Sun } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="w-6 h-6" />
            <span className="font-bold text-lg">Land Layout Optimizer</span>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="max-w-7xl mx-auto px-6 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold mb-4">
            Optimize Your Building Layouts
          </h1>
          <p className="text-lg text-neutral-600 max-w-2xl mx-auto">
            Analyze land plots, configure zoning regulations, and generate
            optimal residential apartment building layouts using AI-powered
            optimization.
          </p>
          <Link href="/project/new">
            <Button size="lg" className="mt-6">
              Start New Project
            </Button>
          </Link>
        </div>

        {/* Feature cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <FeatureCard
            icon={<MapPin className="w-8 h-8 text-blue-500" />}
            title="Plot Analysis"
            description="Draw on a map or enter dimensions manually. Get instant area, perimeter, and boundary analysis."
          />
          <FeatureCard
            icon={<Building2 className="w-8 h-8 text-green-500" />}
            title="Layout Optimization"
            description="Genetic algorithm generates optimal building placements respecting all zoning regulations."
          />
          <FeatureCard
            icon={<Sun className="w-8 h-8 text-yellow-500" />}
            title="Shadow Analysis"
            description="Simulate sun position throughout the day. Analyze shadow patterns and sunlight exposure."
          />
          <FeatureCard
            icon={<BarChart3 className="w-8 h-8 text-purple-500" />}
            title="Financial Pro Forma"
            description="Full development cost analysis, revenue projections, ROI, cap rate, and 10-year cashflow."
          />
        </div>
      </main>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        {icon}
        <CardTitle className="mt-2">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <CardDescription>{description}</CardDescription>
      </CardContent>
    </Card>
  );
}
