"use client";

import { useEffect } from "react";
import { useProjectStore } from "@/stores/project-store";

/**
 * Global keyboard shortcut for undo (Ctrl+Z) and redo (Ctrl+Shift+Z / Ctrl+Y).
 * Ignores shortcuts when focus is inside form inputs.
 */
export function useUndoShortcut() {
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Don't intercept when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;

      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        redo();
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);
}
