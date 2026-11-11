'use client';
import { useEffect, useId, useState } from 'react';
import bs58 from 'bs58';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { formatSendPercent } from '@/lib/token-send-plan';
import {
  AIRDROP_MAX_RECIPIENTS,
  signAirdrop,
  validatedAirdropAction,
  type TokenAirdropAction,
} from '@/lib/token-airdrop';

const OPEN = ['awaiting_signature', 'signing', 'signed', 'submitted'];
const short = (address: string) =>
  address.slice(0, 4) + '…' + address.slice(-4);
const sumRaw = (values: string[]) =>
  values.reduce((t, v) => t + BigInt(v), 0n).toString();
const percentLabel = (ppm?: string) => formatSendPercent(BigInt(ppm ?? '0'));
const stepName = (kind: TokenAirdropAction['kind']) =>
  kind === 'create' ? 'Airdrop' : kind === 'claim' ? 'Claim' : 'Take-back';

/** Unlocks the vault only for this signature and wipes the decrypted seeds afterwards. */
async function vaultSign(
  password: string,
  review: TokenAirdropAction['document'],
) {
  const session = await unlockVault(
    localStorage.getItem(VAULT_STORAGE_KEY) || '',
    password,
  );
  try {
    return await signAirdrop(session, review, () => {});
  } finally {
    session.payload.wallets.forEach((w) => {
      w.seed = '';
    });
    session.payload.wallets.length = 0;
  }
}

/** Streamflow Airdrop cleanup: one input wallet funds an airdrop, each output wallet claims an equal share, and the input wallet can take back what is left. Every transaction is reviewed, signed in this browser and submitted separately. */
export function AirdropTool({
  wallets,
  mint,
}: {
  wallets: WorkspaceWallet[];
  mint: string;
}) {
  const id = useId();
  const [wallet, setWallet] = useState(wallets[0]?.address ?? ''),
    [percent, setPercent] = useState(''),
    [outputs, setOutputs] = useState<string[]>([]),
    [acknowledged, setAcknowledged] = useState(false),
    [airdrops, setAirdrops] = useState<TokenAirdropAction[]>([]),
    [steps, setSteps] = useState<TokenAirdropAction[]>([]),
    [action, setAction] = useState<TokenAirdropAction | null>(null),
    [approveSign, setApproveSign] = useState(false),
    [approveSubmit, setApproveSubmit] = useState(false),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const source = wallets.find((w) => w.address === wallet);
  const review = action?.document;
  const expired = !!review && Date.parse(review.expiresAt) <= now;
  // The airdrop on screen: the newest create among the loaded steps.
  const parent = steps.find((s) => s.kind === 'create') ?? null;
  const terms = parent?.document.terms;
  const claimOf = (address: string) => {
    const rows = steps.filter(
      (s) => s.kind === 'claim' && s.wallet === address,
    );
    return (
      rows.find((r) => r.state === 'finalized') ??
      rows.find((r) => OPEN.includes(r.state)) ??
      rows.find((r) => r.state === 'failed') ??
      null
    );
  };
  const recipients = terms?.recipients ?? [];
  const claimed = recipients.filter(
      (r) => claimOf(r)?.state === 'finalized',
    ).length,
    failed = recipients.filter((r) => claimOf(r)?.state === 'failed').length,
    takenBack = steps.some(
      (s) => s.kind === 'clawback' && s.state === 'finalized',
    );
  const nextClaim =
    parent?.state === 'finalized' && !takenBack
      ? recipients.find((r) => {
          const state = claimOf(r)?.state;
          return state !== 'finalized' && !OPEN.includes(state ?? '');
        })
      : undefined;

  async function request(body: object) {
    const response = await fetch('/api/wallet-workspace/airdrops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35000),
    });
    const value = (await response.json()) as {
      action?: TokenAirdropAction;
      error?: string;
    };
    if (!response.ok || !value.action)
      throw new Error(value.error || 'Airdrop step unavailable.');
    return validatedAirdropAction(value.action);
  }
  async function list(query: string) {
    const response = await fetch('/api/wallet-workspace/airdrops?' + query, {
      cache: 'no-store',
    });
    const value = (await response.json()) as {
      actions?: TokenAirdropAction[];
      error?: string;
    };
    if (!response.ok || !value.actions)
      throw new Error(value.error || 'Airdrop history unavailable.');
    return Promise.all(value.actions.map(validatedAirdropAction));
  }
  function show(row: TokenAirdropAction) {
    setSteps((prior) =>
      prior.length && prior[0].airdropId !== row.airdropId
        ? [row]
        : [row, ...prior.filter((r) => r.id !== row.id)],
    );
    if (row.kind === 'create')
      setAirdrops((prior) => [row, ...prior.filter((r) => r.id !== row.id)]);
    setAction(OPEN.includes(row.state) ? row : null);
    setApproveSign(false);
    setApproveSubmit(false);
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Airdrop step unavailable.');
    } finally {
      setBusy(false);
    }
  }
  const saved =
    'Exact unsigned transaction simulated and saved. Review it, then approve signing.';
  const draft = () =>
    run(async () => {
      setSteps([]);
      show(
        await request({
          action: 'prepare_create',
          wallet,
          walletRevision: source?.revision,
          mint,
          percent,
          recipients: outputs,
          acknowledgeAirdrop: acknowledged,
        }),
      );
      setNotice(saved);
    });
  const open = (airdropId: string) =>
    run(async () => {
      const rows = await list('airdrop=' + encodeURIComponent(airdropId));
      setSteps(rows);
      setAction(rows.find((r) => OPEN.includes(r.state)) ?? null);
      setApproveSign(false);
      setApproveSubmit(false);
    });
  const reload = () =>
    run(async () => {
      const rows = await list('wallet=' + encodeURIComponent(wallet));
      setAirdrops(rows);
      if (!rows.length) setNotice('No airdrops from this wallet yet.');
    });
  const resume = () =>
    run(async () => {
      if (!parent || !nextClaim) return;
      const claimant = wallets.find((w) => w.address === nextClaim);
      if (!claimant)
        throw new Error(
          `Output wallet ${short(nextClaim)} is no longer in this workspace.`,
        );
      show(
        await request({
          action: 'prepare_claim',
          airdropId: parent.id,
          wallet: nextClaim,
          walletRevision: claimant.revision,
        }),
      );
      setNotice(saved);
    });
  const takeBack = () =>
    run(async () => {
      if (!parent) return;
      const creator = wallets.find((w) => w.address === parent.wallet);
      if (!creator)
        throw new Error('The input wallet is no longer in this workspace.');
      show(
        await request({
          action: 'prepare_clawback',
          airdropId: parent.id,
          wallet: parent.wallet,
          walletRevision: creator.revision,
        }),
      );
      setNotice(saved);
    });
  const sign = () =>
    run(async () => {
      if (!action || expired) return;
      const fresh = action.state === 'awaiting_signature';
      if (fresh) {
        if (!approveSign) return;
        show(await request({ action: 'begin_signing', id: action.id }));
      }
      const signed = await vaultSign(password, action.document).catch(
        async (e: unknown) => {
          // No signature exists, so release the signing reservation.
          try {
            show(
              await request({
                action: 'reject_signing',
                id: action.id,
                noSignatureVerified: true,
              }),
            );
          } catch {
            /* the retained state is reloaded on the next action */
          }
          throw e;
        },
      );
      setPassword('');
      const registered = await request({
        action: 'register',
        id: action.id,
        transaction: signed.transaction,
      });
      if (registered.signature !== signed.signature)
        throw new Error('Signature registration did not match.');
      show(registered);
      setNotice(
        'Signed in this browser. Nothing has been sent. Approve the separate submission.',
      );
    });
  const submit = () =>
    run(async () => {
      if (
        !action ||
        action.state !== 'signed' ||
        !action.signature ||
        !approveSubmit ||
        expired
      )
        return;
      // One signer, so the registered signature rebuilds the exact signed packet.
      const bytes = Uint8Array.from(atob(action.document.transaction), (c) =>
        c.charCodeAt(0),
      );
      bytes.set(bs58.decode(action.signature), 1);
      show(
        await request({
          action: 'submit',
          id: action.id,
          transaction: btoa(String.fromCharCode(...bytes)),
        }),
      );
      setNotice('Submitted once. Check the finalized outcome; do not resend.');
    });
  const recover = () =>
    run(async () => {
      if (!action) return;
      const row = await request({ action: 'recover', id: action.id });
      show(row);
      setNotice(
        row.state === 'finalized'
          ? row.kind === 'create'
            ? 'Airdrop created. Claims open a few minutes after creation; then use Resume / Retry Airdrop.'
            : row.kind === 'claim'
              ? 'Claim finalized. Use Resume / Retry Airdrop for the next wallet.'
              : 'Unclaimed tokens are back in the input wallet.'
          : row.state === 'failed'
            ? row.receipt
              ? 'The transaction failed on chain. No tokens moved. Use Resume / Retry Airdrop to try again.'
              : 'The transaction expired without landing. No tokens moved. Prepare it again.'
            : 'Outcome not final yet.',
      );
    });
  const cancel = () =>
    run(async () => {
      if (!action) return;
      show(
        await request(
          action.state === 'signing'
            ? // The browser never sends anything itself, so an unregistered signature was never broadcast.
              {
                action: 'reject_signing',
                id: action.id,
                noSignatureVerified: true,
              }
            : { action: 'cancel', id: action.id },
        ),
      );
      setNotice('Review cancelled. Nothing was sent.');
    });
  const choices = wallets.filter((w) => w.address !== wallet);
  return (
    <div className="native-withdrawal-form">
      <p>
        Streamflow Airdrop moves a share of one wallet&apos;s tokens into a
        Streamflow airdrop that your chosen output wallets claim in equal parts,
        so the tokens arrive from Streamflow instead of from the input wallet.
        Each output wallet signs its own claim and pays its own fee, so each
        needs a little SOL. Whatever is not claimed can be taken back by the
        input wallet about one day later. Try it with a small amount first.
      </p>
      <label htmlFor={id + 'wallet'}>Input wallet</label>
      <select
        id={id + 'wallet'}
        value={wallet}
        disabled={busy || !!action}
        onChange={(e) => {
          setWallet(e.target.value);
          setOutputs([]);
          setAirdrops([]);
          setSteps([]);
        }}
      >
        <option value="">Select a Solana wallet</option>
        {wallets.map((w) => (
          <option key={w.address} value={w.address}>
            {w.label || w.address} · {w.role}
          </option>
        ))}
      </select>
      <Button
        variant="outline"
        disabled={busy || !wallet}
        onClick={() => void reload()}
      >
        Reload airdrops
      </Button>
      {airdrops.length > 0 && (
        <ul aria-label="Airdrops from this wallet">
          {airdrops.map((a) => (
            <li key={a.id}>
              {a.document.amount} tokens to{' '}
              {a.document.terms.recipients?.length ?? 0} wallets ·{' '}
              {new Date(a.createdAt).toLocaleString()} · {a.state}{' '}
              <Button
                variant="outline"
                disabled={busy || !!action}
                onClick={() => void open(a.id)}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!action && (
        <>
          <label htmlFor={id + 'pct'}>
            Amount (% of the input wallet&apos;s balance)
          </label>
          <Input
            id={id + 'pct'}
            value={percent}
            inputMode="decimal"
            onChange={(e) => setPercent(e.target.value)}
            placeholder="100"
          />
          <fieldset>
            <legend>
              Output wallets ({outputs.length} of up to {AIRDROP_MAX_RECIPIENTS}
              )
            </legend>
            {choices.length === 0 && (
              <p className="tracker-note">
                Add more Solana wallets to this workspace to use as outputs.
              </p>
            )}
            {choices.map((w) => (
              <label key={w.address} className="wallet-checkbox">
                <input
                  type="checkbox"
                  checked={outputs.includes(w.address)}
                  disabled={
                    !outputs.includes(w.address) &&
                    outputs.length >= AIRDROP_MAX_RECIPIENTS
                  }
                  onChange={(e) =>
                    setOutputs((prior) =>
                      e.target.checked
                        ? [...prior, w.address]
                        : prior.filter((a) => a !== w.address),
                    )
                  }
                />{' '}
                {w.label || short(w.address)} · {w.role}
              </label>
            ))}
          </fieldset>
          <label className="wallet-checkbox">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />{' '}
            I understand the tokens leave this wallet until they are claimed or
            taken back.
          </label>
          <Button
            disabled={
              busy ||
              !source ||
              !mint ||
              !percent ||
              !outputs.length ||
              !acknowledged
            }
            onClick={() => void draft()}
          >
            Draft airdrop
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="tracker-error">
          {error}
        </p>
      )}
      {notice && <p className="tracker-note">{notice}</p>}
      {parent && terms && (
        <article className="imported-trade-record" aria-label="Airdrop status">
          <h4>
            Airdrop of {parent.document.amount} tokens · {parent.state}
          </h4>
          <p>
            <output>
              {claimed} claimed · {failed} failed ·{' '}
              {recipients.length - claimed} open
              {takenBack && ' · rest taken back'}
            </output>
          </p>
          <ul>
            {recipients.map((r) => {
              const claim = claimOf(r);
              return (
                <li key={r}>
                  {wallets.find((w) => w.address === r)?.label || short(r)} ·{' '}
                  {formatNativeBalance(
                    terms.perRecipientRaw,
                    parent.document.decimals,
                  )}{' '}
                  ·{' '}
                  {claim?.state === 'finalized'
                    ? 'claimed'
                    : claim?.state === 'failed'
                      ? 'failed, can retry'
                      : claim
                        ? 'claim ' + claim.state.replace('_', ' ')
                        : 'not claimed'}
                </li>
              );
            })}
          </ul>
          <p className="tracker-note">
            Claims open {new Date(terms.startTs * 1000).toLocaleString()}.
            Unclaimed tokens can be taken back from{' '}
            {new Date(terms.clawbackTs * 1000).toLocaleString()}.
          </p>
          {!action && parent.state === 'finalized' && (
            <div className="wallet-roster-actions">
              <Button
                disabled={busy || !nextClaim || now < terms.startTs * 1000}
                onClick={() => void resume()}
              >
                Resume / Retry Airdrop
              </Button>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  takenBack ||
                  claimed === recipients.length ||
                  now < terms.clawbackTs * 1000
                }
                onClick={() => void takeBack()}
              >
                Take back unclaimed
              </Button>
            </div>
          )}
        </article>
      )}
      {action && review && (
        <article className="imported-trade-record" aria-label="Airdrop review">
          <h4>
            {stepName(review.kind)} review · {action.state.replace('_', ' ')}
          </h4>
          <p>
            {review.kind === 'create'
              ? `${review.amount} tokens (${percentLabel(review.percentPpm)} of the balance) leave ${review.wallet} for ${review.terms.recipients?.length} output wallets, ${formatNativeBalance(review.terms.perRecipientRaw, review.decimals)} each.`
              : review.kind === 'claim'
                ? `${review.wallet} claims ${review.amount} tokens from the airdrop.`
                : `${review.wallet} takes back ${review.amount} unclaimed tokens.`}
          </p>
          <p>
            SOL cost up to{' '}
            {formatNativeBalance(
              sumRaw([review.solDebitLamports, review.feeLamports]),
              9,
            )}{' '}
            SOL (network fee, account rent and any Streamflow fee) · Streamflow
            airdrop {short(review.terms.distributor)}
          </p>
          <p className="tracker-note">
            {expired
              ? ['awaiting_signature', 'signing'].includes(action.state)
                ? 'This review expired. Cancel it and prepare again.'
                : 'This review expired. Check the finalized outcome.'
              : `Review expires in ${Math.max(0, Math.ceil((Date.parse(review.expiresAt) - now) / 1000))}s.`}
          </p>
          {['awaiting_signature', 'signing'].includes(action.state) && (
            <>
              {action.state === 'awaiting_signature' ? (
                <label className="wallet-checkbox">
                  <input
                    type="checkbox"
                    checked={approveSign}
                    disabled={expired}
                    onChange={(e) => setApproveSign(e.target.checked)}
                  />{' '}
                  I approve signing this exact transaction.
                </label>
              ) : (
                <p className="tracker-note">
                  Signing was started but not registered. Signing again gives
                  the same signature; nothing has been sent.
                </p>
              )}
              <label htmlFor={id + 'pw'}>Vault password</label>
              <Input
                id={id + 'pw'}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="wallet-roster-actions">
                <Button
                  disabled={
                    busy ||
                    !password ||
                    expired ||
                    (action.state === 'awaiting_signature' && !approveSign)
                  }
                  onClick={() => void sign()}
                >
                  Sign in this browser
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  Cancel review
                </Button>
              </div>
            </>
          )}
          {action.state === 'signed' && (
            <>
              <label className="wallet-checkbox">
                <input
                  type="checkbox"
                  checked={approveSubmit}
                  disabled={expired}
                  onChange={(e) => setApproveSubmit(e.target.checked)}
                />{' '}
                Submit this signed transaction to Solana mainnet now.
              </label>
              <Button
                disabled={busy || !approveSubmit || expired}
                onClick={() => void submit()}
              >
                Submit once
              </Button>
            </>
          )}
          {['signed', 'submitted'].includes(action.state) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void recover()}
            >
              Check finalized outcome
            </Button>
          )}
        </article>
      )}
    </div>
  );
}
