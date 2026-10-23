'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useVenueLaunchRecovery,
  VenueLaunchRecoveryHistory,
} from './venue-launch-recovery';
import styles from '@/components/launch/pump-launch-ui.module.css';
import {
  VAULT_MIN_PASSWORD_LENGTH,
  VAULT_STORAGE_KEY,
  unlockVault,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import {
  clearMintSession,
  createPumpMint,
  parsePumpMintBackup,
  persistPumpMint,
  pumpMintStorageKey,
  unlockPumpMint,
  type PumpMintBackup,
} from '@/lib/pump-mint-vault';
import { quoteCatalog } from '@/lib/quote-catalog';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import type { LaunchLabReview } from '@/lib/launchlab-launch-service';
import { signLaunchLabLaunch } from '@/lib/launchlab-launch-signing';

type Project = {
  id: string;
  updatedAt: string;
  payer?: { address: string; revision: number };
};
type Props = {
  venue: LaunchLabVenue;
  project: Project;
  plan: LaunchPlanInput;
  releaseId: string;
};

import type { LaunchLabVenue } from '@/lib/launchlab-platform-launch';
import { fromRaw, toRaw } from '@/components/stonkfun-launch-review';

export function LaunchLabLaunchReview(props: Props) {
  return (
    <LaunchLabLaunchReviewInner
      key={JSON.stringify([
        props.venue,
        props.project,
        props.plan,
        props.releaseId,
      ])}
      {...props}
    />
  );
}
function LaunchLabLaunchReviewInner({
  venue,
  project,
  plan,
  releaseId,
}: Props) {
  const id = useId();
  const alive = useRef(true);
  const [saved] = useState(() => {
    try {
      const value =
        typeof localStorage === 'undefined'
          ? null
          : localStorage.getItem(pumpMintStorageKey(project.id));
      return {
        backup: value ? parsePumpMintBackup(value, project.id) : null,
        error: '',
      };
    } catch {
      return {
        backup: null,
        error: 'The saved mint key for this project could not be read.',
      };
    }
  });
  const [backup, setBackup] = useState<PumpMintBackup | null>(saved.backup);
  const [mintPass, setMintPass] = useState('');
  const [payerPass, setPayerPass] = useState('');
  const [devBuy, setDevBuy] = useState('0');
  const [solLimit, setSolLimit] = useState('0.05');
  const [review, setReview] = useState<LaunchLabReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(saved.error);
  const recovery = useVenueLaunchRecovery<LaunchLabReview>(
    'launchlab',
    project.id,
  );
  const [broadcastApproved, setBroadcastApproved] = useState(false);
  const sent =
    recovery.record &&
    ['signed', 'submitting', 'submitted', 'finalized'].includes(
      recovery.record.state,
    )
      ? recovery.record
      : null;
  const [now, setNow] = useState(() => Date.now());
  const quote = quoteCatalog('Solana', venue).assets.find(
    (q) =>
      q.symbol === plan.currency &&
      (!plan.quoteAddress || q.address === plan.quoteAddress),
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [review]);

  const terms = () => {
    if (!project.payer || !backup || !quote)
      throw new Error('Missing launch setup.');
    return {
      venue,
      projectId: project.id,
      updatedAt: project.updatedAt,
      releaseId,
      payer: project.payer.address,
      payerRevision: project.payer.revision,
      mint: backup.mint,
      devBuyRaw: toRaw(devBuy, quote.decimals),
      solLimitLamports: toRaw(solLimit, 9),
    };
  };
  const running = useRef(false);
  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Launch step failed.');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const [displayedRecord, setDisplayedRecord] = useState(recovery.record);
  if (displayedRecord !== recovery.record) {
    setDisplayedRecord(recovery.record);
    const row = recovery.record;
    setApproved(false);
    setBroadcastApproved(false);
    setPayerPass('');
    setMintPass('');
    if (row) {
      setReview(row.review);
      setDevBuy(
        fromRaw(row.review.terms.devBuyRaw, row.review.summary.quoteDecimals),
      );
      setSolLimit(fromRaw(row.review.terms.solLimitLamports, 9));
      setNow(recovery.recordReadAt);
    }
  }
  const matchesContext =
    !!review &&
    plan.chain === 'Solana' &&
    plan.launchpad === venue &&
    review.terms.venue === venue &&
    review.input.venue === venue &&
    review.summary.venue === venue &&
    review.terms.projectId === project.id &&
    review.terms.updatedAt === project.updatedAt &&
    review.terms.releaseId === releaseId &&
    review.terms.payer === project.payer?.address &&
    review.terms.payerRevision === project.payer?.revision &&
    review.terms.mint === backup?.mint &&
    review.input.quoteMint === quote?.address &&
    review.summary.quoteDecimals === quote?.decimals &&
    review.input.name === plan.tokenName &&
    review.input.symbol === plan.ticker;
  const expired = review ? Date.parse(review.expiresAt) <= now : false;
  const ready = !!project.payer && !!releaseId && !!quote;

  return (
    <section aria-label={`${venue} launch`} className={styles.createPanel}>
      <h3>Create your {venue} coin</h3>
      <p>
        Launches on {venue} (Raydium LaunchLab) paired with{' '}
        <strong>{plan.currency}</strong>, with an optional creator buy in the
        same transaction. Your keys stay in this browser and nothing is sent
        until you separately approve broadcasting after signing.
      </p>
      {quote && (
        <p className={`source-note ${styles.wrap}`}>
          Exact quote mint: {quote.address}. Stock-labelled tokens have issuer
          controls; a label is not proof of backing or redemption rights.
        </p>
      )}
      {!project.payer && (
        <p>
          Select a verified Solana deployer in launch settings and save the
          project first.
        </p>
      )}
      {!quote && <p>Choose SOL or USD1 for this venue.</p>}
      {!releaseId && (
        <p>Publish the reviewed image and metadata above first.</p>
      )}
      <VenueLaunchRecoveryHistory
        recovery={recovery}
        busy={busy}
        onTask={(task) => void run(task)}
      />
      {!sent && (
        <>
          {!backup ? (
            <>
              <label htmlFor={id + '-new-mint'}>
                New mint key passphrase (at least {VAULT_MIN_PASSWORD_LENGTH}{' '}
                characters)
                <Input
                  id={id + '-new-mint'}
                  type="password"
                  autoComplete="new-password"
                  value={mintPass}
                  disabled={busy}
                  onChange={(e) => setMintPass(e.target.value)}
                />
              </label>
              <Button
                type="button"
                disabled={busy || mintPass.length < VAULT_MIN_PASSWORD_LENGTH}
                onClick={() =>
                  void run(async () => {
                    const pass = mintPass;
                    setMintPass('');
                    const created = await createPumpMint(project.id, pass);
                    await persistPumpMint(created, () => alive.current);
                    if (alive.current) setBackup(created);
                  })
                }
              >
                Generate encrypted mint key
              </Button>
            </>
          ) : (
            <p className={styles.wrap}>
              Token address: <code>{backup.mint}</code>
            </p>
          )}
          <label htmlFor={id + '-buy'}>
            Creator buy ({plan.currency}, 0 for create only)
            <Input
              id={id + '-buy'}
              inputMode="decimal"
              value={devBuy}
              disabled={busy}
              onChange={(e) => {
                setDevBuy(e.target.value);
                setReview(null);
                setApproved(false);
              }}
            />
          </label>
          <label htmlFor={id + '-sol'}>
            Maximum SOL for fees and rent
            <Input
              id={id + '-sol'}
              inputMode="decimal"
              value={solLimit}
              disabled={busy}
              onChange={(e) => {
                setSolLimit(e.target.value);
                setReview(null);
                setApproved(false);
              }}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !ready || !backup || recovery.blocked}
            onClick={() =>
              void run(async () => {
                setReview(null);
                setApproved(false);
                const value = await recovery.prepare(terms());
                if (alive.current) {
                  setReview(value);
                  setNow(Date.now());
                }
              })
            }
          >
            {busy && !review
              ? 'Simulating launch…'
              : 'Prepare and simulate launch'}
          </Button>
        </>
      )}
      {review && !sent && (
        <div className={styles.review}>
          <table className={styles.table}>
            <tbody>
              <tr>
                <th scope="row">Token</th>
                <td>
                  {review.input.name} ({review.input.symbol})
                </td>
              </tr>
              <tr>
                <th scope="row">Platform</th>
                <td>{review.summary.platformName || venue}</td>
              </tr>
              <tr>
                <th scope="row">Graduation raise</th>
                <td>
                  {fromRaw(
                    review.summary.raiseRaw,
                    review.summary.quoteDecimals,
                  )}{' '}
                  {review.summary.quoteSymbol}
                </td>
              </tr>
              <tr>
                <th scope="row">Creator buy</th>
                <td>
                  {fromRaw(
                    review.summary.devBuyRaw,
                    review.summary.quoteDecimals,
                  )}{' '}
                  {review.summary.quoteSymbol}
                </td>
              </tr>
              <tr>
                <th scope="row">Tokens received</th>
                <td>
                  {fromRaw(review.summary.tokensOutRaw, 6)} (
                  {(review.summary.devSupplyBps / 100).toFixed(2)}% of supply)
                </td>
              </tr>
              <tr>
                <th scope="row">SOL fees and rent</th>
                <td>up to {fromRaw(review.summary.solCostLamports, 9)} SOL</td>
              </tr>
              <tr>
                <th scope="row">Pool</th>
                <td className={styles.wrap}>
                  <code>{review.summary.pool}</code>
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            {expired
              ? 'This original review expired. Cancel the unsigned saved launch before preparing another.'
              : `Review valid for ${Math.max(0, Math.ceil((Date.parse(review.expiresAt) - now) / 1000))}s.`}
          </p>
          <label>
            <input
              type="checkbox"
              checked={approved}
              disabled={busy || expired}
              onChange={(e) => setApproved(e.target.checked)}
            />
            <span> I approve this exact {venue} launch transaction.</span>
          </label>
          <label htmlFor={id + '-payer'}>
            Wallet vault passphrase
            <Input
              id={id + '-payer'}
              type="password"
              autoComplete="current-password"
              value={payerPass}
              disabled={busy}
              onChange={(e) => setPayerPass(e.target.value)}
            />
          </label>
          <label htmlFor={id + '-mint'}>
            Mint key passphrase
            <Input
              id={id + '-mint'}
              type="password"
              autoComplete="current-password"
              value={mintPass}
              disabled={busy}
              onChange={(e) => setMintPass(e.target.value)}
            />
          </label>
          <Button
            type="button"
            disabled={
              busy ||
              !approved ||
              expired ||
              !matchesContext ||
              recovery.uncertain ||
              !recovery.record ||
              !['review', 'approved'].includes(recovery.record.state) ||
              !payerPass ||
              !mintPass
            }
            onClick={() =>
              void run(async () => {
                const reviewed = review;
                const check = () => {
                  if (!alive.current) throw new Error('Launch view closed.');
                  recovery.current();
                  if (Date.now() >= Date.parse(reviewed.expiresAt))
                    throw new Error(
                      'Original launch review expired. Recover or cancel it.',
                    );
                };
                let payer: VaultSession | undefined,
                  mint: VaultSession | undefined;
                const p = payerPass,
                  m = mintPass;
                setPayerPass('');
                setMintPass('');
                try {
                  check();
                  if (!matchesContext)
                    throw new Error(
                      'Saved launch differs from this project setup.',
                    );
                  const approvedRow = await recovery.write('approve', {
                    sha256: reviewed.sha256,
                    approved: true,
                  });
                  check();
                  if (
                    approvedRow.state !== 'approved' ||
                    approvedRow.review.sha256 !== reviewed.sha256
                  )
                    throw new Error('Original approval could not be verified.');
                  const vault = localStorage.getItem(VAULT_STORAGE_KEY);
                  if (!vault)
                    throw new Error(
                      'Import the deployer into your browser wallet vault first.',
                    );
                  payer = await unlockVault(vault, p);
                  check();
                  mint = await unlockPumpMint(backup!, m);
                  check();
                  const signed = await signLaunchLabLaunch(
                    payer,
                    mint,
                    reviewed,
                    check,
                  );
                  check();
                  const result = await recovery.write('register', {
                    transaction: signed.transaction,
                  });
                  if (alive.current) {
                    setApproved(false);
                    setBroadcastApproved(false);
                    if (result.state !== 'signed')
                      throw new Error(
                        'Signed launch registration needs recovery.',
                      );
                  }
                } finally {
                  if (payer) clearMintSession(payer);
                  if (mint) clearMintSession(mint);
                }
              })
            }
          >
            {busy ? 'Saving approval and signing…' : 'Approve and sign only'}
          </Button>
        </div>
      )}
      {review && !matchesContext && (
        <p>
          Saved review belongs to its original project revision, payer, mint and
          metadata. It is available for recovery; signing from changed setup is
          disabled.
        </p>
      )}
      {sent && (
        <div aria-live="polite" className={styles.wrap}>
          <p>
            Original saved launch: {sent.state}. Recovery never resends a
            transaction.
          </p>
          {sent.state === 'signed' && (
            <>
              <p>
                {expired
                  ? 'The original broadcast window expired. Recover this signed record; it cannot be renewed or sent here.'
                  : 'The signed transaction is saved. Nothing has been broadcast by signing.'}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={broadcastApproved}
                  disabled={
                    busy || expired || recovery.uncertain || !matchesContext
                  }
                  onChange={(e) => setBroadcastApproved(e.target.checked)}
                />{' '}
                I approve broadcasting this exact saved signed launch once.
              </label>
              <Button
                type="button"
                disabled={
                  busy ||
                  expired ||
                  !broadcastApproved ||
                  recovery.uncertain ||
                  !matchesContext
                }
                onClick={() =>
                  void run(async () => {
                    if (Date.now() >= Date.parse(sent.review.expiresAt))
                      throw Error('Original launch broadcast window expired.');
                    setBroadcastApproved(false);
                    await recovery.write('submit', {
                      sha256: sent.review.sha256,
                      approved: true,
                    });
                  })
                }
              >
                Broadcast saved launch once
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setBroadcastApproved(false);
                await recovery.recover(sent.id);
              })
            }
          >
            Recover saved launch status
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="inspection-error">
          {error}
        </p>
      )}
    </section>
  );
}
