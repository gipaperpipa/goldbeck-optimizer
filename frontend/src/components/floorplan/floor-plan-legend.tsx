"use client";

const ROOM_COLORS: Record<string, { color: string; label: string }> = {
  living: { color: "#dbeafe", label: "Living Room" },
  bedroom: { color: "#fef3c7", label: "Bedroom" },
  kitchen: { color: "#d1fae5", label: "Kitchen" },
  bathroom: { color: "#ede9fe", label: "Bathroom" },
  hallway: { color: "#f1f5f9", label: "Hallway" },
  storage: { color: "#fce7f3", label: "Storage" },
  corridor: { color: "#f8fafc", label: "Corridor" },
  staircase: { color: "#fee2e2", label: "Staircase" },
  elevator: { color: "#fef9c3", label: "Elevator" },
};

const WALL_STYLES: { label: string; color: string; width: number }[] = [
  { label: "Bearing Wall (21cm)", color: "#1e293b", width: 3 },
  { label: "Outer Wall (14cm)", color: "#475569", width: 2 },
  { label: "Partition (10cm)", color: "#94a3b8", width: 1 },
];

export function FloorPlanLegend() {
  return (
    <div className="bg-white border rounded-lg p-4 space-y-3">
      <h4 className="font-semibold text-sm text-neutral-700">Legend</h4>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-neutral-500 uppercase">Rooms</p>
        <div className="grid grid-cols-3 gap-1.5">
          {Object.entries(ROOM_COLORS).map(([key, { color, label }]) => (
            <div key={key} className="flex items-center gap-1.5">
              <div
                className="w-3 h-3 rounded-sm border border-neutral-300"
                style={{ backgroundColor: color }}
              />
              <span className="text-xs text-neutral-600">{label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-neutral-500 uppercase">Walls</p>
        <div className="space-y-1">
          {WALL_STYLES.map((w) => (
            <div key={w.label} className="flex items-center gap-2">
              <div className="w-6 flex items-center">
                <div
                  className="w-full rounded"
                  style={{ height: w.width, backgroundColor: w.color }}
                />
              </div>
              <span className="text-xs text-neutral-600">{w.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-neutral-500 uppercase">Elements</p>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-400" />
          <span className="text-xs text-neutral-600">Window</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-1 bg-amber-600 rounded" />
          <span className="text-xs text-neutral-600">Door</span>
        </div>
      </div>
    </div>
  );
}
