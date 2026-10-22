'use client';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
/** Track focus only for one explicit request; outside pointer/focus changes cancel restoration. */
export function useRecoveryReadFocus(
  panel: RefObject<HTMLElement | null>,
  button: RefObject<HTMLButtonElement | null>,
) {
  const alive = useRef(true),
    wanted = useRef(false),
    stop = useRef<(() => void) | null>(null);
  const [version, setVersion] = useState(0);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current?.();
      wanted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (wanted.current) {
      wanted.current = false;
      if (!button.current?.disabled) button.current?.focus();
    }
  }, [version, button]);
  return function track() {
    stop.current?.();
    let outside = false,
      finished = false;
    const moved = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !panel.current?.contains(event.target)
      )
        outside = true;
    };
    const blurred = () => {
      outside = true;
    };
    document.addEventListener('pointerdown', moved, true);
    document.addEventListener('focusin', moved, true);
    window.addEventListener('blur', blurred);
    const cleanup = () => {
      document.removeEventListener('pointerdown', moved, true);
      document.removeEventListener('focusin', moved, true);
      window.removeEventListener('blur', blurred);
      if (stop.current === cleanup) stop.current = null;
    };
    stop.current = cleanup;
    return () => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!alive.current) return;
      wanted.current =
        !outside &&
        (document.activeElement === document.body ||
          !!panel.current?.contains(document.activeElement));
      if (wanted.current) setVersion((v) => v + 1);
    };
  };
}
