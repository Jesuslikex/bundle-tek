'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
export function useImportedProjects() {
  const [projects, setProjects] = useState<ImportedTokenProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const accept = useCallback((incoming: ImportedTokenProject[]) => {
    setProjects((previous) => {
      const merged = new Map(previous.map((p) => [p.id, p]));
      for (const project of incoming) {
        const current = merged.get(project.id);
        if (!current || current.revision <= project.revision)
          merged.set(project.id, project);
      }
      return [...merged.values()].sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
    });
    setError('');
  }, []);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      const response = await fetch('/api/imported-projects', {
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = (await response.json()) as {
        projects?: ImportedTokenProject[];
        error?: string;
      };
      if (!response.ok || !Array.isArray(data.projects))
        throw new Error(data.error || 'Imported projects unavailable.');
      if (!controller.signal.aborted) accept(data.projects);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Imported projects unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [accept]);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => {
      if (current) return refresh();
    });
    return () => {
      current = false;
      pending.current?.abort();
    };
  }, [refresh]);
  return {
    projects,
    loading,
    error,
    accept,
    refresh: () => {
      setLoading(true);
      return refresh();
    },
  };
}
