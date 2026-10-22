'use client';
import { useId } from 'react';
import { Button } from './ui/button';
import styles from './wallet-warmup-entry.module.css';

export function WalletWarmupEntry({
  loading,
  busy,
  archived,
  visibleCount,
  selectedCount,
  filtered,
  onOpen,
  onShowActive,
  onClearSelection,
}: {
  loading: boolean;
  busy: boolean;
  archived: boolean;
  visibleCount: number;
  selectedCount: number;
  filtered: boolean;
  onOpen: () => void;
  onShowActive: () => void;
  onClearSelection: () => void;
}) {
  const hintId = useId();
  const unavailable = loading || busy;
  const reason = loading
    ? 'Loading wallets. Please wait before opening warmup.'
    : busy
      ? 'A wallet request is in progress. Warmup options will update when it finishes.'
      : archived
        ? 'Warmup uses active wallets. Switch back to choose a wallet.'
        : selectedCount > 20
          ? 'Choose up to 20 wallets for one warmup draft.'
          : !visibleCount
            ? filtered
              ? 'No wallets match this view. Show all wallets to continue.'
              : 'Create a wallet or add a public address first. No funds are needed to plan.'
            : !selectedCount && visibleCount > 1
              ? 'Select 1–20 wallets below, or tap Warmup beside a wallet.'
              : '';
  return (
    <div className={styles.entry}>
      <Button
        variant="outline"
        disabled={unavailable || Boolean(reason)}
        aria-describedby={reason ? hintId : undefined}
        aria-busy={unavailable}
        onClick={onOpen}
      >
        Wallet warmup
      </Button>
      <output id={hintId} aria-atomic="true">
        {reason}
      </output>
      {!unavailable && (archived || (!visibleCount && filtered)) && (
        <Button variant="ghost" onClick={onShowActive}>
          {archived ? 'Show active wallets' : 'Show all wallets'}
        </Button>
      )}
      {!unavailable && !archived && selectedCount > 20 && (
        <Button variant="ghost" onClick={onClearSelection}>
          Clear selection
        </Button>
      )}
    </div>
  );
}
