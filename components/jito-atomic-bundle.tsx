'use client';
import { TransactionDeliveryNotice } from '@/components/transaction-delivery-notice';
import { createAuthClient } from 'better-auth/react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  requireJitoManifest,
  jitoIntentSelection,
  type JitoBundleManifest,
  type JitoBundleRecord,
} from '@/lib/jito-bundle';
import type { WarmupSigningReview } from '@/lib/warmup-signing';
import type { TradeSession } from '@/lib/imported-trade-session';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { JitoPacketSigning } from './jito-packet-signing';
import { JitoBundleTimeline } from './jito-bundle-timeline';
import { JitoSequentialCheck } from './jito-sequential-check';
import { requireJitoFinalization } from '@/lib/jito-finalization';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
import {
  createJitoMemorySignatureRecovery,
  type JitoOperationToken,
} from '@/lib/jito-memory-signature-recovery';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import { JitoMemoryRecovery } from './jito-memory-recovery';

async function checkedRecord(
  value: JitoBundleRecord,
  projectId: string,
  session: TradeSession,
) {
  if (
    !value ||
    ![
      'reviewed',
      'submitting',
      'submitted',
      'finalized',
      'cancelled',
      'expired',
    ].includes(value.state) ||
    value.manifest.projectId !== projectId ||
    value.manifest.sessionId !== session.id ||
    !Array.isArray(value.signatures) ||
    value.signatures.length !== value.manifest.swaps.length + 1 ||
    value.signatures.some(
      (s) =>
        s !== null &&
        (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)),
    ) ||
    (value.bundleId !== null && !/^[a-f0-9]{64}$/.test(value.bundleId))
  )
    throw new Error('Returned bundle context differs.');
  await requireJitoManifest(value.manifest, false);
  if (value.finalization) {
    if (value.state !== 'finalized')
      throw new Error('Finalization state differs.');
    await requireJitoFinalization(
      value.finalization,
      value.manifest,
      value.signatures,
    );
  }
  return value;
}
type JitoAtomicBundleProps = {
  projectId: string;
  session: TradeSession;
  locked: boolean;
};
const auth = createAuthClient();
function manifestExpired(manifest: JitoBundleManifest) {
  return Date.parse(manifest.expiresAt) <= Date.now();
}
export function JitoAtomicBundle(props: JitoAtomicBundleProps) {
  const { data, isPending } = auth.useSession();
  const owner =
    !isPending && typeof data?.user?.id === 'string' ? data.user.id : null;
  const [verifiedScope, setVerifiedScope] = useState<{
    owner: string;
    value: string;
  } | null>(null);
  const [memoryRevision, setMemoryRevision] = useState(0);
  const [, setOperationRevision] = useState(0);
  const [coordinator] = useState(createJitoMemorySignatureRecovery);
  const contextKey = JSON.stringify([props, owner, isPending]);
  useEffect(() => {
    return coordinator.subscribe(() => setMemoryRevision((value) => value + 1));
  }, [coordinator]);
  useEffect(() => {
    return coordinator.subscribeOperations(() =>
      setOperationRevision((value) => value + 1),
    );
  }, [coordinator]);
  useEffect(() => {
    let active = true;
    if (owner)
      void jitoOwnerScope(owner)
        .then((value) => {
          if (active) setVerifiedScope({ owner, value });
        })
        .catch(() => {
          if (active) setVerifiedScope(null);
        });
    return () => {
      active = false;
    };
  }, [owner, isPending]);
  const ownerScope =
    owner && verifiedScope?.owner === owner && !isPending
      ? verifiedScope.value
      : null;
  return (
    <JitoAtomicBundleForContext
      key={contextKey}
      {...props}
      ownerScope={ownerScope}
      identityPending={isPending || Boolean(owner && !ownerScope)}
      coordinator={coordinator}
      memoryRevision={memoryRevision}
    />
  );
}
function JitoAtomicBundleForContext({
  projectId,
  session,
  locked,
  ownerScope,
  identityPending,
  coordinator,
  memoryRevision,
}: JitoAtomicBundleProps & {
  ownerScope: string | null;
  identityPending: boolean;
  coordinator: ReturnType<typeof createJitoMemorySignatureRecovery>;
  memoryRevision: number;
}) {
  const tipId = useId();
  const [eligible, setEligible] = useState<WarmupSigningReview[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [entries, setEntries] = useState<number[]>([]),
    [tip, setTip] = useState('1000'),
    [bundles, setBundles] = useState<JitoBundleRecord[]>([]),
    [acceptedSubmit, setAcceptedSubmit] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(() => Date.now()),
    [historyVerified, setHistoryVerified] = useState(false);
  const mounted = useRef(true),
    running = useRef(false),
    abort = useRef<AbortController | null>(null);
  const isContextCurrent = useCallback(() => mounted.current, []);
  useLayoutEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      abort.current?.abort();
      clearInterval(timer);
    };
  }, []);
  async function request(body?: object, bundleId?: string, timeoutMs = 60000) {
    if (!mounted.current || !isContextCurrent())
      throw new Error('Bundle context changed. Reload saved history.');
    if (!ownerScope)
      throw new Error(
        'Sign in and reload bundle history to verify the current account.',
      );
    const controller = new AbortController();
    abort.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    let response: Response;
    try {
      response = await fetch(
        body
          ? '/api/imported-projects/jito-bundles'
          : `/api/imported-projects/jito-bundles?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(session.id)}${bundleId ? `&bundleId=${encodeURIComponent(bundleId)}` : ''}`,
        {
          ...(body
            ? {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  [JITO_OWNER_SCOPE_HEADER]: ownerScope,
                },
                body: JSON.stringify(body),
              }
            : { headers: { [JITO_OWNER_SCOPE_HEADER]: ownerScope } }),
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          signal,
        },
      );
    } catch {
      throw new Error(
        'Bundle response unavailable. Reload saved history before another action.',
      );
    }
    const invalidateHistory = (reason: string) => {
      if (mounted.current && isContextCurrent()) {
        setHistoryVerified(false);
        setBundles([]);
        setEligible([]);
        setAcceptedSubmit(null);
        setError(reason);
      }
    };
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      invalidateHistory('Sign in to recover saved bundles.');
      throw new Error('Sign in to recover saved bundles.');
    }
    if (response.headers.get(JITO_OWNER_SCOPE_HEADER) !== ownerScope) {
      void response.body?.cancel().catch(() => {});
      invalidateHistory('Signed-in account changed. Reload bundle history.');
      throw new Error('Signed-in account changed. Reload bundle history.');
    }
    let value: unknown;
    try {
      value = await readBoundedPanelJson(response, signal);
    } catch {
      throw new Error(
        'Bundle response unavailable. Reload saved history before another action.',
      );
    }
    if (!mounted.current || !isContextCurrent() || signal.aborted)
      throw new Error('Bundle context changed. Reload saved history.');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Bundle response unavailable. Reload saved history.');
    const data = value as {
      error?: string;
      bundle?: JitoBundleRecord;
      bundles?: JitoBundleRecord[];
      eligible?: WarmupSigningReview[];
      projectId?: string;
      sessionId?: string;
    };
    if (!response.ok)
      throw new Error(data.error || 'Bundle operation unavailable.');
    return data;
  }
  async function action(
    body?: object,
    expectedRegistration?: {
      id: string;
      digest: string;
      packet: number;
      signature: string;
    },
    signingOperation?: JitoOperationToken,
  ) {
    if (!mounted.current || !isContextCurrent())
      throw new Error('Bundle context changed. Reload saved history.');
    if (running.current)
      throw new Error('Wait for the current bundle operation.');
    let mutationOperation: JitoOperationToken | null = null;
    if (body) {
      if (!ownerScope) throw new Error('Sign in to review Jito bundles.');
      const payload = body as {
        action?: unknown;
        id?: unknown;
        packet?: unknown;
      };
      if (
        (payload.action === 'cancel' || payload.action === 'submit') &&
        coordinator
          .pending(ownerScope, projectId, session.id)
          .some((item) => item.bundleId === payload.id)
      )
        throw new Error('A Jito signing outcome is still pending.');
      if (signingOperation) {
        if (
          payload.action !== 'register' ||
          !expectedRegistration ||
          payload.id !== expectedRegistration.id ||
          payload.packet !== expectedRegistration.packet
        )
          throw new Error('Jito signing operation context differs.');
        coordinator.requireRegistration(
          signingOperation,
          ownerScope,
          expectedRegistration.id,
          expectedRegistration.packet,
        );
      } else {
        mutationOperation = coordinator.startOperation(ownerScope);
      }
    }
    running.current = true;
    setBusy(true);
    setError('');
    setAcceptedSubmit(null);
    if (!body) setHistoryVerified(false);
    const submission = body as { action?: unknown; id?: unknown } | undefined;
    if (submission?.action === 'submit')
      setBundles((prior) =>
        prior.map((bundle) =>
          bundle.manifest.id === submission.id
            ? { ...bundle, state: 'submitting' }
            : bundle,
        ),
      );
    try {
      const data = await request(body);
      if (data.bundle) {
        const bundle = await checkedRecord(data.bundle, projectId, session);
        if (
          expectedRegistration &&
          (bundle.manifest.id !== expectedRegistration.id ||
            bundle.manifest.sha256 !== expectedRegistration.digest ||
            bundle.signatures[expectedRegistration.packet] !==
              expectedRegistration.signature)
        )
          throw new Error(
            'Signature registration did not match. Reload saved history.',
          );
        if (mounted.current && isContextCurrent()) {
          setBundles((prior) =>
            [
              bundle,
              ...prior.filter((b) => b.manifest.id !== bundle.manifest.id),
            ].slice(0, 20),
          );
          setAcceptedSubmit(null);
        }
        return bundle;
      } else {
        if (
          data.projectId !== projectId ||
          data.sessionId !== session.id ||
          !Array.isArray(data.bundles) ||
          data.bundles.length > 20 ||
          !Array.isArray(data.eligible) ||
          data.eligible.length > 25
        )
          throw new Error('Session bundle history differs.');
        const checked = await Promise.all(
          data.bundles.map((b) => checkedRecord(b, projectId, session)),
        );
        if (
          data.eligible.some(
            (r) =>
              !r.session ||
              r.session.sessionId !== session.id ||
              r.session.sessionRevision !== session.revision ||
              !session.terms.entries.some(
                (e) =>
                  e.entry === r.session!.entry &&
                  e.wallet === r.wallet &&
                  e.unitsRaw === r.inputRaw,
              ),
          )
        )
          throw new Error('Available approval terms differ.');
        if (mounted.current && isContextCurrent()) {
          setBundles(checked);
          setEligible(data.eligible);
          setSelected([]);
          setAcceptedSubmit(null);
          setHistoryVerified(true);
        }
      }
    } catch (e) {
      if (mounted.current && isContextCurrent())
        setError(
          e instanceof Error ? e.message : 'Bundle operation unavailable.',
        );
      throw e;
    } finally {
      if (mutationOperation) coordinator.finishOperation(mutationOperation);
      running.current = false;
      if (mounted.current && isContextCurrent()) setBusy(false);
    }
  }
  const run = (body?: object) => {
    void action(body).catch(() => {});
  };
  async function readExactBundle(id: string) {
    const data = await request(undefined, id, 5000);
    if (
      data.projectId !== projectId ||
      data.sessionId !== session.id ||
      !data.bundle
    )
      throw new Error('Original bundle unavailable.');
    const record = await checkedRecord(data.bundle, projectId, session);
    if (!isContextCurrent() || record.manifest.id !== id)
      throw new Error('Original bundle changed.');
    return record;
  }
  async function beforePacketSign(
    manifest: JitoBundleManifest,
    packet: number,
  ) {
    const record = await readExactBundle(manifest.id);
    if (
      !isContextCurrent() ||
      locked ||
      session.state !== 'active' ||
      session.revision !== manifest.sessionRevision ||
      manifestExpired(manifest) ||
      record.state !== 'reviewed' ||
      record.manifest.sha256 !== manifest.sha256 ||
      record.signatures[packet] !== null
    )
      throw new Error(
        'Bundle approval or signed-in account changed. Reload saved history.',
      );
  }
  async function beforePacketImport(
    manifest: JitoBundleManifest,
    packet: number,
  ) {
    const record = await readExactBundle(manifest.id);
    if (
      !isContextCurrent() ||
      record.state !== 'reviewed' ||
      record.manifest.sha256 !== manifest.sha256 ||
      record.signatures[packet] !== null
    )
      throw new Error('Bundle changed. Reload saved history before importing.');
  }
  async function loadOriginal(id: string) {
    if (running.current || !historyVerified) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const record = await readExactBundle(id);
      if (!isContextCurrent()) throw Error('Bundle context changed.');
      setBundles((prior) =>
        [record, ...prior.filter((item) => item.manifest.id !== id)].slice(
          0,
          20,
        ),
      );
    } catch {
      if (isContextCurrent())
        setError('Original saved bundle unavailable. Reload history.');
    } finally {
      running.current = false;
      if (isContextCurrent()) setBusy(false);
    }
  }
  async function registerPacket(
    manifest: JitoBundleManifest,
    packet: number,
    transaction: string,
    signingOperation?: JitoOperationToken,
  ) {
    if (!ownerScope || !isContextCurrent() || manifestExpired(manifest))
      throw new Error(
        'Signed-in account or bundle changed. Reload saved history.',
      );
    const checked = await createJitoPacketRecovery(
      manifest,
      packet,
      transaction,
    );
    if (!isContextCurrent() || manifestExpired(manifest))
      throw new Error(
        'Signed-in account or bundle changed. Reload saved history.',
      );
    const record = await action(
      {
        action: 'register',
        id: manifest.id,
        sha256: manifest.sha256,
        approved: true,
        packet,
        transaction,
      },
      {
        id: manifest.id,
        digest: manifest.sha256,
        packet,
        signature: checked.signature,
      },
      signingOperation,
    );
    if (
      !isContextCurrent() ||
      !record ||
      record.manifest.sha256 !== manifest.sha256 ||
      record.manifest.id !== manifest.id ||
      record.signatures[packet] !== checked.signature
    )
      throw new Error(
        'Signature registration did not match. Reload saved history.',
      );
    const retained = await coordinator.inspect(ownerScope, manifest, packet);
    if (!isContextCurrent())
      throw new Error(
        'Signed-in account or bundle changed. Reload saved history.',
      );
    if (retained.status === 'retained') {
      if (retained.signature !== checked.signature)
        throw new Error('Retained signature differs.');
      await coordinator.acknowledge(
        ownerScope,
        manifest,
        packet,
        checked.signature,
        () => {
          if (!isContextCurrent())
            throw new Error('Signed-in account or bundle changed.');
        },
      );
    }
  }
  return (
    <details className="space-y-3 rounded-md border p-3">
      <summary>Jito atomic bundle · up to 4 wallet swaps</summary>
      <section
        aria-label="Jito atomic bundle"
        className="min-w-0 space-y-3 break-words"
      >
        {!ownerScope && (
          <output>
            {identityPending
              ? 'Checking the signed-in account…'
              : 'Sign in and reload bundle history to verify the current account.'}
          </output>
        )}
        <p>
          Signed-packet recovery remains only in memory while this bundle panel
          stays mounted. Closing or reloading the page may lose it. If the
          signature cannot be verified, it cannot be recovered here.
        </p>
        <p>
          Choose one to four due session entries, prepare fresh swaps together,
          then review the complete bundle before signing. The final transaction
          pays the tip from the first wallet. Larger sessions need smaller
          explicit selections; they are not one atomic bundle.
        </p>
        <p>
          Jito executes a landed bundle in order within one slot. Acceptance
          does not guarantee landing. Individual simulations do not predict the
          effects of earlier swaps. Reorgs or rebroadcasts can break bundle
          isolation, so atomicity is not an unconditional guarantee. The app
          never falls back to individual submission or automatically retries a
          bundle.
        </p>
        <TransactionDeliveryNotice transport="jito-bundle" />
        {coordinator.operationActive() && (
          <p>Another Jito action is in progress.</p>
        )}
        <Button
          disabled={busy || !ownerScope}
          variant="outline"
          onClick={() => run()}
        >
          Load bundle approvals and history
        </Button>
        {historyVerified &&
          ownerScope &&
          coordinator
            .pending(ownerScope, projectId, session.id)
            .filter(
              (item) =>
                !bundles.some((bundle) => bundle.manifest.id === item.bundleId),
            )
            .map((item) => (
              <Button
                key={`${item.bundleId}:${item.packet}`}
                disabled={busy}
                variant="outline"
                onClick={() => void loadOriginal(item.bundleId)}
              >
                Load original bundle {item.bundleId}, packet {item.packet + 1}
              </Button>
            ))}
        {session.terms.entries.map((e) => (
          <label key={e.entry} className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={entries.includes(e.entry)}
              disabled={
                busy ||
                locked ||
                (!entries.includes(e.entry) && entries.length >= 4)
              }
              onChange={(event) =>
                setEntries((prior) =>
                  event.target.checked
                    ? [...prior, e.entry]
                    : prior.filter((n) => n !== e.entry),
                )
              }
            />
            <span className="min-w-0 flex-1 break-words">
              Session entry {e.entry}: {e.wallet}, {e.amount}{' '}
              {session.terms.side === 'Buy' ? 'SOL' : 'tokens'} input.
            </span>
          </label>
        ))}
        {eligible.map((r) => (
          <label key={r.id} className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={selected.includes(r.id)}
              disabled={
                busy ||
                locked ||
                (!selected.includes(r.id) && selected.length >= 4)
              }
              onChange={(e) =>
                setSelected((prior) =>
                  e.target.checked
                    ? [...prior, r.id]
                    : prior.filter((id) => id !== r.id),
                )
              }
            />
            <span className="min-w-0 flex-1 break-words">
              Entry {r.session!.entry}: {r.wallet}. Input {r.inputRaw} atomic
              units, minimum output {r.minimumOutputRaw}. Expires {r.expiresAt}.
            </span>
          </label>
        ))}
        <label className="block" htmlFor={tipId}>
          Jito tip (lamports)
        </label>
        <Input
          id={tipId}
          type="text"
          inputMode="numeric"
          value={tip}
          disabled={busy || locked}
          onChange={(e) => setTip(e.target.value)}
        />
        <Button
          disabled={
            busy ||
            coordinator.operationActive() ||
            locked ||
            session.state !== 'active' ||
            !entries.length
          }
          onClick={() =>
            run({
              action: 'prepare',
              projectId,
              sessionId: session.id,
              sessionRevision: session.revision,
              entries,
              tipLamports: tip,
            })
          }
        >
          Prepare and review selected Jito swaps
        </Button>
        <Button
          disabled={
            busy ||
            coordinator.operationActive() ||
            locked ||
            session.state !== 'active' ||
            !selected.length
          }
          onClick={() => {
            try {
              jitoIntentSelection(selected);
              run({
                action: 'create',
                projectId,
                sessionId: session.id,
                sessionRevision: session.revision,
                intentIds: selected,
                tipLamports: tip,
              });
            } catch (e) {
              setError(
                e instanceof Error ? e.message : 'Choose bundle entries.',
              );
            }
          }}
        >
          Review complete Jito bundle
        </Button>
        {error && <p role="alert">{error}</p>}
        {bundles.map((bundle) => {
          const m = bundle.manifest,
            expired = Date.parse(m.expiresAt) <= now;
          const canRegister =
            Boolean(ownerScope) &&
            !coordinator.operationActive() &&
            !busy &&
            !locked &&
            session.state === 'active' &&
            m.sessionRevision === session.revision &&
            bundle.state === 'reviewed' &&
            !expired;
          const hasPendingPacket =
            Boolean(ownerScope) &&
            Array.from({ length: m.swaps.length + 1 }, (_, packet) =>
              coordinator.has(ownerScope!, m.id, packet),
            ).some(Boolean);
          const canSign = canRegister && !hasPendingPacket;
          const complete = bundle.signatures.every(Boolean);
          return (
            <article key={m.id} className="space-y-3 rounded-md border p-3">
              <h5>Bundle {m.id}</h5>
              <JitoBundleTimeline bundle={bundle} />
              <JitoSequentialCheck
                key={m.sha256}
                manifest={m}
                ownerScope={ownerScope ?? ''}
                disabled={!canSign || bundle.signatures.some(Boolean)}
              />
              <p>
                State: {bundle.state}.{' '}
                {bundle.signatures.filter(Boolean).length}/
                {bundle.signatures.length} signed packets. Approval expires{' '}
                {m.expiresAt}.
              </p>
              {bundle.state === 'submitting' && (
                <p>
                  Submission outcome unknown. The transport attempt was reserved
                  before sending. Check chain outcomes; do not submit again.
                </p>
              )}
              {bundle.state === 'submitted' && (
                <p>
                  Accepted by Jito. Finalized chain outcomes have not yet been
                  established.
                </p>
              )}
              {bundle.state === 'finalized' && (
                <p>
                  {bundle.finalization ? (
                    <>
                      Exact signed packets finalized successfully in slot{' '}
                      {bundle.finalization.slot}. Receipt fingerprint:{' '}
                      <code>{bundle.finalization.sha256}</code>. Observed{' '}
                      <time dateTime={bundle.finalization.observedAt}>
                        {bundle.finalization.observedAt}
                      </time>
                      . Swap receipts were saved.
                    </>
                  ) : (
                    'Finalized state was recorded earlier; the additional finalization receipt was not retained.'
                  )}
                </p>
              )}
              {bundle.state === 'expired' && (
                <p>
                  All packet validity windows ended at the finalized chain
                  height, with no outcome found by the configured RPC. This is
                  an expiry observation, not a guarantee of complete historical
                  coverage.
                </p>
              )}
              <p>
                Complete bundle fingerprint: <code>{m.sha256}</code>.
              </p>
              <ol>
                {m.swaps.map((s, i) => (
                  <li key={s.id}>
                    Entry {s.session!.entry}, wallet <code>{s.wallet}</code>.{' '}
                    {s.inputRaw} units of <code>{s.inputMint}</code> → at least{' '}
                    {s.minimumOutputRaw} units of <code>{s.outputMint}</code>.
                    Network fee {s.maximumFeeLamports} lamports; maximum native
                    debit {s.settlement?.maximumNativeDebitLamports}, including
                    rent/wrapping.{' '}
                    {bundle.signatures[i] && (
                      <span>
                        Signed: <code>{bundle.signatures[i]}</code>.
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              <p>
                Final transaction: tip {formatNativeBalance(m.tip.amountRaw, 9)}{' '}
                SOL ({m.tip.amountRaw} lamports), plus at most{' '}
                {m.tip.feeLamports} lamports network fee. Payer{' '}
                <code>{m.tip.wallet}</code>, recipient{' '}
                <code>{m.tip.recipient}</code>. Tip packet fingerprint{' '}
                <code>{m.tip.sha256}</code>.
              </p>
              {bundle.bundleId && (
                <p>
                  Jito bundle ID: <code>{bundle.bundleId}</code>.
                </p>
              )}
              {historyVerified &&
                ownerScope &&
                Array.from({ length: m.swaps.length + 1 }, (_, packet) =>
                  coordinator.has(ownerScope, m.id, packet) ? (
                    <JitoMemoryRecovery
                      key={`${m.id}:memory:${packet}:${memoryRevision}:${bundle.signatures[packet] ?? ''}`}
                      ownerScope={ownerScope}
                      manifest={m}
                      packet={packet}
                      coordinator={coordinator}
                      revision={memoryRevision}
                      registrationAllowed={
                        canRegister && !bundle.signatures[packet]
                      }
                      serverSignature={bundle.signatures[packet]}
                      isContextCurrent={isContextCurrent}
                      register={(transaction) =>
                        registerPacket(m, packet, transaction)
                      }
                    />
                  ) : null,
                )}
              {bundle.state === 'reviewed' &&
                m.swaps
                  .concat([])
                  .map((_, i) =>
                    bundle.signatures[i] ? null : (
                      <JitoPacketSigning
                        key={`${m.id}:${i}`}
                        manifest={m}
                        packet={i}
                        disabled={
                          !canSign ||
                          Boolean(
                            ownerScope && coordinator.has(ownerScope, m.id, i),
                          )
                        }
                        ownerScope={ownerScope!}
                        coordinator={coordinator}
                        isContextCurrent={isContextCurrent}
                        beforeSign={() => beforePacketSign(m, i)}
                        beforeImport={() => beforePacketImport(m, i)}
                        recoveryDisabled={
                          !ownerScope ||
                          !historyVerified ||
                          busy ||
                          coordinator.operationActive() ||
                          Boolean(
                            ownerScope && coordinator.has(ownerScope, m.id, i),
                          )
                        }
                        register={(transaction, token) =>
                          registerPacket(m, i, transaction, token)
                        }
                      />
                    ),
                  )}
              {bundle.state === 'reviewed' && !bundle.signatures.at(-1) && (
                <JitoPacketSigning
                  key={`${m.id}:tip`}
                  manifest={m}
                  packet={m.swaps.length}
                  disabled={
                    !canSign ||
                    Boolean(
                      ownerScope &&
                      coordinator.has(ownerScope, m.id, m.swaps.length),
                    )
                  }
                  ownerScope={ownerScope!}
                  coordinator={coordinator}
                  isContextCurrent={isContextCurrent}
                  beforeSign={() => beforePacketSign(m, m.swaps.length)}
                  beforeImport={() => beforePacketImport(m, m.swaps.length)}
                  recoveryDisabled={
                    !ownerScope ||
                    !historyVerified ||
                    busy ||
                    coordinator.operationActive() ||
                    Boolean(
                      ownerScope &&
                      coordinator.has(ownerScope, m.id, m.swaps.length),
                    )
                  }
                  register={(transaction, token) =>
                    registerPacket(m, m.swaps.length, transaction, token)
                  }
                />
              )}
              {bundle.state === 'reviewed' && complete && (
                <>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={acceptedSubmit === m.id}
                      disabled={!canSign}
                      onChange={(e) =>
                        setAcceptedSubmit(e.target.checked ? m.id : null)
                      }
                    />
                    I approve submitting all {bundle.signatures.length} exact
                    signed transactions in this order, including the displayed
                    tip.
                  </label>
                  <Button
                    disabled={!canSign || acceptedSubmit !== m.id}
                    onClick={() =>
                      run({
                        action: 'submit',
                        id: m.id,
                        sha256: m.sha256,
                        approved: true,
                      })
                    }
                  >
                    Submit complete Jito bundle
                  </Button>
                </>
              )}
              {bundle.signatures.some(Boolean) &&
                !['finalized', 'cancelled', 'expired'].includes(
                  bundle.state,
                ) && (
                  <Button
                    disabled={busy || coordinator.operationActive()}
                    variant="outline"
                    onClick={() => run({ action: 'recover', id: m.id })}
                  >
                    Check chain outcomes
                  </Button>
                )}
              {!bundle.signatures.some(Boolean) &&
                bundle.state === 'reviewed' && (
                  <Button
                    disabled={
                      busy ||
                      coordinator.operationActive() ||
                      Boolean(
                        ownerScope &&
                        Array.from(
                          { length: m.swaps.length + 1 },
                          (_, packet) =>
                            coordinator.has(ownerScope, m.id, packet),
                        ).some(Boolean),
                      )
                    }
                    variant="outline"
                    onClick={() => run({ action: 'cancel', id: m.id })}
                  >
                    Cancel unsigned bundle
                  </Button>
                )}
            </article>
          );
        })}
      </section>
    </details>
  );
}
