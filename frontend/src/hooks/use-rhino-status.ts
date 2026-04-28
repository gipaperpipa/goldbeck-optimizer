"use client";

/**
 * `useRhinoStatus` (Phase 14d) — light polling of the backend's
 * `/v1/rhino/status` endpoint so the workspace StatusBar can show
 * whether any Grasshopper / Rhino client is currently subscribed to
 * the live-sync WebSocket.
 *
 * Default cadence is 5 s — fast enough that the dot flips within a
 * couple of seconds of GH connecting, slow enough that we don't pile
 * pressure on the dev server. Errors are swallowed (`connected:
 * false`) so a backend hiccup just shows the dot offline.
 */

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/api-client";

export interface RhinoStatus {
  connected: boolean;
  clientCount: number;
}

export function useRhinoStatus(intervalMs = 5000): RhinoStatus {
  const [status, setStatus] = useState<RhinoStatus>({
    connected: false,
    clientCount: 0,
  });
  // Track the latest fetch in a ref so a stale resolve doesn't race a
  // newer one — only the most recent answer wins.
  const reqId = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const id = ++reqId.current;
      try {
        const res = await fetch(`${API_BASE}/v1/rhino/status`, {
          // Don't cache — we want live state.
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { connected: boolean; client_count: number } = await res.json();
        if (cancelled || id !== reqId.current) return;
        setStatus({
          connected: !!data.connected,
          clientCount: data.client_count ?? 0,
        });
      } catch {
        if (cancelled || id !== reqId.current) return;
        setStatus({ connected: false, clientCount: 0 });
      }
    };

    void tick();
    const handle = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [intervalMs]);

  return status;
}
