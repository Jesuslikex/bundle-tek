'use client';

import { useEffect, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  WALLET_TABLE_ALWAYS_COLUMN,
  WALLET_TABLE_COLUMNS,
  WALLET_TABLE_COLUMN_LABELS,
  type WalletTableColumn,
  type WalletTableSettings,
} from '@/lib/wallet-table-settings';

type Props = {
  open: boolean;
  settings: WalletTableSettings;
  onChange: (settings: WalletTableSettings) => void;
  onReset: () => void;
  onClose: () => void;
};

// Captured Proxima "Wallet Table Settings": the address column is always on, the
// metric columns are independent toggles, and Reset restores all of them.
export function WalletTableSettingsDialog({
  open,
  settings,
  onChange,
  onReset,
  onClose,
}: Props) {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (column: WalletTableColumn) =>
    onChange({ ...settings, [column]: !settings[column] });

  return (
    <div className="wallet-table-settings-overlay">
      <dialog
        open
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="wallet-table-settings"
      >
        <div className="wallet-table-settings-head">
          <h2 id={`${id}-title`}>Wallet Table Settings</h2>
          <Button ref={close} type="button" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="wallet-table-settings-hint">
          Choose which columns the wallet table shows. The wallet column always
          stays visible.
        </p>
        <ul className="wallet-table-settings-rows">
          <li className="wallet-table-settings-row is-on">
            <span>{WALLET_TABLE_ALWAYS_COLUMN}</span>
            <span className="wallet-table-settings-fixed">Always</span>
          </li>
          {WALLET_TABLE_COLUMNS.map((column) => (
            <li key={column}>
              <label className="wallet-table-settings-row">
                <input
                  type="checkbox"
                  checked={settings[column]}
                  onChange={() => toggle(column)}
                />{' '}
                <span>{WALLET_TABLE_COLUMN_LABELS[column]}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="wallet-table-settings-foot">
          <Button type="button" size="sm" variant="outline" onClick={onReset}>
            Reset
          </Button>
        </div>
      </dialog>
    </div>
  );
}
