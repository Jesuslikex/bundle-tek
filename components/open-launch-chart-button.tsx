'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { openLaunchChart } from '@/lib/open-launch-chart';

/** Opens a launched coin's chart and trading workspace in Bundle. */
export function OpenLaunchChartButton({ mint }: { mint: string }) {
  return <ChartButton key={mint} mint={mint} />;
}

function ChartButton({ mint }: { mint: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => {
          if (pending.current) return;
          const controller = new AbortController();
          pending.current = controller;
          setBusy(true);
          setNote('');
          openLaunchChart(mint, controller.signal)
            .then(() => {
              if (!controller.signal.aborted)
                setNote(
                  'Chart import is ready. Confirm any navigation prompt to open it, or find it under Imports.',
                );
            })
            .catch((e: unknown) => {
              if (!controller.signal.aborted)
                setNote(e instanceof Error ? e.message : 'Chart unavailable.');
            })
            .finally(() => {
              if (pending.current === controller) {
                pending.current = null;
                setBusy(false);
              }
            });
        }}
      >
        {busy ? 'Opening chart…' : 'Open chart in Bundle'}
      </Button>
      {note && <output>{note}</output>}
    </>
  );
}
