"use client";

import type { ReactNode } from "react";

export type PillTone =
  | "neutral"
  | "accent"
  | "south"
  | "north"
  | "ok";

const TONES: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: "var(--ws-neutral-bg)", fg: "var(--ws-ink-mid)" },
  accent: { bg: "var(--ws-accent-bg)", fg: "oklch(0.35 0.12 220)" },
  south: { bg: "var(--ws-south)", fg: "var(--ws-south-fg)" },
  north: { bg: "var(--ws-north)", fg: "var(--ws-north-fg)" },
  ok: { bg: "var(--ws-ok-bg)", fg: "var(--ws-ok-fg)" },
};

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: PillTone;
}) {
  const t = TONES[tone];
  return (
    <span
      className="ws-mono"
      style={{
        fontSize: 10,
        fontWeight: 500,
        padding: "2px 6px",
        borderRadius: 3,
        background: t.bg,
        color: t.fg,
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
