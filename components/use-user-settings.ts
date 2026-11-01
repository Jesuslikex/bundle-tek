'use client';
import { useSyncExternalStore } from 'react';
import {
  normalizeUserSettings,
  USER_SETTINGS_EVENT,
  USER_SETTINGS_KEY,
  type UserSettings,
} from '@/lib/user-settings';

let cache: { raw: string | null; value: UserSettings } | null = null;
function snapshot(): UserSettings {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(USER_SETTINGS_KEY);
  } catch {
    raw = null;
  }
  if (!cache || cache.raw !== raw) {
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    cache = { raw, value: normalizeUserSettings(parsed) };
  }
  return cache.value;
}
function subscribe(onChange: () => void) {
  const storage = (e: StorageEvent) => {
    if (e.key === USER_SETTINGS_KEY) onChange();
  };
  window.addEventListener(USER_SETTINGS_EVENT, onChange);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(USER_SETTINGS_EVENT, onChange);
    window.removeEventListener('storage', storage);
  };
}
/** Browser-saved settings; null during server render. */
export function useUserSettings(): UserSettings | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
