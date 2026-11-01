'use client';

import { useId, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  cexSelectionLabel,
  cexSelectionReady,
  selectableCexSources,
  toggleAllCexSources,
  toggleCexSource,
  type CexFundingSource,
} from '@/lib/cex-funding-sources';

// Captured Proxima "CEX Funding Sources" modal: a 600px dialog listing the
// available CEXs behind "Select the CEXs you want to use", a running
// selected/total count, and a Select All row. The catalog is server-fed, so it
// arrives as a prop; an empty catalog is a real state and says so.
export function CexFundingSourcesDialog({
  sources,
  selected,
  returnFocus,
  onClose,
  onChange,
  onConfirm,
}: {
  sources: readonly CexFundingSource[];
  selected: readonly string[];
  returnFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onChange: (selected: string[]) => void;
  onConfirm: () => void;
}) {
  const id = useId();
  const offered = selectableCexSources(sources);
  const allOn = offered.length > 0 && selected.length === offered.length;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="wallet-folder-editor-dialog"
        finalFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle id={`${id}-title`}>CEX Funding Sources</DialogTitle>
          <DialogDescription>
            Select the CEXs you want to use{' '}
            <span className="cex-source-count">
              ({cexSelectionLabel(selected, offered.length)})
            </span>
          </DialogDescription>
        </DialogHeader>

        {offered.length === 0 ? (
          <p className="cex-source-empty">
            No CEX sources are configured for this network yet.
          </p>
        ) : (
          <ul className="cex-source-list">
            <li>
              <button
                type="button"
                className={`cex-source-item cex-source-all${allOn ? ' is-on' : ''}`}
                onClick={() => onChange(toggleAllCexSources(selected, sources))}
              >
                <span>Select All</span>
                <span aria-hidden>{allOn ? '✓' : ''}</span>
              </button>
            </li>
            {offered.map((source) => {
              const on = selected.includes(source.id);
              return (
                <li key={source.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    className={`cex-source-item${on ? ' is-on' : ''}`}
                    onClick={() =>
                      onChange(toggleCexSource(selected, source.id, sources))
                    }
                  >
                    <span>{source.name}</span>
                    <span aria-hidden>{on ? '✓' : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="wallet-folder-editor-actions">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!cexSelectionReady(selected, sources)}
            onClick={onConfirm}
          >
            Confirm
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
