'use client';
import dynamic from 'next/dynamic';
import { useEffectEvent, useEffect, useId, useRef, useState } from 'react';
import styles from './pump-launch-ui.module.css';
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
  VAULT_STORAGE_KEY,
  unlockVault,
  type VaultSession,
} from '@/lib/browser-wallet-vault';
import {
  requirePumpHolderReview,
  canonicalPumpHolderJson,
} from '@/lib/pump-holder-review';
import {
  signPumpHolderPacket,
  verifyPumpHolderSignedPacket,
} from '@/lib/pump-holder-signing';
import {
  holderAmountRaw,
  holderDisplayRaw as amount,
  holderSizing,
  holderQuote,
  holderConsent,
  parseHolderLaunch,
  type HolderLaunch,
  type HolderProject,
  type HolderSizing,
} from '@/lib/pump-holder-launch-client';
const PumpLaunchGroupReview = dynamic(
  () =>
    import('./pump-launch-group-review').then(
      (loaded) => loaded.PumpLaunchGroupReview,
    ),
  { loading: () => <p>Loading complete launch groups...</p> },
);
type Limit = { address: string; fee: string; quote: string; minimum: string };
const endpoint = '/api/launch/pump/holders';
const pendingKey = (id: string) => 'bundle.pump-holders-signed.v1:' + id;
const terminal = (state: string) =>
  ['finalized', 'failed', 'cancelled'].includes(state);
function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function PumpHolderLaunchReviewContent({
  project,
  releaseId,
  savedReview,
}: {
  project: HolderProject;
  releaseId: string;
  savedReview?: unknown;
}) {
  const id = useId(),
    mounted = useRef(true),
    running = useRef(false),
    controller = useRef<AbortController | null>(null);
  const [mint, setMint] = useState<PumpMintBackup | null>(null),
    [password, setPassword] = useState(''),
    [restoreFile, setRestoreFile] = useState<File | null>(null),
    [vaultPassword, setVaultPassword] = useState('');
  const [fee, setFee] = useState('0.05'),
    [developerCap, setDeveloperCap] = useState(''),
    [backedUp, setBackedUp] = useState(false);
  const [targets, setTargets] = useState<HolderSizing>([]),
    [limits, setLimits] = useState<Limit[]>([]),
    [launch, setLaunch] = useState<HolderLaunch | null>(null);
  const [signConsent, setSignConsent] = useState(false),
    [limitsConsent, setLimitsConsent] = useState(false),
    [broadcast, setBroadcast] = useState(false);
  const [pending, setPending] = useState(''),
    [actionBusy, setBusy] = useState(false),
    [groupBusy, setGroupBusy] = useState(false),
    [groupsOpen, setGroupsOpen] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(() => Date.now());
  const busy = actionBusy || groupBusy;
  const document = project.document,
    plan = document?.plan;
  let quote: ReturnType<typeof holderQuote> | undefined;
  try {
    if (document) quote = holderQuote(document);
  } catch {
    /* An unavailable exact asset keeps preparation/signing closed. */
  }
  const current = () => {
    if (!mounted.current || controller.current?.signal.aborted)
      throw new Error('Holder launch context changed.');
  };
  const resetConsent = () => {
    setSignConsent(false);
    setLimitsConsent(false);
    setBroadcast(false);
  };
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const load = setTimeout(() => {
      try {
        const saved = localStorage.getItem(pumpMintStorageKey(project.id));
        if (saved && mounted.current)
          setMint(parsePumpMintBackup(saved, project.id));
      } catch {
        if (mounted.current)
          setError('Restore this project’s encrypted mint backup.');
      }
    }, 0);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      clearTimeout(load);
      clearInterval(timer);
    };
  }, [project.id]);

  async function run(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    controller.current = new AbortController();
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : 'Holder launch action failed.',
        );
    } finally {
      running.current = false;
      controller.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  async function json(path: string, body?: Record<string, unknown>) {
    current();
    const response = await fetch(path, {
      ...(body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
      signal: AbortSignal.any([
        controller.current!.signal,
        AbortSignal.timeout(70000),
      ]),
    });
    const value = await readPanelJson(
      response,
      'Launch service is unavailable. Reload saved history before retrying.',
    );
    current();
    if (!response.ok)
      throw new Error(
        value &&
          typeof value === 'object' &&
          'error' in value &&
          typeof value.error === 'string'
          ? value.error
          : 'Holder launch request did not complete.',
      );
    return value;
  }
  async function api(body: Record<string, unknown>) {
    const value = await parseHolderLaunch(
      await json(endpoint, body),
      project.id,
    );
    current();
    return value;
  }
  function requestLimits() {
    if (!targets.length || limits.length !== targets.length || !quote)
      throw new Error('Read current holder targets and review every limit.');
    return limits.map((l, i) => {
      if (l.address !== targets[i].address)
        throw new Error('Holder limit order changed.');
      if (targets[i].kind === 'none')
        return { address: l.address, feeAndRentLimitRaw: '0' };
      const raw = holderAmountRaw(l.fee, 9);
      if (BigInt(raw) > 1000000000n)
        throw new Error(
          'Each wallet fee/rent allowance must be at most 1 SOL.',
        );
      return {
        address: l.address,
        feeAndRentLimitRaw: raw,
        ...(targets[i].kind === 'exact-base-output'
          ? { maximumQuoteCostRaw: holderAmountRaw(l.quote, quote.decimals) }
          : { minimumTokenOutputRaw: holderAmountRaw(l.minimum, 6) }),
      };
    });
  }
  function ownTerms() {
    if (
      !mint ||
      !project.payer ||
      !releaseId ||
      !document ||
      !quote ||
      plan?.scheduled
    )
      throw new Error(
        'Save an unscheduled holder plan, exact deployer, quote and published metadata first.',
      );
    const raw = holderAmountRaw(fee, 9);
    if (BigInt(raw) > 1000000000n)
      throw new Error('Deployer fee/rent allowance must be at most 1 SOL.');
    return {
      projectId: project.id,
      updatedAt: project.updatedAt,
      releaseId,
      payer: project.payer.address,
      payerRevision: project.payer.revision,
      mint: mint.mint,
      feeAndRentLimitRaw: raw,
    };
  }
  async function accept(value: HolderLaunch) {
    current();
    const stored = localStorage.getItem(pendingKey(value.review.id));
    setLaunch(value);
    setPending('');
    resetConsent();
    if (stored) await verifyPumpHolderSignedPacket(value.review, stored);
    current();
    setPending(stored ?? '');
  }
  async function history() {
    const value = await json(
      endpoint + '?projectId=' + encodeURIComponent(project.id),
    );
    if (
      !value ||
      typeof value !== 'object' ||
      !('launches' in value) ||
      !Array.isArray(value.launches)
    )
      throw new Error('Holder history is unavailable.');
    if (!value.launches.length) {
      setLaunch(null);
      setError('No saved holder review yet.');
      return;
    }
    const latest = await parseHolderLaunch(value.launches[0], project.id);
    await accept(latest);
  }
  const scopeMatches = () => {
    if (!launch || !document || !quote || !mint || !project.payer) return false;
    const r = launch.review;
    try {
      const rows = requestLimits(),
        saved = r.allowances;
      return (
        r.projectUpdatedAt === project.updatedAt &&
        r.releaseId === releaseId &&
        r.input.create.payer === project.payer.address &&
        r.input.create.mint === mint.mint &&
        r.input.create.quoteMint === quote.address &&
        r.input.create.uri ===
          `${window.location.origin}/api/launch/metadata/${releaseId}` &&
        canonicalPumpHolderJson(r.document) ===
          canonicalPumpHolderJson(document) &&
        saved.deployerFeeAndRentLimitRaw === ownTerms().feeAndRentLimitRaw &&
        saved.developerMaximumQuoteCostRaw ===
          (plan!.developerBuy > 0
            ? holderAmountRaw(developerCap, quote.decimals)
            : null) &&
        canonicalPumpHolderJson(
          rows.map((l) => ({
            ...l,
            maximumQuoteCostRaw:
              'maximumQuoteCostRaw' in l ? l.maximumQuoteCostRaw : null,
            minimumTokenOutputRaw:
              'minimumTokenOutputRaw' in l ? l.minimumTokenOutputRaw : null,
          })),
        ) === canonicalPumpHolderJson(saved.holders)
      );
    } catch {
      return false;
    }
  };
  const valid = scopeMatches(),
    fresh = !!launch && Date.parse(launch.review.expiresAt) > now;
  function restoreLimits(value: HolderLaunch) {
    const r = value.review;
    setTargets(
      r.input.holders.map((h) => ({
        address: h.address,
        kind: h.kind,
        raw:
          h.kind === 'none'
            ? '0'
            : h.kind === 'exact-base-output'
              ? h.tokenAmountRaw
              : h.quoteAmountRaw,
      })),
    );
    setFee(amount(r.allowances.deployerFeeAndRentLimitRaw, 9));
    setDeveloperCap(
      r.allowances.developerMaximumQuoteCostRaw === null
        ? ''
        : amount(
            r.allowances.developerMaximumQuoteCostRaw,
            quote?.decimals ?? 9,
          ),
    );
    setLimits(
      r.allowances.holders.map((l) => ({
        address: l.address,
        fee: amount(l.feeAndRentLimitRaw, 9),
        quote:
          l.maximumQuoteCostRaw === null
            ? ''
            : amount(l.maximumQuoteCostRaw, quote?.decimals ?? 9),
        minimum:
          l.minimumTokenOutputRaw === null
            ? ''
            : amount(l.minimumTokenOutputRaw, 6),
      })),
    );
    resetConsent();
  }
  async function sign() {
    if (
      !launch ||
      !mint ||
      !valid ||
      !fresh ||
      !backedUp ||
      !signConsent ||
      !limitsConsent ||
      pending ||
      !['review', 'approved'].includes(launch.state)
    )
      throw new Error(
        'Review this exact holder packet, limits and encrypted backup before signing.',
      );
    const saved = launch,
      backup = mint,
      walletPass = vaultPassword,
      mintPass = password,
      vault = localStorage.getItem(VAULT_STORAGE_KEY);
    setPassword('');
    setVaultPassword('');
    if (!vault)
      throw new Error(
        'Import the deployer and every active holder into this browser vault first.',
      );
    const guard = () => {
      current();
      if (
        Date.parse(saved.review.expiresAt) <= Date.now() ||
        localStorage.getItem(VAULT_STORAGE_KEY) !== vault ||
        localStorage.getItem(pumpMintStorageKey(project.id)) !==
          JSON.stringify(backup)
      )
        throw new Error('Holder review expired or a stored vault changed.');
    };
    guard();
    const { built } = await requirePumpHolderReview(saved.review);
    guard();
    if (built.quote.decimals !== quote!.decimals)
      throw new Error('Observed quote precision changed.');
    const consent = holderConsent(saved.review),
      approved = await api({ action: 'approve', id: saved.review.id, consent });
    if (
      approved.state !== 'approved' ||
      canonicalPumpHolderJson(approved.review) !==
        canonicalPumpHolderJson(saved.review)
    )
      throw new Error('Holder approval differs.');
    guard();
    let wallets: VaultSession | undefined,
      mintSession: VaultSession | undefined;
    try {
      wallets = await unlockVault(vault, walletPass);
      guard();
      mintSession = await unlockPumpMint(backup, mintPass);
      guard();
      const sessions = new Map(
        built.requiredSigners.map((key) => [
          key,
          key === backup.mint ? mintSession! : wallets!,
        ]),
      );
      const signed = await signPumpHolderPacket(
        sessions,
        saved.review,
        consent,
        guard,
      );
      guard();
      // Retain exact signed bytes before registration. Registration retry never creates new signatures.
      setPending(signed.transaction);
      setLaunch(approved);
      resetConsent();
      try {
        localStorage.setItem(pendingKey(saved.review.id), signed.transaction);
      } catch {
        setError(
          'Signed packet is in memory. Download it or save it to the server before leaving.',
        );
      }
      const registered = await api({
        action: 'register',
        id: saved.review.id,
        consent,
        transaction: signed.transaction,
      });
      current();
      setLaunch(registered);
      resetConsent();
    } finally {
      if (wallets) clearMintSession(wallets);
      if (mintSession) clearMintSession(mintSession);
    }
  }
  const updateLimit = (
    index: number,
    field: 'fee' | 'quote' | 'minimum',
    value: string,
  ) => {
    setLimits((all) =>
      all.map((l, i) => (i === index ? { ...l, [field]: value } : l)),
    );
    resetConsent();
  };
  const reviewedQuote = launch ? holderQuote(launch.review.document) : quote;
  const sim = launch?.simulation.allWalletSimulation,
    accounting = sim?.accounting;
  const rows = launch
    ? [
        {
          address: launch.review.input.create.payer,
          role: 'Deployer',
          kind: launch.review.input.developer
            ? 'exact-base-output'
            : 'create-only',
          cap: launch.review.allowances.developerMaximumQuoteCostRaw,
          fee: launch.review.allowances.deployerFeeAndRentLimitRaw,
          minimum: null,
        },
        ...launch.review.input.holders.map((h, i) => ({
          address: h.address,
          role: `Holder ${i + 1}`,
          kind: h.kind,
          cap:
            launch.review.allowances.holders[i].maximumQuoteCostRaw ??
            (h.kind === 'exact-quote-input' ? h.quoteAmountRaw : null),
          fee: launch.review.allowances.holders[i].feeAndRentLimitRaw,
          minimum: launch.review.allowances.holders[i].minimumTokenOutputRaw,
        })),
      ]
    : [];
  const targetReasons = [
    busy && 'Wait for the current action to finish.',
    !mint && 'Generate or restore this project’s mint key.',
    !project.payer && 'Save a verified deployer wallet.',
    (!document || !plan) && 'Save the complete launch plan.',
    !releaseId && 'Publish and select the approved metadata release.',
    plan?.scheduled && 'Use an unscheduled launch plan.',
    !!(launch && !terminal(launch.state)) &&
      'Finish or discard the active saved launch before reading new targets.',
  ].filter((reason): reason is string => typeof reason === 'string');
  const stage = launch
    ? ['review', 'approved'].includes(launch.state)
      ? !mint || !backedUp
        ? 0
        : !valid
          ? 1
          : launch.state === 'review'
            ? 4
            : pending
              ? 6
              : 5
      : launch.state === 'signed'
        ? 6
        : 7
    : !mint || !backedUp
      ? 0
      : !fee || (plan?.developerBuy && !developerCap)
        ? 1
        : !targets.length
          ? 2
          : 3;
  const completed = (index: number) =>
    [
      !!mint && backedUp,
      !!launch || (!!fee && (!plan?.developerBuy || !!developerCap)),
      !!launch || targets.length > 0,
      !!launch,
      !!launch && !['review', 'cancelled'].includes(launch.state),
      !!pending || !!launch?.signature,
      !!launch && ['submitted', 'finalized', 'failed'].includes(launch.state),
      !!launch?.receipt,
    ][index];
  const steps = [
    'Mint key',
    'Limits',
    'Targets',
    'Simulation',
    'Approval',
    'Signing',
    'Broadcast',
    'Recovery',
  ];
  const openSavedReview = useEffectEvent(() => {
    if (savedReview)
      void run(async () =>
        accept(await parseHolderLaunch(savedReview, project.id)),
      );
  });
  useEffect(() => {
    if (!savedReview) return;
    const timer = setTimeout(() => openSavedReview(), 0);
    return () => clearTimeout(timer);
  }, [savedReview]);
  return (
    <section aria-label="PumpFun holder launch review" className={styles.panel}>
      <h3>Create coin with holder buys</h3>
      <ol aria-label="Holder launch steps" className={styles.steps}>
        {steps.map((step, index) => (
          <li
            key={step}
            aria-current={index === stage ? 'step' : undefined}
            data-state={
              index === stage
                ? 'current'
                : completed(index)
                  ? 'completed'
                  : 'upcoming'
            }
          >
            <span>
              {index + 1}. {step}
            </span>
            <small>
              {index === stage
                ? 'Current'
                : completed(index)
                  ? 'Completed'
                  : 'Upcoming'}
            </small>
          </li>
        ))}
      </ol>
      <p className="source-note">
        Steps describe the saved workflow state. Finalized or expired status
        must be checked in Recovery; progress does not prove a successful
        launch.
      </p>
      <p>
        Creates one PumpFun mainnet transaction with the saved developer buy and
        every active holder buy. Review each wallet’s limits and simulated
        costs. Signing and broadcasting have separate approvals.
      </p>
      <p className="source-note">
        Quote: {plan?.currency ?? 'Save a quote asset'} ·{' '}
        <code className={styles.wrap}>{quote?.address ?? 'Unavailable'}</code>.
        Stock-token issuer controls still apply. Scheduling is unavailable.
        Complete launch groups below can review multiple packets; group signing
        and execution remain disabled.
      </p>
      {(!document || !project.payer || plan?.scheduled) && (
        <p>
          Save the complete unscheduled holder selection and verified deployer
          before preparing. Recovery of saved packets remains available.
        </p>
      )}
      <label htmlFor={id + '-mint'}>
        Mint backup passphrase
        <Input
          id={id + '-mint'}
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {!mint ? (
        <>
          <Button
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
          <label htmlFor={id + '-restore'}>
            Restore encrypted mint backup
            <Input
              id={id + '-restore'}
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !restoreFile || !password}
            onClick={() => {
              const file = restoreFile;
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
                  setBackedUp(false);
                  setRestoreFile(null);
                });
            }}
          >
            Restore selected mint backup
          </Button>
          <p>
            Choose the encrypted backup and enter its passphrase above, then
            select Restore. Selecting a file alone does not unlock it.
          </p>
        </>
      ) : (
        <>
          <p className={styles.wrap}>
            Coin address: <code>{mint.mint}</code>
          </p>
          <Button
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
      <label htmlFor={id + '-fee'}>
        Deployer maximum network fee and rent (SOL, up to 1)
        <Input
          id={id + '-fee'}
          inputMode="decimal"
          value={fee}
          disabled={busy}
          onChange={(e) => {
            setFee(e.target.value);
            resetConsent();
          }}
        />
      </label>
      {!!plan?.developerBuy && (
        <label htmlFor={id + '-developer'}>
          Maximum developer buy spend ({plan.currency})
          <Input
            id={id + '-developer'}
            inputMode="decimal"
            value={developerCap}
            disabled={busy}
            onChange={(e) => {
              setDeveloperCap(e.target.value);
              resetConsent();
            }}
          />
        </label>
      )}
      <div className={styles.actions}>
        <Button
          variant="outline"
          aria-describedby={id + '-target-reasons'}
          disabled={
            busy ||
            !mint ||
            !project.payer ||
            !document ||
            !releaseId ||
            plan?.scheduled ||
            !!(launch && !terminal(launch.state))
          }
          onClick={() =>
            void run(async () => {
              const terms = ownTerms();
              const value = await json('/api/launch/pump/preflight', terms);
              const sized = holderSizing(
                project,
                releaseId,
                mint!.mint,
                window.location.origin,
                value,
              );
              setTargets(sized);
              setLimits(
                sized.map((s) => ({
                  address: s.address,
                  fee: s.kind === 'none' ? '0' : '0.01',
                  quote: '',
                  minimum: '',
                })),
              );
              resetConsent();
            })
          }
        >
          Read current holder targets
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(history)}
        >
          Reload saved holder launch
        </Button>
      </div>
      <div id={id + '-target-reasons'} aria-live="polite">
        {targetReasons.length ? (
          <ul>
            {targetReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p>Ready to read current holder targets.</p>
        )}
      </div>
      {targets.length > 0 && (
        <fieldset disabled={busy} className={styles.limits}>
          <legend>Per-wallet limits</legend>
          <p>
            Targets come from the saved allocation and observed supply. Full
            preparation rechecks every target. Zero allocations stay visible and
            do not sign.
          </p>
          <div className={styles.walletGrid}>
            {targets.map((target, i) => (
              <div key={target.address} className={styles.wallet}>
                <strong>
                  Holder {i + 1} {target.kind === 'none' ? '· No buy' : ''}
                </strong>
                <code className={styles.wrap}>{target.address}</code>
                <p>
                  {target.kind === 'exact-quote-input'
                    ? `Saved quote budget: ${amount(target.raw, quote?.decimals ?? 9)} ${plan?.currency}`
                    : `Target: ${amount(target.raw, 6)} tokens`}
                </p>
                {target.kind !== 'none' && (
                  <>
                    <label htmlFor={`${id}-fee-${i}`}>
                      Holder {i + 1} maximum fee and rent (SOL)
                      <Input
                        id={`${id}-fee-${i}`}
                        inputMode="decimal"
                        value={limits[i]?.fee ?? ''}
                        onChange={(e) => updateLimit(i, 'fee', e.target.value)}
                      />
                    </label>
                    {target.kind === 'exact-base-output' ? (
                      <label htmlFor={`${id}-cap-${i}`}>
                        Holder {i + 1} maximum quote spend ({plan?.currency})
                        <Input
                          id={`${id}-cap-${i}`}
                          inputMode="decimal"
                          value={limits[i]?.quote ?? ''}
                          onChange={(e) =>
                            updateLimit(i, 'quote', e.target.value)
                          }
                        />
                      </label>
                    ) : (
                      <label htmlFor={`${id}-min-${i}`}>
                        Holder {i + 1} minimum tokens received
                        <Input
                          id={`${id}-min-${i}`}
                          inputMode="decimal"
                          value={limits[i]?.minimum ?? ''}
                          onChange={(e) =>
                            updateLimit(i, 'minimum', e.target.value)
                          }
                        />
                      </label>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <Button
            disabled={
              busy || !backedUp || !!(launch && !terminal(launch.state))
            }
            onClick={() =>
              void run(async () => {
                const value = await api({
                  action: 'prepare',
                  ...ownTerms(),
                  ...(plan!.developerBuy > 0
                    ? {
                        developerMaximumQuoteCostRaw: holderAmountRaw(
                          developerCap,
                          quote!.decimals,
                        ),
                      }
                    : {}),
                  holderLimits: requestLimits(),
                });
                await accept(value);
              })
            }
          >
            Simulate complete holder launch
          </Button>
        </fieldset>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={actionBusy || groupBusy}
        onClick={() => setGroupsOpen((open) => !open)}
      >
        {groupsOpen
          ? 'Close complete launch groups'
          : 'Open complete launch groups'}
      </Button>
      {groupsOpen && (
        <PumpLaunchGroupReview
          projectId={project.id}
          contextKey={JSON.stringify([
            project,
            releaseId,
            mint?.mint,
            fee,
            developerCap,
            targets,
            limits,
          ])}
          disabled={actionBusy}
          onBusyChange={setGroupBusy}
          canPrepare={
            !actionBusy &&
            backedUp &&
            !!targets.length &&
            targetReasons.length === 0
          }
          prepareRequest={() => ({
            ...ownTerms(),
            ...(plan!.developerBuy > 0
              ? {
                  developerMaximumQuoteCostRaw: holderAmountRaw(
                    developerCap,
                    quote!.decimals,
                  ),
                }
              : {}),
            holderLimits: requestLimits(),
          })}
        />
      )}
      {launch && (
        <div className={styles.review}>
          <strong>Status: {launch.state}</strong>
          <p>
            Network fee: {amount(sim!.networkFeeRaw, 9)} SOL. Total buys:{' '}
            {amount(
              accounting!.totalQuoteDebitRaw,
              reviewedQuote?.decimals ?? 9,
            )}{' '}
            {launch.review.document.plan.currency}. Metadata is immutable;
            on-chain programs may be upgradeable.
          </p>
          <section
            aria-label="Simulated wallet costs"
            className={styles.scroll}
          >
            <table className={styles.table}>
              <caption>
                Complete packet: wallet limits and simulated settlement
              </caption>
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Token output</th>
                  <th>Quote spend / cap</th>
                  <th>Fee + rent / limit (SOL)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const cost = accounting!.wallets.find(
                    (w) => w.address === row.address,
                  );
                  const fees =
                    cost?.feeAndRentDebitRaw ??
                    (row.role === 'Deployer'
                      ? (
                          BigInt(sim!.networkFeeRaw) +
                          accounting!.rentAccounts
                            .filter((r) => r.payer === row.address)
                            .reduce((sum, r) => sum + BigInt(r.fundingRaw), 0n)
                        ).toString()
                      : '0');
                  return (
                    <tr key={row.address}>
                      <th scope="row">
                        {row.role}
                        <br />
                        <code>
                          {row.address.slice(0, 6)}…{row.address.slice(-5)}
                        </code>
                        {row.kind === 'none' && <small> No buy</small>}
                      </th>
                      <td>
                        {cost ? amount(cost.tokenAmountRaw, 6) : '0'}
                        {row.minimum && (
                          <small> Min {amount(row.minimum, 6)}</small>
                        )}
                      </td>
                      <td>
                        {amount(
                          cost?.quoteDebitRaw ?? '0',
                          reviewedQuote?.decimals ?? 9,
                        )}{' '}
                        / {amount(row.cap ?? '0', reviewedQuote?.decimals ?? 9)}
                      </td>
                      <td>
                        {amount(fees, 9)} / {amount(row.fee, 9)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <details>
            <summary>Review identities and fingerprints</summary>
            <p>
              Mint: {launch.review.input.create.mint}
              <br />
              Quote: {launch.review.input.create.quoteMint}
              <br />
              Metadata: {launch.review.input.create.uri}
              <br />
              Packet: {launch.review.sha256}
              <br />
              Context: {launch.review.contextSha256}
              <br />
              Expires: {launch.review.expiresAt}
            </p>
            {rows.map((row) => (
              <p key={row.address}>
                {row.role}: {row.address}
              </p>
            ))}
          </details>
          {!valid && (
            <p>
              This saved review differs from the current draft, mint or entered
              limits. Signing and broadcast are disabled. Review saved limits
              below or recover its outcome.
            </p>
          )}
          <Button
            variant="outline"
            disabled={
              busy || quote?.address !== launch.review.input.create.quoteMint
            }
            onClick={() => restoreLimits(launch)}
          >
            Use saved review limits
          </Button>
          {!fresh && (
            <p>
              Review expired. Recover its existing outcome before preparing a
              replacement.
            </p>
          )}
          {['review', 'approved'].includes(launch.state) && (
            <>
              <label htmlFor={id + '-vault'}>
                Wallet vault passphrase (deployer and active holders)
                <Input
                  id={id + '-vault'}
                  type="password"
                  autoComplete="current-password"
                  disabled={busy}
                  value={vaultPassword}
                  onChange={(e) => setVaultPassword(e.target.value)}
                />
              </label>
              <p>
                Enter the mint backup passphrase above again. Every required key
                must be available in this browser. Keys and passphrases are
                never sent to the server.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={signConsent}
                  disabled={busy || !valid || !fresh}
                  onChange={(e) => setSignConsent(e.target.checked)}
                />{' '}
                I approve signing this exact mainnet creation, developer buy,
                every active holder buy and all displayed limits.
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={limitsConsent}
                  disabled={busy || !valid || !fresh}
                  onChange={(e) => setLimitsConsent(e.target.checked)}
                />{' '}
                I understand simulation does not prove funded execution, full
                deployed program behavior or buyback split rounding.
              </label>
              <Button
                disabled={
                  busy ||
                  !valid ||
                  !fresh ||
                  !backedUp ||
                  !signConsent ||
                  !limitsConsent ||
                  !password ||
                  !vaultPassword ||
                  !!pending
                }
                onClick={() => void run(sign)}
              >
                Approve and sign complete holder launch
              </Button>
            </>
          )}
          {pending && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                download(
                  'bundle-holder-signed-' + launch.review.id + '.json',
                  JSON.stringify({
                    review: launch.review,
                    transaction: pending,
                  }),
                )
              }
            >
              Download existing signed holder packet
            </Button>
          )}
          {pending && launch.state === 'approved' && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await verifyPumpHolderSignedPacket(launch.review, pending);
                  const value = await api({
                    action: 'register',
                    id: launch.review.id,
                    consent: holderConsent(launch.review),
                    transaction: pending,
                  });
                  current();
                  setLaunch(value);
                  resetConsent();
                })
              }
            >
              Save existing signed holder packet
            </Button>
          )}
          {launch.state === 'signed' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={broadcast}
                  disabled={busy || !valid || !fresh}
                  onChange={(e) => setBroadcast(e.target.checked)}
                />{' '}
                I separately approve broadcasting this complete signed holder
                packet to Solana mainnet.
              </label>
              <Button
                disabled={busy || !valid || !fresh || !broadcast}
                onClick={() =>
                  void run(async () => {
                    if (!broadcast || !scopeMatches())
                      throw new Error(
                        'Review this exact signed packet before broadcast.',
                      );
                    await accept(
                      await api({
                        action: 'submit',
                        id: launch.review.id,
                        consent: holderConsent(launch.review),
                        submitApproved: true,
                      }),
                    );
                  })
                }
              >
                Broadcast approved holder launch
              </Button>
            </>
          )}
          {['submitting', 'submitted'].includes(launch.state) && (
            <p>
              Submission may have reached the network. Recovery checks the
              existing signature and never resends.
            </p>
          )}
          {launch.signature && (
            <a
              href={`https://solscan.io/tx/${launch.signature}`}
              target="_blank"
              rel="noreferrer"
            >
              View holder launch transaction
            </a>
          )}
          {launch.receipt?.kind === 'finalized' && (
            <p>
              {launch.receipt.succeeded
                ? 'Complete holder packet finalized'
                : 'Holder transaction failed'}{' '}
              at slot {launch.receipt.slot}.{' '}
              {launch.receipt.networkFeeUnresolved
                ? 'Network fee remains unresolved.'
                : ''}
            </p>
          )}
          {launch.receipt?.kind === 'expired-unobserved' && (
            <p>
              Expired packet released after finalized mint absence. A receipt
              was not observed; network fees remain unresolved.
            </p>
          )}
          {!terminal(launch.state) && (
            <Button
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
                ? 'Discard unsigned holder review'
                : 'Recover holder status / expired packet'}
            </Button>
          )}
        </div>
      )}
      <div aria-live="polite">
        {busy && <p>Checking complete holder launch…</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
export function PumpHolderLaunchReview(
  props: Parameters<typeof PumpHolderLaunchReviewContent>[0],
) {
  return (
    <PumpHolderLaunchReviewContent
      key={JSON.stringify([props.project, props.releaseId, props.savedReview])}
      {...props}
    />
  );
}
