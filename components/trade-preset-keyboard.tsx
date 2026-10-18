'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './ui/button';

export type PresetKeyAction = {
  key: string;
  label: string;
  disabled: boolean;
  select: () => void;
};

export function TradePresetKeyboardPanel({
  label,
  scope,
  blocked,
  actions,
  children,
}: {
  label: string;
  scope: string;
  blocked: boolean;
  actions: PresetKeyAction[];
  children: ReactNode;
}) {
  const [armedScope, setArmedScope] = useState<string | null>(null);
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope || (blocked && armedScope !== null)) {
    setSeenScope(scope);
    setArmedScope(null);
  }
  useEffect(() => {
    const disarm = () => setArmedScope(null);
    window.addEventListener('blur', disarm);
    document.addEventListener('visibilitychange', disarm);
    return () => {
      window.removeEventListener('blur', disarm);
      document.removeEventListener('visibilitychange', disarm);
    };
  }, []);
  const active = armedScope === scope && !blocked;
  return (
    <section aria-label={label} className="min-w-0">
      {children}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={blocked || !actions.some((a) => a.key && !a.disabled)}
          aria-pressed={active}
          onBlur={() => setArmedScope(null)}
          onKeyDown={(event) => {
            // Never intercept typing, button activation, browser shortcuts or held keys.
            if (
              !active ||
              event.target !== event.currentTarget ||
              event.defaultPrevented ||
              event.repeat ||
              event.nativeEvent.isComposing ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              document.visibilityState !== 'visible' ||
              !document.hasFocus()
            )
              return;
            if (event.key === 'Escape') {
              setArmedScope(null);
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            const action = actions.find(
              (a) => a.key && a.key === event.key && !a.disabled,
            );
            if (!action) return;
            event.preventDefault();
            event.stopPropagation();
            action.select();
          }}
          onClick={(event) => {
            setArmedScope(active ? null : scope);
            if (!active) event.currentTarget.focus({ preventScroll: true });
          }}
        >
          {active ? 'Disable preset keys' : 'Enable preset keys'}
        </Button>
      </div>
      {active && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Keys fill amounts only while the preset keys control is focused.
          Escape or moving focus disables them.{' '}
          {actions
            .filter((a) => a.key && !a.disabled)
            .map((a) => `${a.key.toUpperCase()}: ${a.label}`)
            .join(' · ')}
        </p>
      )}
    </section>
  );
}
