"use client";

import { useState, useCallback, useEffect } from "react";
import { apiClient, API_BASE } from "@/lib/api-client";
import type {
  ProjectInfo,
  TimelineEntryInfo,
  ContactInfo,
  DbStats,
} from "@/types/api";

export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DbStats | null>(null);

  const loadProjects = useCallback(async (status?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const url = status
        ? `/projects?status=${encodeURIComponent(status)}`
        : "/projects";
      const result = await apiClient.get<ProjectInfo[]>(url);
      setProjects(result);
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load projects";
      setError(msg);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createProject = useCallback(
    async (data: {
      name: string;
      description?: string;
      address?: string;
      parcel_ids?: string[];
    }) => {
      setError(null);
      try {
        const result = await apiClient.post<ProjectInfo>("/projects", data);
        setProjects((prev) => [result, ...prev]);
        return result;
      } catch (e: unknown) {
        const msg =
          e instanceof Error ? e.message : "Failed to create project";
        setError(msg);
        return null;
      }
    },
    []
  );

  const updateProject = useCallback(
    async (projectId: string, data: Partial<ProjectInfo>) => {
      setError(null);
      try {
        const res = await fetch(
          `${API_BASE}/v1/projects/${projectId}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          }
        );
        if (!res.ok) throw new Error("Update failed");
        const result: ProjectInfo = await res.json();
        setProjects((prev) =>
          prev.map((p) => (p.id === projectId ? { ...p, ...result } : p))
        );
        return result;
      } catch (e: unknown) {
        const msg =
          e instanceof Error ? e.message : "Failed to update project";
        setError(msg);
        return null;
      }
    },
    []
  );

  const getProjectDetail = useCallback(async (projectId: string) => {
    try {
      return await apiClient.get<ProjectInfo>(`/projects/${projectId}`);
    } catch {
      return null;
    }
  }, []);

  const addParcelToProject = useCallback(
    async (projectId: string, parcelId: string, role = "main") => {
      try {
        await apiClient.post(`/projects/${projectId}/parcels`, {
          parcel_id: parcelId,
          role,
        });
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const loadStats = useCallback(async () => {
    try {
      const result = await apiClient.get<DbStats>("/parcels/stats/overview");
      setStats(result);
      return result;
    } catch {
      return null;
    }
  }, []);

  // Load on mount
  useEffect(() => {
    loadProjects();
    loadStats();
  }, [loadProjects, loadStats]);

  return {
    projects,
    isLoading,
    error,
    stats,
    loadProjects,
    createProject,
    updateProject,
    getProjectDetail,
    addParcelToProject,
    loadStats,
  };
}
