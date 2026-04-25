"use client";

export function StatusBar({
  coords,
  generation,
  fitness,
  rhinoConnected,
  bayInfo,
  scale = "1:100",
}: {
  coords: string;
  generation?: number;
  fitness?: number;
  rhinoConnected?: boolean;
  bayInfo?: string;
  scale?: string;
}) {
  return (
    <footer
      className="ws-mono"
      style={{
        height: 26,
        flexShrink: 0,
        borderTop: "1px solid var(--ws-line)",
        background: "var(--ws-bg)",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 18,
        fontSize: 10.5,
        color: "var(--ws-ink-mid)",
        letterSpacing: "0.04em",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: rhinoConnected
              ? "oklch(0.6 0.12 150)"
              : "oklch(0.7 0.005 85)",
          }}
        />
        {rhinoConnected
          ? "Rhino verbunden · ws://localhost:8765"
          : "Rhino offline"}
      </span>
      <span>Grid: 62.5 cm · Goldbeck-Schottwand</span>
      {bayInfo && <span>Raster: {bayInfo}</span>}
      <div style={{ flex: 1 }} />
      <span>{coords}</span>
      <span>Maßstab {scale}</span>
      {generation !== undefined && fitness !== undefined && (
        <span style={{ color: "oklch(0.35 0.12 220)" }}>
          Gen {generation} · Fit {fitness.toFixed(3)}
        </span>
      )}
    </footer>
  );
}
