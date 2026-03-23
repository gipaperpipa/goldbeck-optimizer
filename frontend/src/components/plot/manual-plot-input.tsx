"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePlotAnalysis } from "@/hooks/use-plot-analysis";

interface ManualPlotInputProps {
  onComplete: () => void;
}

export function ManualPlotInput({ onComplete }: ManualPlotInputProps) {
  const [address, setAddress] = useState("");
  const [width, setWidth] = useState("");
  const [depth, setDepth] = useState("");
  const { analyze, isLoading, error } = usePlotAnalysis();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await analyze({
        mode: "address",
        address: address || undefined,
        width_m: Number(width),
        depth_m: Number(depth),
      });
      onComplete();
    } catch {
      // error is set in hook
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="address">Address (optional, for regulation lookup)</Label>
        <Input
          id="address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="123 Main St, Denver, CO"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="width">Plot Width (m)</Label>
          <Input
            id="width"
            type="number"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            placeholder="200"
            required
          />
        </div>
        <div>
          <Label htmlFor="depth">Plot Depth (m)</Label>
          <Input
            id="depth"
            type="number"
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
            placeholder="300"
            required
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <Button type="submit" className="w-full" disabled={isLoading || !width || !depth}>
        {isLoading ? "Analyzing..." : "Analyze Plot"}
      </Button>
    </form>
  );
}
