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
import {
  listJitoRecoveryJournalPending,
  withJitoRecoveryJournalLock,
} from '@/lib/jito-recovery-journal';
import {
  requireJitoV2Snapshot,
  type JitoV2Snapshot,
} from '@/lib/jito-v2-snapshot';
import { JitoMemoryRecovery } from './jito-memory-recovery';
import { JitoTerminalRecoveryImport } from './jito-terminal-recovery-import';
import { JitoRecoveryFileV2 } from './jito-recovery-file-v2';
import { JitoRecoveryLocatorV2 } from './jito-recovery-locator-v2';
import { JitoChainObservationView } from './jito-chain-observation';
import {
  requireJitoChainObservation,
  type JitoChainObservation,
} from '@/lib/jito-chain-observation';

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
      ownerId={owner}
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
  ownerId,
  identityPending,
  coordinator,
  memoryRevision,
}: JitoAtomicBundleProps & {
  ownerScope: string | null;
  ownerId: string | null;
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
    [historyVerified, setHistoryVerified] = useState(false),
    [openedBundleId, setOpenedBundleId] = useState<string | null>(null),
    [located, setLocated] = useState<{
      record: JitoBundleRecord;
      snapshot: JitoV2Snapshot | null;
    } | null>(null),
    [chainObservation, setChainObservation] =
      useState<JitoChainObservation | null>(null),
    [snapshots, setSnapshots] = useState<Record<string, JitoV2Snapshot>>({});
  const mounted = useRef(true),
    running = useRef(false),
    historyVerifiedNow = useRef(false),
    historyRecordsNow = useRef<JitoBundleRecord[]>([]),
    abort = useRef<AbortController | null>(null),
    snapshotGeneration = useRef(new Map<string, number>()),
    snapshotEpoch = useRef(0),
    snapshotsNow = useRef<Record<string, JitoV2Snapshot>>({}),
    locatedNow = useRef<{
      record: JitoBundleRecord;
      snapshot: JitoV2Snapshot | null;
    } | null>(null);
  const isContextCurrent = useCallback(() => mounted.current, []);
  const invalidatePendingSnapshots = useCallback(() => {
    snapshotEpoch.current++;
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      invalidatePendingSnapshots();
      historyVerifiedNow.current = false;
      historyRecordsNow.current = [];
      abort.current?.abort();
      snapshotsNow.current = {};
      locatedNow.current = null;
      clearInterval(timer);
    };
  }, [invalidatePendingSnapshots]);
  async function request(
    body?: object,
    bundleId?: string,
    timeoutMs = 60000,
    outerSignal?: AbortSignal,
  ) {
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
      ...(outerSignal ? [outerSignal] : []),
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
                  'x-jito-protocol': '2',
                  [JITO_OWNER_SCOPE_HEADER]: ownerScope,
                },
                body: JSON.stringify(body),
              }
            : {
                headers: {
                  [JITO_OWNER_SCOPE_HEADER]: ownerScope,
                  'x-jito-protocol': '2',
                },
              }),
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
        historyVerifiedNow.current = false;
        historyRecordsNow.current = [];
        setBundles([]);
        setEligible([]);
        setAcceptedSubmit(null);
        setLocated(null);
        setOpenedBundleId(null);
        locatedNow.current = null;
        setChainObservation(null);
        setSnapshots({});
        snapshotsNow.current = {};
        snapshotEpoch.current++;
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
      chainObservation?: unknown;
      attempts?: unknown;
      legacyReadOnly?: unknown;
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
    snapshotEpoch.current++;
    snapshotsNow.current = {};
    setSnapshots({});
    if (locatedNow.current) {
      locatedNow.current = { ...locatedNow.current, snapshot: null };
      setLocated(locatedNow.current);
    }
    setBusy(true);
    setError('');
    setAcceptedSubmit(null);
    setChainObservation(null);
    if (!body) {
      historyVerifiedNow.current = false;
      historyRecordsNow.current = [];
      setHistoryVerified(false);
    }
    const submission = body as { action?: unknown; id?: unknown } | undefined;
    if (submission?.action === 'submit') {
      setBundles((prior) =>
        prior.map((bundle) =>
          bundle.manifest.id === submission.id
            ? { ...bundle, state: 'submitting' }
            : bundle,
        ),
      );
      const currentLocated = locatedNow.current;
      if (
        currentLocated &&
        currentLocated.record.manifest.id === submission.id
      ) {
        locatedNow.current = {
          record: { ...currentLocated.record, state: 'submitting' },
          snapshot: null,
        };
        setLocated(locatedNow.current);
      }
    }
    try {
      const guardedAction =
        submission &&
        ['prepare', 'create', 'cancel', 'submit'].includes(
          String(submission.action),
        );
      const data = guardedAction
        ? await withJitoRecoveryJournalLock(
            ownerScope!,
            () => {
              if (!isContextCurrent())
                throw new Error('Bundle context changed.');
            },
            async (journalLock) => {
              const displayed =
                typeof submission.id === 'string'
                  ? (historyRecordsNow.current.find(
                      (item) => item.manifest.id === submission.id,
                    ) ??
                    (locatedNow.current?.record.manifest.id === submission.id
                      ? locatedNow.current.record
                      : undefined))
                  : undefined;
              if (
                ['cancel', 'submit'].includes(String(submission.action)) &&
                !displayed
              )
                throw new Error('Reload bundle history before this action.');
              const pending = await listJitoRecoveryJournalPending(
                journalLock,
                projectId,
                session.id,
                async () => {
                  if (displayed) {
                    const fresh = await readExactSnapshot(
                      displayed.manifest.id,
                      displayed.manifest.sha256,
                    );
                    if (
                      fresh.legacyReadOnly ||
                      fresh.attempts.some((item) => item.state === 'unknown') ||
                      fresh.bundle.state !== 'reviewed' ||
                      JSON.stringify(fresh.bundle.signatures) !==
                        JSON.stringify(displayed.signatures)
                    )
                      throw new Error(
                        'Bundle signing outcome requires recovery.',
                      );
                  } else {
                    const fresh = await request();
                    if (
                      fresh.projectId !== projectId ||
                      fresh.sessionId !== session.id
                    )
                      throw new Error('Bundle account or session differs.');
                  }
                  return ownerScope!;
                },
              );
              if (
                pending.some(
                  (item) =>
                    !displayed || item.bundleId === displayed.manifest.id,
                )
              )
                throw new Error('A Jito signing outcome is still pending.');
              return request(body);
            },
          )
        : await request(body);
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
          const payload = body as
            | { action?: unknown; id?: unknown }
            | undefined;
          if (payload?.action === 'recover') {
            if (payload.id !== bundle.manifest.id)
              throw Error('Bundle recovery context differs.');
            if (data.chainObservation !== undefined) {
              try {
                setChainObservation(
                  requireJitoChainObservation(data.chainObservation, bundle),
                );
              } catch {
                setError(
                  'Provider outcome details were unavailable. Check retained status before another action.',
                );
              }
            } else if (
              ['reviewed', 'submitting', 'submitted'].includes(bundle.state) &&
              bundle.signatures.some(Boolean)
            ) {
              setError(
                'Provider outcome details were unavailable. Check retained status before another action.',
              );
            }
          }
          const isLocated =
            locatedNow.current?.record.manifest.id === bundle.manifest.id &&
            !historyRecordsNow.current.some(
              (item) => item.manifest.id === bundle.manifest.id,
            );
          if (isLocated) {
            locatedNow.current = { record: bundle, snapshot: null };
            setLocated(locatedNow.current);
          } else if (historyVerifiedNow.current)
            historyRecordsNow.current = [
              bundle,
              ...historyRecordsNow.current.filter(
                (item) => item.manifest.id !== bundle.manifest.id,
              ),
            ].slice(0, 20);
          if (!isLocated)
            setBundles((prior) =>
              [
                bundle,
                ...prior.filter((b) => b.manifest.id !== bundle.manifest.id),
              ].slice(0, 20),
            );
          setAcceptedSubmit(null);
        }
        await readExactSnapshot(bundle.manifest.id, bundle.manifest.sha256);
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
          new Set(checked.map((bundle) => bundle.manifest.id)).size !==
          checked.length
        )
          throw new Error('Session bundle history differs.');
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
          historyRecordsNow.current = checked;
          setBundles(checked);
          setEligible(data.eligible);
          setSelected([]);
          setAcceptedSubmit(null);
          historyVerifiedNow.current = true;
          setHistoryVerified(true);
        }
        const older = locatedNow.current?.record;
        const additional =
          older &&
          !checked.some((item) => item.manifest.id === older.manifest.id)
            ? [older]
            : [];
        const reads = await Promise.allSettled(
          [...checked, ...additional].map((b) =>
            readExactSnapshot(b.manifest.id, b.manifest.sha256),
          ),
        );
        if (reads.some((r) => r.status === 'rejected') && isContextCurrent())
          setError(
            'Some bundle details could not be verified. Reload history before acting.',
          );
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
    if (mounted.current && isContextCurrent()) setChainObservation(null);
    return (await readExactSnapshot(id)).bundle;
  }
  async function readExactSnapshot(id: string, expectedDigest?: string) {
    if (!ownerScope || !ownerId || !isContextCurrent())
      throw new Error('Sign in to review this bundle.');
    const signal = AbortSignal.timeout(5000);
    const generation = (snapshotGeneration.current.get(id) ?? 0) + 1;
    const epoch = snapshotEpoch.current;
    snapshotGeneration.current.set(id, generation);
    const isOlder =
      locatedNow.current?.record.manifest.id === id &&
      !historyRecordsNow.current.some((record) => record.manifest.id === id);
    if (isOlder && locatedNow.current) {
      locatedNow.current = { ...locatedNow.current, snapshot: null };
      setLocated(locatedNow.current);
    } else {
      const next = { ...snapshotsNow.current };
      delete next[id];
      snapshotsNow.current = next;
      setSnapshots(next);
    }
    const data = await request(undefined, id, 5000, signal);
    signal.throwIfAborted();
    if (
      data.projectId !== projectId ||
      data.sessionId !== session.id ||
      !data.bundle
    )
      throw new Error('Original bundle unavailable.');
    const record = await checkedRecord(data.bundle, projectId, session);
    signal.throwIfAborted();
    if (!isContextCurrent() || record.manifest.id !== id)
      throw new Error('Original bundle changed.');
    const digest =
      expectedDigest ??
      historyRecordsNow.current.find((r) => r.manifest.id === id)?.manifest
        .sha256 ??
      record.manifest.sha256;
    const snapshot = await requireJitoV2Snapshot(data, {
      ownerId,
      responseOwnerScope: ownerScope,
      projectId,
      sessionId: session.id,
      bundleId: id,
      manifestSha256: digest,
    });
    signal.throwIfAborted();
    for (const attempt of snapshot.attempts) {
      if (attempt.state === 'registered') {
        const verified = await createJitoPacketRecovery(
          snapshot.bundle.manifest,
          attempt.packet,
          attempt.transaction!,
        );
        signal.throwIfAborted();
        if (verified.signature !== attempt.signature)
          throw new Error('Bundle attempt receipt differs.');
      }
    }
    if (
      signal.aborted ||
      !isContextCurrent() ||
      snapshotEpoch.current !== epoch ||
      snapshotGeneration.current.get(id) !== generation
    )
      throw new Error('Bundle context changed. Reload saved history.');
    if (isOlder && locatedNow.current?.record.manifest.id === id) {
      locatedNow.current = { record: snapshot.bundle, snapshot };
      setLocated(locatedNow.current);
    } else {
      snapshotsNow.current = { ...snapshotsNow.current, [id]: snapshot };
      setSnapshots(snapshotsNow.current);
    }
    return snapshot;
  }
  async function beforePacketSign(
    manifest: JitoBundleManifest,
    packet: number,
    attemptId: string,
  ) {
    const snapshot = await readExactSnapshot(manifest.id, manifest.sha256);
    const record = snapshot.bundle;
    const pending = snapshot.attempts.filter((a) => a.state === 'unknown');
    if (
      !isContextCurrent() ||
      locked ||
      session.state !== 'active' ||
      session.revision !== manifest.sessionRevision ||
      manifestExpired(manifest) ||
      record.state !== 'reviewed' ||
      record.manifest.sha256 !== manifest.sha256 ||
      record.signatures[packet] !== null ||
      snapshot.legacyReadOnly ||
      pending.length !== 1 ||
      pending[0].packet !== packet ||
      pending[0].attemptId !== attemptId
    )
      throw new Error(
        'Bundle approval or signed-in account changed. Reload saved history.',
      );
  }
  async function terminalPacketSignature(
    manifest: JitoBundleManifest,
    packet: number,
    state: 'cancelled' | 'expired',
  ) {
    const record = await readExactBundle(manifest.id);
    if (
      !isContextCurrent() ||
      record.state !== state ||
      record.manifest.sha256 !== manifest.sha256 ||
      !Number.isInteger(packet) ||
      packet < 0 ||
      packet >= record.signatures.length
    )
      throw new Error('Bundle changed. Reload saved history before recovery.');
    return record.signatures[packet];
  }
  async function loadOriginal(id: string) {
    if (running.current || !historyVerified) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const snapshot = await readExactSnapshot(id);
      const record = snapshot.bundle;
      if (!isContextCurrent()) throw Error('Bundle context changed.');
      if (!historyRecordsNow.current.some((item) => item.manifest.id === id)) {
        locatedNow.current = { record, snapshot };
        setLocated(locatedNow.current);
      } else {
        historyRecordsNow.current = historyRecordsNow.current.map((item) =>
          item.manifest.id === id ? record : item,
        );
        setBundles((items) =>
          items.map((item) => (item.manifest.id === id ? record : item)),
        );
      }
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
    assertAdditionalCurrent?: () => void,
    attemptId?: string,
    evidenceOnly = false,
  ) {
    if (mounted.current && isContextCurrent()) setChainObservation(null);
    assertAdditionalCurrent?.();
    if (
      !ownerScope ||
      !attemptId ||
      !isContextCurrent() ||
      (!evidenceOnly && manifestExpired(manifest)) ||
      (!signingOperation && !historyVerifiedNow.current)
    )
      throw new Error(
        'Signed-in account or bundle changed. Reload saved history.',
      );
    const checked = await createJitoPacketRecovery(
      manifest,
      packet,
      transaction,
    );
    const snapshot = await readExactSnapshot(manifest.id, manifest.sha256);
    const attempt = snapshot.attempts.find(
      (a) => a.packet === packet && a.attemptId === attemptId,
    );
    if (
      snapshot.legacyReadOnly ||
      snapshot.bundle.state !== 'reviewed' ||
      !attempt ||
      (attempt.state === 'unknown' &&
        snapshot.bundle.signatures[packet] !== null) ||
      (attempt.state === 'registered' &&
        (attempt.signature !== checked.signature ||
          attempt.transaction !== transaction))
    )
      throw new Error('Bundle signing attempt differs. Reload saved history.');
    assertAdditionalCurrent?.();
    if (
      !isContextCurrent() ||
      (!evidenceOnly && manifestExpired(manifest)) ||
      (!signingOperation && !historyVerifiedNow.current)
    )
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
        attemptId,
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
    const confirmed = await readExactSnapshot(manifest.id, manifest.sha256);
    const receipt = confirmed.attempts.find(
      (a) => a.packet === packet && a.attemptId === attemptId,
    );
    if (
      !receipt ||
      receipt.state !== 'registered' ||
      receipt.signature !== checked.signature ||
      receipt.transaction !== transaction ||
      confirmed.bundle.signatures[packet] !== checked.signature
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
  const displayBundles =
    located &&
    !bundles.some((b) => b.manifest.id === located.record.manifest.id)
      ? [...bundles, located.record]
      : bundles;
  const sessionSnapshotBlocked =
    !historyVerified ||
    displayBundles.some((bundle) => {
      const snapshot =
        located?.record.manifest.id === bundle.manifest.id &&
        !bundles.some((item) => item.manifest.id === bundle.manifest.id)
          ? located.snapshot
          : snapshots[bundle.manifest.id];
      return (
        !snapshot ||
        snapshot.bundle.manifest.sha256 !== bundle.manifest.sha256 ||
        (snapshot.legacyReadOnly &&
          ['reviewed', 'submitting', 'submitted'].includes(bundle.state)) ||
        snapshot.attempts.some((a) => a.state === 'unknown')
      );
    });
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
          A verified signed packet can be retained encrypted in this browser.
          Keep the vault password and recovery file private. Browser storage can
          be cleared or lost, so an unknown outcome requires careful recovery.
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
          disabled={busy || !ownerScope || coordinator.operationActive()}
          variant="outline"
          onClick={() => run()}
        >
          Load bundle approvals and history
        </Button>
        {ownerId && ownerScope && (
          <JitoRecoveryLocatorV2
            ownerId={ownerId}
            ownerScope={ownerScope}
            projectId={projectId}
            sessionId={session.id}
            coordinator={coordinator}
            disabled={busy || !historyVerified || coordinator.operationActive()}
            isContextCurrent={isContextCurrent}
            onOpen={({ locator, snapshot }) => {
              if (
                !isContextCurrent() ||
                !historyVerifiedNow.current ||
                locator.projectId !== projectId ||
                locator.sessionId !== session.id ||
                snapshot.bundle.manifest.id !== locator.bundleId ||
                snapshot.bundle.manifest.sha256 !== locator.sha256
              )
                throw new Error(
                  'Bundle context changed. Reload saved history.',
                );
              const recent = historyRecordsNow.current.find(
                (item) => item.manifest.id === locator.bundleId,
              );
              if (recent && recent.manifest.sha256 !== locator.sha256)
                throw new Error('Saved bundle changed. Reload history.');
              if (!recent) {
                locatedNow.current = { record: snapshot.bundle, snapshot };
                setLocated(locatedNow.current);
              }
              setOpenedBundleId(locator.bundleId);
              setAcceptedSubmit(null);
              void readExactSnapshot(locator.bundleId, locator.sha256).catch(
                () => {
                  if (isContextCurrent())
                    setError(
                      'Original saved bundle unavailable. Reload history.',
                    );
                },
              );
            }}
          />
        )}
        <p>
          To import a signed recovery file, open its bundle below and choose its
          packet.
        </p>
        <p>
          History lists up to 20 recent bundles. An older bundle opened from a
          recovery file appears separately; select the file again in its packet
          panel to verify or register the evidence.
        </p>
        {openedBundleId &&
          displayBundles.some(
            (item) => item.manifest.id === openedBundleId,
          ) && (
            <p>
              Bundle found.{' '}
              <a href={`#jito-bundle-${openedBundleId}`}>Go to opened bundle</a>
            </p>
          )}
        {historyVerified &&
          ownerScope &&
          coordinator
            .pending(ownerScope, projectId, session.id)
            .filter(
              (item) =>
                !displayBundles.some(
                  (bundle) => bundle.manifest.id === item.bundleId,
                ),
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
            sessionSnapshotBlocked ||
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
            sessionSnapshotBlocked ||
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
        {displayBundles.map((bundle) => {
          const m = bundle.manifest,
            expired = Date.parse(m.expiresAt) <= now;
          const isLocated =
            located?.record.manifest.id === m.id &&
            !bundles.some((item) => item.manifest.id === m.id);
          const snapshot = isLocated ? located?.snapshot : snapshots[m.id];
          const verified = Boolean(
            snapshot &&
            snapshot.bundle.manifest.sha256 === m.sha256 &&
            snapshot.bundle.state === bundle.state &&
            JSON.stringify(snapshot.bundle.signatures) ===
              JSON.stringify(bundle.signatures),
          );
          const unresolved =
            !verified || snapshot!.attempts.some((a) => a.state === 'unknown');
          const canRegister =
            Boolean(ownerScope) &&
            Boolean(verified && !snapshot!.legacyReadOnly) &&
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
          const canSign = canRegister && !hasPendingPacket && !unresolved;
          const complete = bundle.signatures.every(Boolean);
          let currentObservation: JitoChainObservation | null = null;
          if (chainObservation) {
            try {
              currentObservation = requireJitoChainObservation(
                chainObservation,
                bundle,
              );
            } catch {
              // A newer bundle/signature vector never inherits an older report.
            }
          }
          return (
            <article
              key={m.id}
              id={`jito-bundle-${m.id}`}
              tabIndex={-1}
              className="space-y-3 rounded-md border p-3"
            >
              <h5>Bundle {m.id}</h5>
              {isLocated && <p>Older bundle opened from a recovery file.</p>}
              {!verified && (
                <p>
                  Bundle details need verification before actions are available.
                  If they changed, select Verify bundle details to refresh this
                  bundle before taking action.
                </p>
              )}
              {!verified && (
                <Button
                  variant="outline"
                  disabled={
                    busy || !historyVerified || coordinator.operationActive()
                  }
                  onClick={() => void loadOriginal(m.id)}
                >
                  Verify bundle details
                </Button>
              )}
              {verified && snapshot!.legacyReadOnly && (
                <p>
                  This older bundle is read-only. Its original signing outcome
                  cannot be determined from this record alone.
                </p>
              )}
              {verified && !snapshot!.legacyReadOnly && unresolved && (
                <p>
                  A signing outcome is unknown. Keep the original recovery
                  record; do not sign or submit again.
                </p>
              )}
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
              {currentObservation && (
                <JitoChainObservationView
                  observation={currentObservation}
                  swapCount={m.swaps.length}
                />
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
                      registrationAllowed={false}
                      serverSignature={bundle.signatures[packet]}
                      isContextCurrent={isContextCurrent}
                      register={(transaction) =>
                        registerPacket(m, packet, transaction)
                      }
                    />
                  ) : null,
                )}
              {historyVerified &&
                ownerScope &&
                (bundle.state === 'cancelled' ||
                  bundle.state === 'expired') && (
                  <details>
                    <summary>Inspect saved signed packet recovery</summary>
                    {Array.from({ length: m.swaps.length + 1 }, (_, packet) => (
                      <JitoTerminalRecoveryImport
                        key={`${m.id}:terminal:${packet}`}
                        manifest={m}
                        packet={packet}
                        ownerScope={ownerScope}
                        coordinator={coordinator}
                        disabled
                        isContextCurrent={isContextCurrent}
                        readTerminalSignature={() =>
                          terminalPacketSignature(
                            m,
                            packet,
                            bundle.state as 'cancelled' | 'expired',
                          )
                        }
                      />
                    ))}
                  </details>
                )}
              {historyVerified && ownerScope && (
                <details>
                  <summary>Recover a signed packet from a file</summary>
                  <p>
                    File import requires an existing verified signing attempt
                    for the exact packet. It never signs or submits a
                    transaction.
                  </p>
                  {Array.from({ length: m.swaps.length + 1 }, (_, packet) => (
                    <JitoRecoveryFileV2
                      key={`${m.id}:file:${packet}`}
                      manifest={m}
                      packet={packet}
                      ownerScope={ownerScope}
                      coordinator={coordinator}
                      disabled={
                        busy ||
                        !verified ||
                        snapshot!.legacyReadOnly ||
                        !snapshot!.attempts.some(
                          (attempt) => attempt.packet === packet,
                        )
                      }
                      isContextCurrent={isContextCurrent}
                      readSnapshot={async () => ({
                        ...(await readExactSnapshot(m.id, m.sha256)),
                        ownerScope,
                      })}
                      registerEvidence={(transaction, attemptId, token) =>
                        registerPacket(
                          m,
                          packet,
                          transaction,
                          token,
                          undefined,
                          attemptId,
                          true,
                        )
                      }
                    />
                  ))}
                </details>
              )}
              {m.swaps.concat([]).map((_, i) =>
                bundle.state !== 'reviewed' && !bundle.signatures[i] ? null : (
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
                    recoveryOnly={
                      bundle.state !== 'reviewed' ||
                      Boolean(bundle.signatures[i])
                    }
                    recoveryDisabled={
                      !ownerScope ||
                      !historyVerified ||
                      !verified ||
                      snapshot!.legacyReadOnly ||
                      busy
                    }
                    ownerScope={ownerScope!}
                    coordinator={coordinator}
                    isContextCurrent={isContextCurrent}
                    readSnapshot={async () => ({
                      ...(await readExactSnapshot(m.id, m.sha256)),
                      ownerScope: ownerScope!,
                    })}
                    beforeSign={(attemptId) =>
                      beforePacketSign(m, i, attemptId)
                    }
                    register={(transaction, attemptId, token) =>
                      registerPacket(
                        m,
                        i,
                        transaction,
                        token,
                        undefined,
                        attemptId,
                      )
                    }
                    registerEvidence={(transaction, attemptId, token) =>
                      registerPacket(
                        m,
                        i,
                        transaction,
                        token,
                        undefined,
                        attemptId,
                        true,
                      )
                    }
                  />
                ),
              )}
              {(bundle.state === 'reviewed' ||
                Boolean(bundle.signatures.at(-1))) && (
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
                  recoveryOnly={
                    bundle.state !== 'reviewed' ||
                    Boolean(bundle.signatures.at(-1))
                  }
                  recoveryDisabled={
                    !ownerScope ||
                    !historyVerified ||
                    !verified ||
                    snapshot!.legacyReadOnly ||
                    busy
                  }
                  ownerScope={ownerScope!}
                  coordinator={coordinator}
                  isContextCurrent={isContextCurrent}
                  readSnapshot={async () => ({
                    ...(await readExactSnapshot(m.id, m.sha256)),
                    ownerScope: ownerScope!,
                  })}
                  beforeSign={(attemptId) =>
                    beforePacketSign(m, m.swaps.length, attemptId)
                  }
                  register={(transaction, attemptId, token) =>
                    registerPacket(
                      m,
                      m.swaps.length,
                      transaction,
                      token,
                      undefined,
                      attemptId,
                    )
                  }
                  registerEvidence={(transaction, attemptId, token) =>
                    registerPacket(
                      m,
                      m.swaps.length,
                      transaction,
                      token,
                      undefined,
                      attemptId,
                      true,
                    )
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
                    disabled={
                      busy ||
                      coordinator.operationActive() ||
                      !verified ||
                      snapshot!.legacyReadOnly
                    }
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
                      !verified ||
                      snapshot!.legacyReadOnly ||
                      unresolved ||
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
