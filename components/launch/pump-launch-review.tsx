'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readPanelJson } from '@/components/read-panel-json';
import {
  createPumpMint,
  parsePumpMintBackup,
  persistPumpMint,
  pumpMintStorageKey,
  unlockPumpMint,
  clearMintSession,
  type PumpMintBackup,
} from '@/lib/pump-mint-vault';
import {
  unlockVault,
  VAULT_STORAGE_KEY,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import {
  signPumpLaunch,
  requirePumpSigningReview,
  decodePumpSigningInput,
  type PumpSigningReview,
} from '@/lib/pump-launch-signing';
import {
  signPumpInitialBuy,
  requirePumpInitialBuySigningReview,
  type PumpInitialBuySigningReview,
} from '@/lib/pump-initial-buy-signing';
import { inspectPumpQuoteMint } from '@/lib/pump-launch-config';
import { quoteCatalog } from '@/lib/quote-catalog';
import type { LaunchPlanInput } from '@/lib/launch-plan';
type Launch = {
  review: PumpSigningReview | PumpInitialBuySigningReview;
  state: string;
  signature: string | null;
  receipt: { succeeded: boolean; slot: string } | null;
  simulation: {
    payerDebitRaw: string;
    networkFeeRaw: string;
    quoteCostRaw?: string;
    feeAndRentDebitRaw?: string;
  };
};
function displayAmount(raw: string | undefined, decimals: number) {
  if (!raw || !/^\d{1,20}$/.test(raw)) return 'Unavailable';
  const digits = raw.padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals),
    fraction = digits.slice(-decimals).replace(/0+$/, '');
  return whole + (fraction ? '.' + fraction : '');
}
function parseLaunch(value: unknown, atomic: boolean): Launch {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (
    !record(value) ||
    !record(value.review) ||
    !record(value.review.input) ||
    !record(value.simulation)
  )
    throw new Error('Invalid launch response.');
  const r = value.review,
    i = atomic ? value.review.input.create : value.review.input,
    sim = value.simulation;
  if (!record(i)) throw new Error('Invalid launch response.');
  if (
    atomic &&
    (value.format !== 'pump-create-buy-review-v1' ||
      value.containsHolderBuys !== false ||
      value.completeLaunch !== false ||
      typeof r.developerSupplyPercent !== 'number' ||
      !Number.isFinite(r.developerSupplyPercent) ||
      r.developerSupplyPercent <= 0 ||
      value.review.input.transactionVersion !== 1 ||
      typeof value.review.input.tokenAmountRaw !== 'string' ||
      typeof value.review.input.maximumQuoteCostRaw !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(value.review.input.maximumQuoteCostRaw))
  )
    throw new Error('Invalid atomic launch response.');
  if (
    [
      'id',
      'projectId',
      'projectUpdatedAt',
      'releaseId',
      'expiresAt',
      'sha256',
      'transaction',
      'feeAndRentLimitRaw',
    ].some((k) => typeof r[k] !== 'string') ||
    ['name', 'symbol', 'payer', 'mint', 'quoteMint', 'uri'].some(
      (k) => typeof i[k] !== 'string',
    ) ||
    !Number.isFinite(Date.parse(String(r.expiresAt))) ||
    ![
      'review',
      'approved',
      'signed',
      'submitting',
      'submitted',
      'finalized',
      'failed',
      'cancelled',
    ].includes(String(value.state)) ||
    !/^\d+$/.test(String(sim.payerDebitRaw)) ||
    !/^\d+$/.test(String(sim.networkFeeRaw)) ||
    (value.signature !== null &&
      (typeof value.signature !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.signature))) ||
    (value.receipt !== null &&
      (!record(value.receipt) ||
        typeof value.receipt.succeeded !== 'boolean' ||
        !/^\d+$/.test(String(value.receipt.slot))))
  )
    throw new Error('Invalid launch response.');
  return value as Launch;
}

type Project = {
  id: string;
  updatedAt: string;
  payer?: { address: string; revision: number };
};
function download(name: string, value: string) {
  const url = URL.createObjectURL(
    new Blob([value], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function PumpLaunchReviewContent({
  project,
  plan,
  releaseId,
  onCreateOnly,
}: {
  project: Project;
  plan: LaunchPlanInput;
  releaseId: string;
  onCreateOnly?: () => void;
}) {
  const fieldId = useId();
  const mounted = useRef(true),
    running = useRef(false);
  const [mint, setMint] = useState<PumpMintBackup | null>(null),
    [password, setPassword] = useState(''),
    [payerPassword, setPayerPassword] = useState(''),
    [allowance, setAllowance] = useState('0.05'),
    [quoteCap, setQuoteCap] = useState(''),
    [limitsConsent, setLimitsConsent] = useState(false);
  const [launch, setLaunch] = useState<Launch | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [approve, setApprove] = useState(false),
    [broadcast, setBroadcast] = useState(false),
    [backedUp, setBackedUp] = useState(false),
    [pending, setPending] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const quote = quoteCatalog('Solana', 'PumpFun').assets.find(
    (q) =>
      q.symbol === plan.currency &&
      (!plan.quoteAddress || q.address === plan.quoteAddress),
  );
  const current = () => {
    if (!mounted.current) throw new Error('Launch context changed.');
  };
  const pendingKey = (id: string) => 'bundle.pump-signed.v1:' + id;
  const atomic = plan.developerBuy > 0;
  const endpoint = atomic ? '/api/launch/pump/initial-buy' : '/api/launch/pump';
  const hasBuys =
    plan.scheduled ||
    (!atomic &&
      (plan.holdersBuy !== 0 || Number(plan.holdersBuyQuote ?? 0) !== 0));
  const creation = (r: Launch['review']) =>
    'create' in r.input ? r.input.create : r.input;
  const quoteRaw = () => {
    if (!quote || !/^\d{1,20}(\.\d{1,18})?$/.test(quoteCap))
      throw new Error('Enter a positive maximum quote spend.');
    const [whole, fraction = ''] = quoteCap.split('.');
    if (fraction.length > quote.decimals)
      throw new Error(
        'Maximum quote spend exceeds the selected asset precision.',
      );
    const raw =
      BigInt(whole) * 10n ** BigInt(quote.decimals) +
      BigInt(fraction.padEnd(quote.decimals, '0'));
    if (raw <= 0n || raw > (1n << 64n) - 1n)
      throw new Error(
        'Choose a positive quote-spend cap within the asset limit.',
      );
    return raw.toString();
  };
  const matchesAllowance = () => {
    try {
      if (!launch || !/^(0|1)(\.\d{1,9})?$/.test(allowance)) return false;
      const [whole, fraction = ''] = allowance.split('.');
      const raw = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
      return (
        raw > 0n &&
        raw <= 1000000000n &&
        raw.toString() === launch.review.feeAndRentLimitRaw
      );
    } catch {
      return false;
    }
  };
  const matchesQuoteCap = () => {
    try {
      return (
        !atomic ||
        (launch &&
          'create' in launch.review.input &&
          launch.review.input.maximumQuoteCostRaw === quoteRaw())
      );
    } catch {
      return false;
    }
  };
  const scopeConsent = () =>
    atomic
      ? {
          approvedScope: 'create-and-developer-buy',
          acknowledgeSimulationLimits: limitsConsent,
        }
      : {};
  useEffect(() => {
    mounted.current = true;
    const load = setTimeout(() => {
      if (!mounted.current) return;
      try {
        const saved = localStorage.getItem(pumpMintStorageKey(project.id));
        if (saved) setMint(parsePumpMintBackup(saved, project.id));
      } catch {
        setError(
          'Stored mint backup is unavailable. Restore its encrypted backup.',
        );
      }
    }, 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      clearTimeout(load);
    };
  }, [project.id]);
  async function api(body: Record<string, unknown>): Promise<Launch> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(50000),
    });
    const value = await readPanelJson(
      response,
      'Launch service is unavailable. Reload saved history before retrying.',
    );
    if (!response.ok)
      throw new Error(
        value &&
          typeof value === 'object' &&
          'error' in value &&
          typeof value.error === 'string'
          ? value.error
          : 'Launch request did not complete.',
      );
    return parseLaunch(value, atomic);
  }
  function accept(value: Launch) {
    current();
    if (value.review.projectId !== project.id)
      throw new Error('Launch belongs to a different project.');
    setLaunch(value);
    setApprove(false);
    setBroadcast(false);
    setLimitsConsent(false);
    setPending(localStorage.getItem(pendingKey(value.review.id)) ?? '');
  }
  async function run(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'Launch action failed.');
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function history() {
    const response = await fetch(
      endpoint + '?projectId=' + encodeURIComponent(project.id),
      { signal: AbortSignal.timeout(15000) },
    );
    const value = (await readPanelJson(
      response,
      'Launch history is unavailable.',
    )) as { launches?: Launch[] };
    if (!response.ok || !Array.isArray(value.launches))
      throw new Error('Launch history is unavailable.');
    current();
    const latest = value.launches[0];
    if (latest) accept(parseLaunch(latest, atomic));
    else {
      setLaunch(null);
      setError('No saved launch review yet.');
    }
  }
  const validScope =
    launch &&
    launch.review.projectUpdatedAt === project.updatedAt &&
    launch.review.releaseId === releaseId &&
    creation(launch.review).name === plan.tokenName &&
    creation(launch.review).symbol === plan.ticker &&
    creation(launch.review).quoteMint === quote?.address &&
    creation(launch.review).payer === project.payer?.address &&
    creation(launch.review).mint === mint?.mint &&
    creation(launch.review).uri ===
      `${window.location.origin}/api/launch/metadata/${releaseId}` &&
    matchesQuoteCap() &&
    matchesAllowance() &&
    (!atomic ||
      ('developerSupplyPercent' in launch.review &&
        launch.review.developerSupplyPercent === plan.developerBuy));
  const fresh = !!launch && Date.parse(launch.review.expiresAt) > now;
  async function sign() {
    if (
      !launch ||
      pending ||
      !validScope ||
      !approve ||
      !backedUp ||
      !mint ||
      hasBuys ||
      (atomic && !limitsConsent)
    )
      throw new Error(
        'Review the exact saved launch and back up its mint first.',
      );
    const saved = launch,
      backup = mint,
      mintPass = password,
      payerPass = payerPassword;
    setPassword('');
    setPayerPassword('');
    let payerVaultSnapshot: string | null = null;
    const check = () => {
      current();
      if (
        payerVaultSnapshot !== null &&
        localStorage.getItem(VAULT_STORAGE_KEY) !== payerVaultSnapshot
      )
        throw new Error('Stored deployer vault changed.');
      if (
        localStorage.getItem(pumpMintStorageKey(project.id)) !==
        JSON.stringify(backup)
      )
        throw new Error('Stored mint changed.');
    };
    if (atomic) {
      if (!('create' in saved.review.input))
        throw new Error('Atomic launch review differs.');
      const reviewed = saved.review as PumpInitialBuySigningReview;
      const decoded = decodePumpSigningInput(reviewed.input.create);
      const precision = decoded.quoteMintAccount
        ? inspectPumpQuoteMint(decoded.quoteMintAccount).decimals
        : 9;
      if (precision !== quote?.decimals)
        throw new Error(
          'Observed quote precision differs. Review the selected asset before signing.',
        );
      await requirePumpInitialBuySigningReview(reviewed, check);
    } else
      await requirePumpSigningReview(saved.review as PumpSigningReview, check);
    const approved = await api({
      action: 'approve',
      ...scopeConsent(),
      id: saved.review.id,
      sha256: saved.review.sha256,
      approved: true,
    });
    if (
      approved.state !== 'approved' ||
      JSON.stringify(approved.review) !== JSON.stringify(saved.review)
    )
      throw new Error('Launch approval differs.');
    check();
    let payerSession: VaultSession | undefined,
      mintSession: VaultSession | undefined;
    try {
      const vault = localStorage.getItem(VAULT_STORAGE_KEY);
      if (!vault)
        throw new Error(
          'Import the saved deployer into your browser wallet vault first.',
        );
      payerVaultSnapshot = vault;
      payerSession = await unlockVault(vault, payerPass);
      mintSession = await unlockPumpMint(backup, mintPass);
      check();
      const signed = atomic
        ? await signPumpInitialBuy(
            payerSession,
            mintSession,
            saved.review as PumpInitialBuySigningReview,
            {
              approved: true,
              reviewId: saved.review.id,
              sha256: saved.review.sha256,
            },
            check,
          )
        : await signPumpLaunch(
            payerSession,
            mintSession,
            saved.review as PumpSigningReview,
            check,
          );
      setPending(signed.transaction);
      setLaunch(approved);
      setApprove(false);
      localStorage.setItem(pendingKey(saved.review.id), signed.transaction);
      accept(
        await api({
          action: 'register',
          id: saved.review.id,
          transaction: signed.transaction,
        }),
      );
    } finally {
      if (payerSession) clearMintSession(payerSession);
      if (mintSession) clearMintSession(mintSession);
    }
  }
  return (
    <section
      aria-label="PumpFun launch review"
      style={{
        display: 'grid',
        gap: 12,
        minWidth: 0,
        borderTop: '1px solid var(--border)',
        paddingTop: 20,
        marginTop: 20,
      }}
    >
      <h3>
        {atomic ? 'Create coin with developer buy' : 'Create your PumpFun coin'}
      </h3>
      <p>
        Creates a mainnet coin paired with <strong>{plan.currency}</strong>. No{' '}
        {atomic
          ? 'holder buys are included. The developer buys ' +
            plan.developerBuy +
            '% of total supply in the creation transaction.'
          : 'initial buys are included.'}{' '}
        Signing and broadcasting require separate approval.
      </p>
      <p className="source-note" style={{ overflowWrap: 'anywhere' }}>
        Exact quote mint: {quote?.address ?? 'Choose an asset'}. Stock-labelled
        tokens have issuer controls; a label is not proof of backing or
        redemption rights.
      </p>
      {hasBuys && (
        <div>
          <p>
            {plan.scheduled
              ? 'Disable scheduling and save before preparing this launch.'
              : 'Holder buys require their own execution flow. Use a developer buy or choose create-only.'}
          </p>
          {onCreateOnly && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onCreateOnly}
            >
              Set initial buys to zero and disable scheduling
            </Button>
          )}
          <p>Save the changed draft before continuing.</p>
        </div>
      )}
      {!project.payer && (
        <p>
          Select a verified Solana deployer in launch settings and save the
          project first.
        </p>
      )}
      {!releaseId && (
        <p>
          Publish the reviewed image and metadata above before preparing
          creation.
        </p>
      )}
      <label htmlFor={fieldId + '-mint'}>
        Mint backup passphrase
        <Input
          id={fieldId + '-mint'}
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {!mint ? (
        <Button
          type="button"
          disabled={busy || !password}
          onClick={() =>
            void run(async () => {
              const pass = password;
              setPassword('');
              const backup = await createPumpMint(project.id, pass);
              await persistPumpMint(backup, () => mounted.current);
              current();
              setMint(backup);
              setBackedUp(false);
            })
          }
        >
          Generate encrypted mint key
        </Button>
      ) : (
        <>
          <p style={{ overflowWrap: 'anywhere' }}>
            New coin address: <code>{mint.mint}</code>
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              download(
                'bundle-mint-' + project.id + '.json',
                JSON.stringify(mint),
              )
            }
          >
            Download encrypted mint backup
          </Button>
          <label>
            <input
              type="checkbox"
              checked={backedUp}
              disabled={busy}
              onChange={(e) => setBackedUp(e.target.checked)}
            />{' '}
            I saved this encrypted mint backup and its passphrase.
          </label>
        </>
      )}
      {!mint && (
        <label htmlFor={fieldId + '-restore'}>
          Restore encrypted mint backup
          <Input
            id={fieldId + '-restore'}
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void run(async () => {
                  if (file.size > 400000)
                    throw new Error('Mint backup is too large.');
                  const backup = parsePumpMintBackup(
                    await file.text(),
                    project.id,
                  );
                  const session = await unlockPumpMint(backup, password);
                  clearMintSession(session);
                  await persistPumpMint(backup, () => mounted.current);
                  current();
                  setMint(backup);
                  setPassword('');
                });
            }}
          />
        </label>
      )}
      <label htmlFor={fieldId + '-allowance'}>
        Maximum network fee and rent (SOL, up to 1)
        <Input
          id={fieldId + '-allowance'}
          inputMode="decimal"
          value={allowance}
          disabled={busy}
          onChange={(e) => {
            setAllowance(e.target.value);
            setApprove(false);
            setBroadcast(false);
          }}
        />
      </label>
      {atomic && (
        <label htmlFor={fieldId + '-quote-cap'}>
          Maximum developer buy spend ({plan.currency})
          <Input
            id={fieldId + '-quote-cap'}
            inputMode="decimal"
            value={quoteCap}
            disabled={busy}
            onChange={(e) => {
              setQuoteCap(e.target.value);
              setApprove(false);
              setBroadcast(false);
              setLimitsConsent(false);
            }}
          />
        </label>
      )}
      {atomic &&
        (plan.holdersBuy !== 0 || Number(plan.holdersBuyQuote ?? 0) !== 0) && (
          <p>
            Your saved holder buys are not included in this transaction. Only
            creation and the developer buy will execute.
          </p>
        )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          type="button"
          disabled={
            busy ||
            hasBuys ||
            !releaseId ||
            !mint ||
            !project.payer ||
            !backedUp
          }
          onClick={() =>
            void run(async () => {
              if (!/^(0|1)(\.\d{1,9})?$/.test(allowance))
                throw new Error(
                  'Enter a SOL allowance with up to nine decimal places.',
                );
              const [whole, fraction = ''] = allowance.split('.'),
                raw =
                  BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
              if (raw <= 0n || raw > 1000000000n)
                throw new Error(
                  'Choose an allowance above zero and at most 1 SOL.',
                );
              accept(
                await api({
                  action: 'prepare',
                  ...(atomic ? { maximumQuoteCostRaw: quoteRaw() } : {}),
                  projectId: project.id,
                  updatedAt: project.updatedAt,
                  releaseId,
                  payer: project.payer!.address,
                  payerRevision: project.payer!.revision,
                  mint: mint!.mint,
                  feeAndRentLimitRaw: raw.toString(),
                }),
              );
            })
          }
        >
          Simulate and prepare launch
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void run(history)}
        >
          Reload saved launch
        </Button>
      </div>
      {launch && (
        <div style={{ display: 'grid', gap: 10, overflowWrap: 'anywhere' }}>
          <strong>Status: {launch.state}</strong>
          <p>
            {creation(launch.review).name} ({creation(launch.review).symbol}) ·
            Mainnet · {atomic ? 'Atomic developer buy' : 'No initial buys'}
          </p>
          <p>
            Mint: {creation(launch.review).mint}
            <br />
            Payer: {creation(launch.review).payer}
            <br />
            Quote: {creation(launch.review).quoteMint}
            <br />
            Metadata: {creation(launch.review).uri}
          </p>
          <p>
            Maximum network fee and rent:{' '}
            {displayAmount(launch.review.feeAndRentLimitRaw, 9)} SOL. Simulated
            SOL debit: {displayAmount(launch.simulation.payerDebitRaw, 9)} SOL;
            network fee: {displayAmount(launch.simulation.networkFeeRaw, 9)}{' '}
            SOL. Created-account rent is included.
          </p>
          {atomic && 'create' in launch.review.input && (
            <p>
              Developer target:{' '}
              {'developerSupplyPercent' in launch.review
                ? launch.review.developerSupplyPercent
                : ''}
              % of total supply (
              {displayAmount(launch.review.input.tokenAmountRaw, 6)} tokens).
              Maximum quote spend:{' '}
              {displayAmount(
                launch.review.input.maximumQuoteCostRaw,
                quote?.decimals ?? 9,
              )}{' '}
              {plan.currency}. Simulated quote spend:{' '}
              {displayAmount(
                launch.simulation.quoteCostRaw,
                quote?.decimals ?? 9,
              )}{' '}
              {plan.currency}. The quote-spend cap is separate from network fees
              and rent.
            </p>
          )}
          <p>
            Packet fingerprint: {launch.review.sha256}
            <br />
            Review expires: {launch.review.expiresAt}
          </p>
          {!fresh && (
            <p>
              Review expired. Recover its outcome or release it after blockhash
              expiry before preparing another.
            </p>
          )}
          {!validScope && (
            <p>
              This saved review differs from the current draft, mint or
              deployer. Signing is disabled; recovery remains available.
            </p>
          )}
          {['review', 'approved'].includes(launch.state) && (
            <>
              <label htmlFor={fieldId + '-payer'}>
                Deployer vault passphrase
                <Input
                  id={fieldId + '-payer'}
                  type="password"
                  autoComplete="current-password"
                  value={payerPassword}
                  disabled={busy}
                  onChange={(e) => setPayerPassword(e.target.value)}
                />
              </label>
              <p>
                Enter the mint backup passphrase above again. Keys stay in this
                browser. Token metadata will be immutable. Pump may retain its
                mint-authority PDA; stock quote assets can retain issuer
                controls. On-chain programs are upgradeable.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={approve}
                  disabled={busy || !validScope || !fresh || hasBuys}
                  onChange={(e) => setApprove(e.target.checked)}
                />{' '}
                I approve signing this exact mainnet coin creation
                {atomic ? ', developer supply target and quote-spend cap' : ''},
                quote mint, immutable metadata and fee/rent allowance.
              </label>
              {atomic && (
                <label>
                  <input
                    type="checkbox"
                    checked={limitsConsent}
                    disabled={busy || !validScope || !fresh}
                    onChange={(e) => setLimitsConsent(e.target.checked)}
                  />{' '}
                  I understand that holder buys are excluded and simulation
                  cannot prove every venue behavior, including buyback rounding
                  or the full deployed program.
                </label>
              )}
              <Button
                type="button"
                disabled={
                  (atomic && !limitsConsent) ||
                  busy ||
                  !!pending ||
                  !validScope ||
                  !fresh ||
                  !approve ||
                  !backedUp ||
                  !password ||
                  !payerPassword ||
                  hasBuys
                }
                onClick={() => void run(sign)}
              >
                {atomic
                  ? 'Approve and sign creation with developer buy'
                  : 'Approve and sign creation'}
              </Button>
            </>
          )}
          {pending && launch.state === 'approved' && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  accept(
                    await api({
                      action: 'register',
                      id: launch.review.id,
                      transaction: pending,
                    }),
                  ),
                )
              }
            >
              Save existing signed packet
            </Button>
          )}
          {launch.state === 'signed' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={broadcast}
                  disabled={busy || !fresh || !validScope}
                  onChange={(e) => setBroadcast(e.target.checked)}
                />{' '}
                I approve broadcasting this signed launch
                {atomic
                  ? ' with its developer buy and the stated simulation limits, without holder buys'
                  : ''}{' '}
                to Solana mainnet.
              </label>
              <Button
                type="button"
                disabled={busy || !broadcast || !fresh || !validScope}
                onClick={() =>
                  void run(async () =>
                    accept(
                      await api({
                        action: 'submit',
                        ...(atomic
                          ? {
                              approvedScope: 'create-and-developer-buy',
                              acknowledgeSimulationLimits: broadcast,
                            }
                          : {}),
                        id: launch.review.id,
                        sha256: launch.review.sha256,
                        approved: true,
                      }),
                    ),
                  )
                }
              >
                Broadcast approved launch
              </Button>
            </>
          )}
          {['submitting', 'submitted'].includes(launch.state) && (
            <p>
              Submission may have reached the network. Recover the existing
              signature; this action will not resend it.
            </p>
          )}
          {launch.signature && (
            <a
              href={`https://solscan.io/tx/${launch.signature}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
          )}
          {launch.receipt && (
            <p>
              {launch.receipt.succeeded
                ? 'Finalized coin creation'
                : 'Finalized transaction failure'}{' '}
              at slot {launch.receipt.slot}.
            </p>
          )}
          {!['finalized', 'failed', 'cancelled'].includes(launch.state) && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  accept(
                    await api({
                      action: launch.state === 'review' ? 'cancel' : 'recover',
                      id: launch.review.id,
                    }),
                  ),
                )
              }
            >
              {launch.state === 'review'
                ? 'Discard unsigned review'
                : 'Recover status / release expired packet'}
            </Button>
          )}
        </div>
      )}
      <div aria-live="polite">
        {busy && <p>Checking launch…</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}

export function PumpLaunchReview(
  props: Parameters<typeof PumpLaunchReviewContent>[0],
) {
  return (
    <PumpLaunchReviewContent
      key={JSON.stringify([props.project, props.plan, props.releaseId])}
      {...props}
    />
  );
}
