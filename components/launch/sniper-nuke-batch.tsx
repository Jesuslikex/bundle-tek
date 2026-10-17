'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readPanelJson } from '@/components/read-panel-json';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import { sniperGuardDisplay } from '@/lib/sniper-guard';
import {
  signSniperNukeBatch,
  sniperNukeConsent,
  type SniperNukeBatch,
} from '@/lib/sniper-nuke';
import styles from './pump-launch-group-ui.module.css';

const endpoint = '/api/launch/pump/sniper-guard';
const STATE_LABEL: Record<string, string> = {
  review: 'Ready to approve',
  signed: 'Signed, not sent',
  submitting: 'Sending',
  submitted: 'Sent',
  finalized: 'Sold',
  failed: 'Failed on chain',
  expired: 'Expired',
  cancelled: 'Discarded',
};

/**
 * Prebuilt Nuke sells for a triggered guard: one reviewed batch, approved
 * once and signed locally in one step. Sending is not connected here.
 */
export function SniperNukeBatchPanel({
  reviewId,
  initial,
  disabled,
}: {
  reviewId: string;
  initial: SniperNukeBatch | null;
  disabled?: boolean;
}) {
  const [batch, setBatch] = useState(initial),
    [approved, setApproved] = useState(false),
    [passphrase, setPassphrase] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0);
  const replace = (next: SniperNukeBatch) => {
    if (next.batchId !== batch?.batchId) {
      generation.current++;
      setApproved(false);
    }
    setBatch(next);
  };

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, reviewId }),
    });
    const value = (await readPanelJson(
      response,
      'Nuke batch response is unavailable.',
    )) as SniperNukeBatch & { error?: string };
    if (!response.ok)
      throw new Error(value.error || 'Nuke batch request failed.');
    return value;
  };
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nuke batch failed.');
    } finally {
      setBusy(false);
    }
  };
  const open = batch?.sells.filter((s) => s.state === 'review') ?? [];
  const live = batch?.sells.some((s) =>
    ['review', 'signed', 'submitting', 'submitted'].includes(s.state),
  );
  const locked = busy || disabled;

  return (
    <div className={styles.review}>
      <strong>Nuke batch</strong>
      {!batch || !live ? (
        <>
          <p>
            Prebuild one full-balance sell per Nuke wallet, simulated and ready
            to review together.
          </p>
          <Button
            type="button"
            disabled={locked}
            onClick={() =>
              void run(async () =>
                replace(await post({ action: 'nuke-prepare' })),
              )
            }
          >
            Prepare Nuke sells
          </Button>
        </>
      ) : null}
      {batch && (
        <ul className={styles.history}>
          {batch.sells.map((sell) => (
            <li key={sell.id}>
              <code>{sell.wallet}</code>
              <span>
                Sell {sniperGuardDisplay(sell.review.inputRaw, 6)} tokens · min{' '}
                {sniperGuardDisplay(sell.review.minimumOutputRaw, 9)} out · fee
                up to {sniperGuardDisplay(sell.review.maximumFeeLamports, 9)}{' '}
                SOL · {STATE_LABEL[sell.state] ?? sell.state}
              </span>
            </li>
          ))}
          {batch.skipped.map((s) => (
            <li key={`skip-${s.wallet}`}>
              <code>{s.wallet}</code>
              <span>Not included: {s.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {open.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const current = batch!,
              mine = generation.current;
            void run(async () => {
              const assertCurrent = () => {
                if (generation.current !== mine)
                  throw new Error(
                    'The Nuke batch changed. Nothing was signed.',
                  );
              };
              const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
              if (!encrypted)
                throw new Error(
                  'Create or import these wallets in the browser vault first.',
                );
              let session = await unlockVault(encrypted, passphrase);
              let signed;
              try {
                signed = await signSniperNukeBatch(
                  session,
                  current,
                  assertCurrent,
                );
              } finally {
                for (const item of session.payload.wallets) item.seed = '';
                session = null as unknown as typeof session;
              }
              setPassphrase('');
              replace(
                await post({
                  action: 'nuke-register',
                  consent: sniperNukeConsent(current),
                  signed,
                }),
              );
            });
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />{' '}
            I approve selling the full balance of all {open.length} wallets
            above.
          </label>
          <label>
            Vault passphrase{' '}
            <input
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={locked || !approved || !passphrase}>
            Sign all {open.length} sells
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() =>
              void run(async () =>
                replace(
                  await post({
                    action: 'nuke-cancel',
                    batchId: batch!.batchId,
                  }),
                ),
              )
            }
          >
            Discard batch
          </Button>
        </form>
      )}
      {batch?.sells.some((s) => s.state === 'signed') && (
        <>
          <p>
            Signed sells are stored but not sent. Sending them from Bundle is
            not connected yet, so these expire unsent.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() =>
              void run(async () =>
                replace(
                  await post({
                    action: 'nuke-observe',
                    batchId: batch!.batchId,
                  }),
                ),
              )
            }
          >
            Refresh status
          </Button>
        </>
      )}
      <div aria-live="polite">
        {busy && <p>Working…</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
