'use client';
import { useCallback, useEffect, useState } from 'react';

/** Display clock only. It neither changes history dates nor starts any reads. */
export function useTrackedHistoryClock() {
  const [display, setDisplay] = useState<{
    relative: boolean;
    now: number | null;
  }>({ relative: false, now: null });
  const setRelative = useCallback((relative: boolean) => {
    setDisplay({ relative, now: relative ? Date.now() : null });
  }, []);
  useEffect(() => {
    if (!display.relative) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setDisplay((current) =>
        current.relative ? { relative: true, now } : current,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [display.relative]);
  return { ...display, setRelative };
}
