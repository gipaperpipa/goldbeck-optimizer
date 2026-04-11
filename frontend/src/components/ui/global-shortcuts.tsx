"use client";

import { useUndoShortcut } from "@/hooks/use-undo-shortcut";

/** Invisible component that registers global keyboard shortcuts. */
export function GlobalShortcuts() {
  useUndoShortcut();
  return null;
}
