'use client';
import dynamic from 'next/dynamic';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { LayerSelection } from '@/lib/launch-layer-client';

const PumpLayerPlanner = dynamic(
  () =>
    import('./pump-layer-planner').then((loaded) => loaded.PumpLayerPlanner),
  { loading: () => <p>Loading layer planning…</p> },
);
type Props = { selection: LayerSelection; disabled?: boolean };
function Entry({ selection, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close layer planning' : 'Plan Front / Back layers'}
      </Button>
      {open && (
        <div id={panelId}>
          <PumpLayerPlanner selection={selection} disabled={disabled} />
        </div>
      )}
    </>
  );
}
export function LaunchLayerPlanningEntry(props: Props) {
  return <Entry key={JSON.stringify(props.selection)} {...props} />;
}
