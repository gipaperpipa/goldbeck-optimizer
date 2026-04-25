"use client";

import Link from "next/link";
import { Icon } from "./icon";

export type WorkspaceMode = "architect" | "presentation" | "technical";

const MODE_OPTIONS: { value: WorkspaceMode; label: string }[] = [
  { value: "architect", label: "Architekt" },
  { value: "presentation", label: "Präsentation" },
  { value: "technical", label: "Technisch" },
];

export function TopBar({
  mode,
  setMode,
  projectLabel,
  layoutLabel,
  onUndo,
  onRedo,
  onExportIfc,
  onSendRhino,
}: {
  mode: WorkspaceMode;
  setMode: (m: WorkspaceMode) => void;
  projectLabel?: string;
  layoutLabel?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  onExportIfc?: () => void;
  onSendRhino?: () => void;
}) {
  return (
    <header
      style={{
        height: 48,
        flexShrink: 0,
        borderBottom: "1px solid var(--ws-line)",
        background: "var(--ws-bg)",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 16,
      }}
    >
      {/* Logo + breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <Link
          href="/"
          style={{
            width: 28,
            height: 28,
            background: "var(--ws-ink)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.02em",
            textDecoration: "none",
            borderRadius: 3,
          }}
          className="ws-mono"
        >
          GB
        </Link>
        <div
          className="ws-mono"
          style={{
            fontSize: 12,
            color: "var(--ws-ink-dim)",
            letterSpacing: "0.08em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <Link
            href="/"
            style={{ color: "var(--ws-ink-dim)", textDecoration: "none" }}
          >
            PROJEKTE
          </Link>
          <span style={{ margin: "0 8px", opacity: 0.4 }}>/</span>
          <span style={{ color: "var(--ws-ink)" }}>
            {projectLabel ?? "AKTUELLES PROJEKT"}
          </span>
          {layoutLabel && (
            <>
              <span style={{ margin: "0 8px", opacity: 0.4 }}>/</span>
              <span style={{ color: "oklch(0.35 0.12 220)" }}>{layoutLabel}</span>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Mode segmented */}
      <div
        style={{
          display: "flex",
          background: "var(--ws-neutral-bg)",
          padding: 2,
          borderRadius: 3,
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        {MODE_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            style={{
              padding: "5px 12px",
              background: mode === value ? "white" : "transparent",
              border: "none",
              color: mode === value ? "var(--ws-ink)" : "var(--ws-ink-dim)",
              cursor: "pointer",
              borderRadius: 2,
              fontFamily: "inherit",
              fontSize: "inherit",
              fontWeight: "inherit",
              letterSpacing: "0.01em",
              boxShadow:
                mode === value ? "0 1px 2px oklch(0.18 0.01 60 / 0.08)" : "none",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Undo / Redo */}
      <div style={{ display: "flex", gap: 2 }}>
        <button
          type="button"
          title="Rückgängig"
          onClick={onUndo}
          disabled={!onUndo}
          style={iconBtnStyle(!!onUndo)}
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          title="Wiederholen"
          onClick={onRedo}
          disabled={!onRedo}
          style={iconBtnStyle(!!onRedo)}
        >
          <Icon name="redo" />
        </button>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          onClick={onExportIfc}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            background: "transparent",
            border: "1px solid var(--ws-line-strong)",
            color: "var(--ws-ink-mid)",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            borderRadius: 3,
            fontFamily: "inherit",
          }}
        >
          <Icon name="download" size={13} /> IFC Export
        </button>
        <button
          type="button"
          onClick={onSendRhino}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            background: "var(--ws-ink)",
            border: "1px solid var(--ws-ink)",
            color: "white",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            borderRadius: 3,
            fontFamily: "inherit",
          }}
        >
          An Rhino senden
        </button>
      </div>
    </header>
  );
}

function iconBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    cursor: enabled ? "pointer" : "not-allowed",
    color: enabled ? "var(--ws-ink-mid)" : "oklch(0.75 0.005 85)",
    borderRadius: 3,
  };
}
