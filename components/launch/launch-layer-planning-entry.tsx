'use client';
import dynamic from 'next/dynamic';
import { useCallback, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { LayerSelection } from '@/lib/launch-layer-client';
import styles from './launch-layer-planning-entry.module.css';

const PumpLayerPlanner = dynamic(
  () =>
    import('./pump-layer-planner').then((loaded) => loaded.PumpLayerPlanner),
  { loading: () => <p>Loading layer planning…</p> },
);
type Props = {
  selection: LayerSelection;
  disabled?: boolean;
  frontOnly?: boolean;
};
function Entry({ selection, disabled = false, frontOnly = false }: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const noticeId = useId();
  const toggleButton = useRef<HTMLButtonElement>(null);
  const attempt = useRef(0);
  const unconfirmedSave = useRef<number | null>(null);
  const dismissedThrough = useRef(0);
  const [closedUnconfirmed, setClosedUnconfirmed] = useState<number | null>(
    null,
  );
  const onSaveUnconfirmed = useCallback((unconfirmed: boolean) => {
    unconfirmedSave.current = unconfirmed ? ++attempt.current : null;
  }, []);
  return (
    <>
      <Button
        ref={toggleButton}
        type="button"
        variant="outline"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={closedUnconfirmed !== null ? noticeId : undefined}
        onClick={() => {
          if (
            open &&
            unconfirmedSave.current !== null &&
            unconfirmedSave.current > dismissedThrough.current
          )
            setClosedUnconfirmed(unconfirmedSave.current);
          setOpen((value) => !value);
        }}
      >
        {open
          ? 'Close layer planning'
          : frontOnly
            ? 'Plan Front wallets'
            : 'Plan Front / Back layers'}
      </Button>
      <output
        aria-live="polite"
        aria-atomic="true"
        className={closedUnconfirmed !== null ? styles.recovery : undefined}
      >
        {closedUnconfirmed !== null && (
          <>
            <span id={noticeId}>
              Layer planning was closed before a save was confirmed. The
              planning snapshot may already be saved.{' '}
              {open
                ? 'Load saved history before saving again.'
                : 'Open layer planning and load saved history before saving again.'}
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                dismissedThrough.current = Math.max(
                  dismissedThrough.current,
                  closedUnconfirmed,
                );
                setClosedUnconfirmed(null);
                toggleButton.current?.focus();
              }}
            >
              Dismiss save warning
            </Button>
          </>
        )}
      </output>
      {open && (
        <div id={panelId}>
          <PumpLayerPlanner
            selection={selection}
            disabled={disabled}
            frontOnly={frontOnly}
            onSaveUnconfirmed={onSaveUnconfirmed}
          />
        </div>
      )}
    </>
  );
}
export function LaunchLayerPlanningEntry(props: Props) {
  return <Entry key={JSON.stringify(props.selection)} {...props} />;
}
