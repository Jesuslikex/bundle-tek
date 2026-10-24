'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { openLaunchChart } from '@/lib/open-launch-chart';

/** Opens a launched coin's chart and trading workspace in Bundle. */
export function OpenLaunchChartButton({ mint }: { mint: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setNote('');
          openLaunchChart(mint)
            .then(() =>
              setNote(
                'Opening the chart. You can also find this coin under Imports.',
              ),
            )
            .catch((e: unknown) =>
              setNote(e instanceof Error ? e.message : 'Chart unavailable.'),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Opening chart…' : 'Open chart in Bundle'}
      </Button>
      {note && <output>{note}</output>}
    </>
  );
}
