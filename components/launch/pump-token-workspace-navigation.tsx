'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
const Navigation = createContext<
  ((project: ImportedTokenProject) => void) | null
>(null);
export function PumpTokenWorkspaceNavigation({
  onOpen,
  children,
}: {
  onOpen: (project: ImportedTokenProject) => void;
  children: ReactNode;
}) {
  return <Navigation.Provider value={onOpen}>{children}</Navigation.Provider>;
}
export const usePumpTokenWorkspaceNavigation = () => useContext(Navigation);
