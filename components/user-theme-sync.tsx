'use client';
import { useEffect } from 'react';
import {
  applyUserTheme,
  normalizeUserSettings,
  readUserSettings,
  USER_SETTINGS_EVENT,
  USER_SETTINGS_KEY,
} from '@/lib/user-settings';
/** Applies the saved theme to <html> and follows changes from any tab. */
export function UserThemeSync() {
  useEffect(() => {
    const root = document.documentElement;
    applyUserTheme(readUserSettings(), root);
    const local = (e: Event) =>
      applyUserTheme(normalizeUserSettings((e as CustomEvent).detail), root);
    const other = (e: StorageEvent) => {
      if (e.key === USER_SETTINGS_KEY) applyUserTheme(readUserSettings(), root);
    };
    window.addEventListener(USER_SETTINGS_EVENT, local);
    window.addEventListener('storage', other);
    return () => {
      window.removeEventListener(USER_SETTINGS_EVENT, local);
      window.removeEventListener('storage', other);
    };
  }, []);
  return null;
}
