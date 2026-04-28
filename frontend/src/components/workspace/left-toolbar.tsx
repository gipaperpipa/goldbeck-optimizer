"use client";

import { Icon, type IconName } from "./icon";

export type ToolId =
  | "cursor"
  | "move"
  | "rect"
  | "door"
  | "window"
  | "ruler"
  | "zoom";

interface Tool {
  id: ToolId | "layers" | "settings";
  label: string;
  shortcut: string;
  icon: IconName;
}

const TOOLS: Tool[] = [
  { id: "cursor", label: "Auswahl", shortcut: "V", icon: "cursor" },
  { id: "move", label: "Wand verschieben", shortcut: "W", icon: "move" },
  { id: "rect", label: "Raum", shortcut: "R", icon: "rect" },
  { id: "door", label: "Tür", shortcut: "T", icon: "door" },
  { id: "window", label: "Fenster", shortcut: "F", icon: "window" },
];

const EXTRAS: Tool[] = [
  { id: "ruler", label: "Messen", shortcut: "M", icon: "ruler" },
  { id: "zoom", label: "Zoom", shortcut: "Z", icon: "zoom" },
];

const PASSIVE: Tool[] = [
  { id: "layers", label: "Ebenen", shortcut: "L", icon: "layers" },
  { id: "settings", label: "Einstellungen", shortcut: ",", icon: "settings" },
];

function ToolBtn({
  tool,
  isActive,
  onClick,
}: {
  tool: Tool;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={`${tool.label} · ${tool.shortcut}`}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        background: isActive ? "var(--ws-ink)" : "transparent",
        color: isActive ? "white" : "var(--ws-ink-mid)",
        border: "none",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 3,
        position: "relative",
      }}
    >
      <Icon name={tool.icon} size={16} />
      <span
        className="ws-mono"
        style={{
          position: "absolute",
          right: 3,
          bottom: 1,
          fontSize: 8,
          color: isActive ? "oklch(0.75 0.005 85)" : "var(--ws-ink-dim)",
          opacity: 0.7,
        }}
      >
        {tool.shortcut}
      </span>
    </button>
  );
}

export function LeftToolbar({
  activeTool,
  setActiveTool,
  onOpenSettings,
  settingsActive,
}: {
  activeTool: ToolId;
  setActiveTool: (t: ToolId) => void;
  /** Called when the user clicks the Einstellungen button — wired by
   *  the workspace page to toggle the Tweaks panel (Phase 14c). */
  onOpenSettings?: () => void;
  /** Visual state for the Settings button while the panel is open. */
  settingsActive?: boolean;
}) {
  const renderTool = (t: Tool) => {
    if (t.id === "settings") {
      return (
        <ToolBtn
          key={t.id}
          tool={t}
          isActive={!!settingsActive}
          onClick={() => onOpenSettings?.()}
        />
      );
    }
    const interactive = t.id !== "layers";
    return (
      <ToolBtn
        key={t.id}
        tool={t}
        isActive={interactive && activeTool === t.id}
        onClick={() => interactive && setActiveTool(t.id as ToolId)}
      />
    );
  };

  return (
    <div
      style={{
        width: 44,
        flexShrink: 0,
        borderRight: "1px solid var(--ws-line)",
        background: "var(--ws-bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "8px 0",
        gap: 2,
      }}
    >
      {TOOLS.map(renderTool)}
      <div
        style={{
          width: 24,
          height: 1,
          background: "var(--ws-line)",
          margin: "6px 0",
        }}
      />
      {EXTRAS.map(renderTool)}
      <div style={{ flex: 1 }} />
      {PASSIVE.map(renderTool)}
    </div>
  );
}
