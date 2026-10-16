'use client';
import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
const selections = new Map<string, { pair: string | null }>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const serverSnapshot = () => null;
const keyFor = (project: string, revision: number) =>
  JSON.stringify([project, revision]);
/** Client-only, ephemeral selection. It carries no prices, credentials or signing state. */
export function usePublishPairMarketSelection(
  project: string,
  revision: number,
  pair: string | null,
) {
  const key = keyFor(project, revision);
  useLayoutEffect(() => {
    if (!selections.has(key) && selections.size >= 64) return;
    const entry = { pair };
    selections.set(key, entry);
    notify();
    return () => {
      if (selections.get(key) === entry) {
        selections.delete(key);
        notify();
      }
    };
  }, [key, pair]);
}
export function usePairMarketSelection(project: string, revision: number) {
  const key = keyFor(project, revision);
  const snapshot = useCallback(() => selections.get(key)?.pair ?? null, [key]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
