'use client';
import type {
  ReservationHistoryPage,
  ReservationHistoryCursor,
} from '@/lib/marketplace-reservation-history';
import { marketplaceSol } from '@/lib/marketplace-catalog';
import styles from './marketplace-reservation-buyer.module.css';
export function MarketplaceReservationHistoryPanel({
  history,
  busy,
  onOpen,
  onPage,
  onById,
}: {
  history: ReservationHistoryPage;
  busy: boolean;
  onOpen: (id: string) => void;
  onPage: (cursor: ReservationHistoryCursor | null) => void;
  onById: () => void;
}) {
  return (
    <section aria-label="Saved wallet holds">
      <h3>Saved wallet holds</h3>
      <p>
        Solana · Bundle. These are hold records, not purchases. Status at{' '}
        {new Date(history.observedAt).toLocaleString()}; open a record to
        recover its current full receipt.
      </p>
      {history.entries.length === 0 ? (
        <p>No saved wallet holds in this account.</p>
      ) : (
        <ul className={styles.historyRows} aria-label="Saved wallet holds page">
          {history.entries.map((entry) => (
            <li key={entry.id}>
              <div>
                <strong>
                  {entry.count} {entry.count === 1 ? 'wallet' : 'wallets'} ·{' '}
                  {marketplaceSol(entry.askingPriceLamports)} SOL
                </strong>
                <p>
                  {new Date(entry.createdAt).toLocaleString()} ·{' '}
                  {entry.state === 'held'
                    ? 'Held at snapshot'
                    : entry.state === 'released'
                      ? 'Released'
                      : 'Expired at snapshot'}
                </p>
                <code>{entry.id}</code>
              </div>
              <button
                disabled={busy}
                aria-label={`Open saved hold ${entry.id}`}
                onClick={() => onOpen(entry.id)}
              >
                Open hold
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.controls}>
        <button disabled={busy} onClick={onById}>
          Recover by ID instead
        </button>
        <button disabled={busy} onClick={() => onPage(null)}>
          Latest saved holds
        </button>
        {history.nextCursor && (
          <button disabled={busy} onClick={() => onPage(history.nextCursor)}>
            Older saved holds
          </button>
        )}
      </div>
    </section>
  );
}
