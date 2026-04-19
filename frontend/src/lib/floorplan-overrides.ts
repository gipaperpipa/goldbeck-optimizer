/**
 * Client for the backend floor-plan-override endpoints (Phase 3.7c).
 *
 * All calls are fire-and-forget tolerant: the caller should catch + log
 * errors so transient network failures never break the editing UX. The
 * Zustand localStorage cache remains the primary source of truth while
 * the user is editing; this module just mirrors commits to the server
 * so they survive cross-device use and browser storage wipes.
 */

import { apiClient } from "./api-client";
import type { FloorPlan } from "@/types/api";

const BASE = "/floorplan/overrides";

export interface OverrideSummary {
  building_id: string;
  floor_index: number;
  original_fingerprint: string;
  saved_at: string;
}

export interface OverrideOut {
  building_id: string;
  floor_index: number;
  original_fingerprint: string;
  plan: FloorPlan;
  saved_at: string;
  created_at: string;
}

export interface OverrideIn {
  original_fingerprint: string;
  plan: FloorPlan;
}

function encodeKey(buildingId: string, floorIndex: number): string {
  return `${encodeURIComponent(buildingId)}/${floorIndex}`;
}

/** List every stored override (summary only — no plan bodies). */
export async function listOverrides(): Promise<OverrideSummary[]> {
  return apiClient.get<OverrideSummary[]>(BASE);
}

/**
 * Fetch one override. Returns `null` on 404 (no stored override yet) so
 * callers can treat "no override" as a normal, quiet state. Any other
 * failure still throws.
 */
export async function fetchOverride(
  buildingId: string,
  floorIndex: number,
): Promise<OverrideOut | null> {
  try {
    return await apiClient.get<OverrideOut>(`${BASE}/${encodeKey(buildingId, floorIndex)}`);
  } catch (err) {
    if (err instanceof Error && /\b(not found|404)\b/i.test(err.message)) {
      return null;
    }
    throw err;
  }
}

/** Upsert an override. Called after each committed edit. */
export async function putOverride(
  buildingId: string,
  floorIndex: number,
  payload: OverrideIn,
): Promise<OverrideOut> {
  return apiClient.put<OverrideOut>(
    `${BASE}/${encodeKey(buildingId, floorIndex)}`,
    payload,
  );
}

/** Delete an override. Idempotent. Called on Reset. */
export async function deleteOverride(
  buildingId: string,
  floorIndex: number,
): Promise<{ deleted: boolean }> {
  return apiClient.delete<{ deleted: boolean }>(
    `${BASE}/${encodeKey(buildingId, floorIndex)}`,
  );
}
