'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readPanelJson } from '@/components/read-panel-json';
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
import {
  METEORA_DBC_VENUE,
  type MeteoraDbcReview,
} from '@/lib/meteora-dbc-launch-service';
import { signMeteoraDbcLaunch } from '@/lib/meteora-dbc-launch-signing';
import { fromRaw, toRaw } from '@/components/stonkfun-launch-review';

type Project = {
  id: string;
  updatedAt: string;
  payer?: { address: string; revision: number };
};
type Props = {
  project: Project;
  plan: LaunchPlanInput;
  releaseId: string;
};
type Sent = {
  state: 'sent' | 'unknown';
  signature: string;
  mint: string;
  pool: string;
};

/**
 * Meteora DBC launch from an existing DBC config key, signed in this browser.
 * Like Proxima, the user enters the config; Bundle reads and checks it on-chain.
 */
export function MeteoraDbcLaunchReview({ project, plan, releaseId }: Props) {
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
  const [config, setConfig] = useState('');
  const [devBuy, setDevBuy] = useState('0');
  const [solLimit, setSolLimit] = useState('0.05');
  const [review, setReview] = useState<MeteoraDbcReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(saved.error);
  const [sent, setSent] = useState<Sent | null>(null);
  const [status, setStatus] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const quote = quoteCatalog('Solana', METEORA_DBC_VENUE).assets.find(
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
      projectId: project.id,
      updatedAt: project.updatedAt,
      releaseId,
      payer: project.payer.address,
      payerRevision: project.payer.revision,
      mint: backup.mint,
      config: config.trim(),
      devBuyRaw: toRaw(devBuy, quote.decimals),
      solLimitLamports: toRaw(solLimit, 9),
    };
  };
  async function api(body: unknown) {
    const response = await fetch('/api/meteora-dbc/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = (await readPanelJson(
      response,
      'Launch response could not be read. Check the mint before retrying.',
    )) as Record<string, unknown>;
    if (!response.ok)
      throw new Error(
        typeof value?.error === 'string'
          ? value.error
          : 'Launch request failed.',
      );
    return value;
  }
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Launch step failed.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const expired = review ? Date.parse(review.expiresAt) <= now : false;
  const configValid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.trim());
  const ready = !!project.payer && !!releaseId && !!quote && configValid;

  return (
    <section aria-label="Meteora DBC launch" className={styles.createPanel}>
      <h3>Create your Meteora DBC coin</h3>
      <p>
        Launches a Meteora Dynamic Bonding Curve pool from the DBC config you
        enter, paired with <strong>{plan.currency}</strong>, with an optional
        creator buy in the same transaction. Your keys stay in this browser and
        nothing is sent until you approve and sign.
      </p>
      {!quote && (
        <p>Choose SOL or USDC as the quote token and save the project.</p>
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
          <label htmlFor={id + '-config'}>
            DBC config
            <Input
              id={id + '-config'}
              placeholder="Enter a DBC config"
              autoComplete="off"
              spellCheck={false}
              value={config}
              disabled={busy}
              onChange={(e) => {
                setConfig(e.target.value);
                setReview(null);
                setApproved(false);
              }}
            />
          </label>
          <p>
            The config sets the curve, fees and graduation. Its fee claimer
            earns the partner trading fees, so use a config you trust.
          </p>
          {!configValid && <p>Enter a DBC config.</p>}
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
            Maximum SOL for fees, rent and pool creation fee
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
            disabled={busy || !ready || !backup}
            onClick={() =>
              void run(async () => {
                setReview(null);
                setApproved(false);
                const value = (await api({
                  action: 'prepare',
                  terms: terms(),
                })) as unknown as MeteoraDbcReview;
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
      {review && !sent && quote && (
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
                <th scope="row">DBC config</th>
                <td className={styles.wrap}>
                  <code>{review.summary.config}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">Fee claimer</th>
                <td className={styles.wrap}>
                  <code>{review.summary.feeClaimer}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">Token standard</th>
                <td>{review.summary.tokenStandard}</td>
              </tr>
              <tr>
                <th scope="row">Graduation threshold</th>
                <td>
                  {fromRaw(
                    review.summary.migrationThresholdRaw,
                    quote.decimals,
                  )}{' '}
                  {review.summary.quoteSymbol}
                </td>
              </tr>
              <tr>
                <th scope="row">Creator share of trading fees</th>
                <td>{review.summary.creatorTradingFeePercent}%</td>
              </tr>
              <tr>
                <th scope="row">Creator buy</th>
                <td>
                  {fromRaw(review.summary.devBuyRaw, quote.decimals)}{' '}
                  {review.summary.quoteSymbol}
                </td>
              </tr>
              <tr>
                <th scope="row">Tokens received</th>
                <td>
                  {fromRaw(
                    review.summary.tokensOutRaw,
                    review.summary.baseDecimals,
                  )}{' '}
                  ({(review.summary.devSupplyBps / 100).toFixed(2)}% of supply)
                </td>
              </tr>
              <tr>
                <th scope="row">Pool creation fee</th>
                <td>
                  {fromRaw(review.summary.poolCreationFeeLamports, 9)} SOL
                </td>
              </tr>
              <tr>
                <th scope="row">SOL fees, rent and creation fee</th>
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
              ? 'This review expired. Prepare it again for a fresh blockhash.'
              : `Review valid for ${Math.max(0, Math.ceil((Date.parse(review.expiresAt) - now) / 1000))}s.`}
          </p>
          <label>
            <input
              type="checkbox"
              checked={approved}
              disabled={busy || expired}
              onChange={(e) => setApproved(e.target.checked)}
            />
            <span> I approve this exact Meteora DBC launch transaction.</span>
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
            disabled={busy || !approved || expired || !payerPass || !mintPass}
            onClick={() =>
              void run(async () => {
                const reviewed = review;
                const check = () => {
                  if (!alive.current) throw new Error('Launch view closed.');
                };
                let payer: VaultSession | undefined,
                  mint: VaultSession | undefined;
                const p = payerPass,
                  m = mintPass;
                setPayerPass('');
                setMintPass('');
                try {
                  const vault = localStorage.getItem(VAULT_STORAGE_KEY);
                  if (!vault)
                    throw new Error(
                      'Import the deployer into your browser wallet vault first.',
                    );
                  payer = await unlockVault(vault, p);
                  mint = await unlockPumpMint(backup!, m);
                  const signed = await signMeteoraDbcLaunch(
                    payer,
                    mint,
                    reviewed,
                    check,
                  );
                  const result = (await api({
                    action: 'submit',
                    terms: reviewed.terms,
                    input: reviewed.input,
                    transaction: signed.transaction,
                  })) as unknown as Sent;
                  if (alive.current) {
                    setSent(result);
                    setApproved(false);
                  }
                } finally {
                  if (payer) clearMintSession(payer);
                  if (mint) clearMintSession(mint);
                }
              })
            }
          >
            {busy ? 'Signing and sending…' : 'Sign and launch'}
          </Button>
        </div>
      )}
      {sent && (
        <div aria-live="polite" className={styles.wrap}>
          <p>
            {sent.state === 'sent'
              ? 'Launch sent once. It is not resent automatically.'
              : 'The network did not confirm receipt. It may still land; check before doing anything else.'}
          </p>
          <p>
            <a
              href={`https://solscan.io/tx/${sent.signature}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
            {' · '}
            <a
              href={`https://solscan.io/token/${sent.mint}`}
              target="_blank"
              rel="noreferrer"
            >
              View token
            </a>
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const response = await fetch(
                  `/api/meteora-dbc/launch?signature=${sent.signature}`,
                );
                const value = (await readPanelJson(
                  response,
                  'Status unavailable.',
                )) as { state?: string; error?: string };
                if (!response.ok)
                  throw new Error(value?.error ?? 'Status unavailable.');
                if (alive.current) setStatus(String(value.state));
              })
            }
          >
            Check status
          </Button>
          {status && <p>Status: {status}</p>}
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
