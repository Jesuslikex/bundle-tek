'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VenueLaunchLive } from './venue-launch-live';
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
import type { StonkLaunchReview } from '@/lib/stonkfun-launch-service';
import { signStonkLaunch } from '@/lib/stonkfun-launch-signing';
import type { StonkBundleReview } from '@/lib/stonkfun-bundle-service';
import { STONKFUN_BUNDLE_MAX_HOLDERS } from '@/lib/stonkfun-bundle';
import { signStonkBundlePackets } from '@/lib/stonkfun-bundle-signing';
import type { ProjectDocument } from '@/lib/workspace-project';

type Project = {
  id: string;
  updatedAt: string;
  payer?: { address: string; revision: number };
  document?: ProjectDocument;
};
type AnyReview = StonkLaunchReview | StonkBundleReview;
const bundleOf = (r: AnyReview | null) =>
  r && 'bundle' in r && r.bundle ? (r as StonkBundleReview) : null;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
type Props = { project: Project; plan: LaunchPlanInput; releaseId: string };

/** Decimal quote amount to raw units without floating point. */
export function toRaw(value: string, decimals: number) {
  const v = value.trim();
  if (!v || v === '0') return '0';
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(v);
  if (!m || (m[2] ?? '').length > decimals)
    throw new Error(`Use at most ${decimals} decimal places.`);
  const raw = BigInt(m[1] + (m[2] ?? '').padEnd(decimals, '0'));
  return raw.toString();
}
export function fromRaw(raw: string, decimals: number) {
  const s = raw.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals),
    frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function StonkfunLaunchReview(props: Props) {
  return (
    <StonkfunLaunchReviewInner
      key={JSON.stringify([props.project, props.plan, props.releaseId])}
      {...props}
    />
  );
}
function StonkfunLaunchReviewInner({ project, plan, releaseId }: Props) {
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
  const [review, setReview] = useState<AnyReview | null>(null);
  const recipients = (
    project.document?.options.wallets?.recipients ?? []
  ).filter((r) => r.address !== project.payer?.address);
  const [holderBuys, setHolderBuys] = useState<Record<string, string>>({});
  const [tip, setTip] = useState('0.001');
  const [broadcastPass, setBroadcastPass] = useState('');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(saved.error);
  const recovery = useVenueLaunchRecovery<AnyReview>('stonkfun', project.id);
  const [broadcastApproved, setBroadcastApproved] = useState(false);
  const sent =
    recovery.record &&
    ['signed', 'submitting', 'submitted', 'finalized'].includes(
      recovery.record.state,
    )
      ? recovery.record
      : null;
  const [now, setNow] = useState(() => Date.now());
  const quote = quoteCatalog('Solana', 'StonkFun').assets.find(
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
    const holders = recipients
      .map((r) => ({
        address: r.address,
        revision: r.revision,
        buyRaw: toRaw(holderBuys[r.address] ?? '0', quote.decimals),
      }))
      .filter((h) => h.buyRaw !== '0');
    if (holders.length > STONKFUN_BUNDLE_MAX_HOLDERS)
      throw new Error(
        `A StonkFun bundle holds at most ${STONKFUN_BUNDLE_MAX_HOLDERS} holder wallets.`,
      );
    return {
      ...(holders.length ? { holders, tipLamports: toRaw(tip, 9) } : {}),
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
    setBroadcastPass('');
    if (row) {
      setReview(row.review);
      const saved = bundleOf(row.review);
      if (saved) {
        setHolderBuys(
          Object.fromEntries(
            saved.terms.holders.map((h) => [
              h.address,
              fromRaw(h.buyRaw, row.review.summary.quoteDecimals),
            ]),
          ),
        );
        setTip(fromRaw(saved.terms.tipLamports, 9));
      }
      setDevBuy(
        fromRaw(row.review.terms.devBuyRaw, row.review.summary.quoteDecimals),
      );
      setSolLimit(fromRaw(row.review.terms.solLimitLamports, 9));
      setNow(recovery.recordReadAt);
    }
  }
  const matchesContext =
    !!review &&
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
  const reviewBundle = bundleOf(review);
  const sentBundle = sent ? bundleOf(sent.review) : null;
  const ready = !!project.payer && !!releaseId && !!quote;

  return (
    <section aria-label="StonkFun launch" className={styles.createPanel}>
      <h3>Create your StonkFun coin</h3>
      <p>
        Launches on StonkFun (Raydium LaunchLab) paired with{' '}
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
          {recipients.length > 0 && (
            <fieldset className="min-w-0 space-y-2">
              <legend>
                Holder wallet buys in the same Jito bundle (optional, up to{' '}
                {STONKFUN_BUNDLE_MAX_HOLDERS})
              </legend>
              <p className="source-note">
                Each saved holder wallet buys right after the creation, in one
                atomic Jito bundle: all transactions land together or none do.
                Leave 0 to skip a wallet.
              </p>
              {recipients.map((r) => (
                <label key={r.address} htmlFor={`${id}-holder-${r.address}`}>
                  {short(r.address)} buy ({plan.currency})
                  <Input
                    id={`${id}-holder-${r.address}`}
                    inputMode="decimal"
                    value={holderBuys[r.address] ?? '0'}
                    disabled={busy}
                    onChange={(e) => {
                      const value = e.target.value;
                      setHolderBuys((v) => ({ ...v, [r.address]: value }));
                      setReview(null);
                      setApproved(false);
                    }}
                  />
                </label>
              ))}
              <label htmlFor={id + '-tip'}>
                Jito tip (SOL, paid by the deployer)
                <Input
                  id={id + '-tip'}
                  inputMode="decimal"
                  value={tip}
                  disabled={busy}
                  onChange={(e) => {
                    setTip(e.target.value);
                    setReview(null);
                    setApproved(false);
                  }}
                />
              </label>
            </fieldset>
          )}
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
                <td>{review.summary.platformName || 'StonkFun'}</td>
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
              {reviewBundle?.bundle.holders.map((h) => (
                <tr key={h.holder}>
                  <th scope="row">Holder {short(h.holder)}</th>
                  <td>
                    {fromRaw(h.buyRaw, review.summary.quoteDecimals)}{' '}
                    {review.summary.quoteSymbol} for about{' '}
                    {fromRaw(h.expectedTokensOutRaw, 6)} (at least{' '}
                    {fromRaw(h.minTokensOutRaw, 6)})
                  </td>
                </tr>
              ))}
              {reviewBundle && (
                <>
                  <tr>
                    <th scope="row">Holders total</th>
                    <td>
                      {fromRaw(reviewBundle.bundle.holdersTokensOutRaw, 6)} (
                      {(reviewBundle.bundle.holdersSupplyBps / 100).toFixed(2)}%
                      of supply)
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Jito tip</th>
                    <td>
                      {fromRaw(reviewBundle.bundle.tipLamports, 9)} SOL to{' '}
                      <code>{short(reviewBundle.bundle.tipAccount)}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Bundle check</th>
                    <td>
                      {reviewBundle.bundle.bundleSimulated
                        ? 'Whole bundle simulated in order.'
                        : 'Creation simulated; holder outputs computed from the created curve.'}
                    </td>
                  </tr>
                </>
              )}
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
            <span>
              {' '}
              {reviewBundle
                ? `I approve this exact StonkFun launch bundle (${reviewBundle.bundle.packets.length + 1} transactions).`
                : 'I approve this exact StonkFun launch transaction.'}
            </span>
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
                    ...(bundleOf(reviewed)
                      ? { bundleSha256: bundleOf(reviewed)!.bundle.sha256 }
                      : {}),
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
                  const signed = await signStonkLaunch(
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
                I approve broadcasting this exact saved signed launch once
                {sentBundle ? ' as one Jito bundle with its holder buys' : ''}.
              </label>
              {sentBundle && (
                <label htmlFor={id + '-bundle-pass'}>
                  Wallet vault passphrase (signs the holder and tip
                  transactions)
                  <Input
                    id={id + '-bundle-pass'}
                    type="password"
                    autoComplete="current-password"
                    value={broadcastPass}
                    disabled={busy}
                    onChange={(e) => setBroadcastPass(e.target.value)}
                  />
                </label>
              )}
              <Button
                type="button"
                disabled={
                  busy ||
                  expired ||
                  !broadcastApproved ||
                  recovery.uncertain ||
                  !matchesContext ||
                  (!!sentBundle && !broadcastPass)
                }
                onClick={() =>
                  void run(async () => {
                    if (Date.now() >= Date.parse(sent.review.expiresAt))
                      throw Error('Original launch broadcast window expired.');
                    setBroadcastApproved(false);
                    if (!sentBundle) {
                      await recovery.write('submit', {
                        sha256: sent.review.sha256,
                        approved: true,
                      });
                      return;
                    }
                    const pass = broadcastPass;
                    setBroadcastPass('');
                    const vault = localStorage.getItem(VAULT_STORAGE_KEY);
                    if (!vault)
                      throw new Error(
                        'Import the holder wallets into your browser wallet vault first.',
                      );
                    let session: VaultSession | undefined;
                    try {
                      session = await unlockVault(vault, pass);
                      const check = () => {
                        if (!alive.current)
                          throw new Error('Launch view closed.');
                        recovery.current();
                      };
                      const packets = await signStonkBundlePackets(
                        session,
                        sentBundle,
                        check,
                      );
                      await recovery.write('submit', {
                        sha256: sentBundle.sha256,
                        bundleSha256: sentBundle.bundle.sha256,
                        bundleTransactions: packets,
                        approved: true,
                      });
                    } finally {
                      if (session) clearMintSession(session);
                    }
                  })
                }
              >
                {sentBundle
                  ? 'Sign holders and send bundle once'
                  : 'Broadcast saved launch once'}
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
      {sent && ['submitted', 'finalized'].includes(sent.state) && (
        <VenueLaunchLive venue="stonkfun" id={sent.id} />
      )}
      {error && (
        <p role="alert" className="inspection-error">
          {error}
        </p>
      )}
    </section>
  );
}
