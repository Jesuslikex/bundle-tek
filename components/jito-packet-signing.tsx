'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { getWallets } from '@wallet-standard/app';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import { signApprovedWarmupPacket } from '@/lib/warmup-signing';
import { signNativeWithdrawal } from '@/lib/native-withdrawal';
import {
  signApprovedExternalWarmupPacket,
  supportsWarmupExternalWallet,
  connectWarmupExternalWallet,
  type WarmupExternalWallet,
} from '@/lib/warmup-external-signer';
import {
  signExternalNativeWithdrawal,
  supportsNativeWithdrawalWallet,
  connectNativeWithdrawalWallet,
} from '@/lib/native-withdrawal-external-signer';
import {
  requireJitoManifest,
  type JitoBundleManifest,
  type JitoBundleRecord,
} from '@/lib/jito-bundle';
import {
  acknowledgeJitoRecoveryRegistered,
  inspectJitoRecoveryJournal,
  listJitoRecoveryJournalPending,
  reserveJitoRecoveryUnknown,
  retainJitoRecoverySignature,
  withJitoRecoveryJournalLock,
} from '@/lib/jito-recovery-journal';
import {
  createJitoSignAttemptClient,
  type JitoAttempt,
} from '@/lib/jito-sign-attempt-client';
import type {
  JitoMemoryReservation,
  JitoMemorySignatureRecovery,
  JitoOperationToken,
} from '@/lib/jito-memory-signature-recovery';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** Parent supplies freshly authenticated exact records and validated attempt
 * identities. A snapshot cannot itself authorize a signing invocation. */
export type JitoPacketV2Snapshot = {
  ownerScope: string;
  projectId: string;
  sessionId: string;
  bundle: JitoBundleRecord;
  attempts: JitoAttempt[];
  legacyReadOnly: boolean;
};

export function JitoPacketSigning({
  manifest,
  packet,
  disabled,
  register,
  ownerScope,
  coordinator,
  isContextCurrent,
  beforeSign,
  readSnapshot,
  recoveryOnly = false,
  recoveryDisabled,
  registerEvidence,
}: {
  manifest: JitoBundleManifest;
  packet: number;
  disabled: boolean;
  register: (
    transaction: string,
    attemptId: string,
    token?: JitoOperationToken,
  ) => Promise<void>;
  ownerScope: string;
  coordinator: JitoMemorySignatureRecovery;
  isContextCurrent: () => boolean;
  beforeSign: (attemptId: string) => Promise<void>;
  readSnapshot: () => Promise<JitoPacketV2Snapshot>;
  recoveryOnly?: boolean;
  recoveryDisabled: boolean;
  registerEvidence: (
    transaction: string,
    attemptId: string,
    token?: JitoOperationToken,
  ) => Promise<void>;
}) {
  const field = useId(),
    mounted = useRef(true),
    running = useRef(false);
  const [accepted, setAccepted] = useState(false),
    [password, setPassword] = useState(''),
    [choice, setChoice] = useState('vault'),
    [wallets, setWallets] = useState<WarmupExternalWallet[]>([]),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<
      | 'preparing'
      | 'wallet-request'
      | 'vault-signing'
      | 'retaining'
      | 'registering'
      | 'recovery-inspecting'
      | 'recovery-confirming'
      | 'recovery-exporting'
      | null
    >(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState<string | null>(null),
    [recoveryPassword, setRecoveryPassword] = useState(''),
    [recoveryApproved, setRecoveryApproved] = useState(false),
    [recoveryMessage, setRecoveryMessage] = useState(''),
    [recoveryView, setRecoveryView] = useState<{
      attemptId: string;
      signature: string;
    } | null>(null);
  const [inputGeneration, setInputGeneration] = useState(0);
  const inputGenerationNow = useRef(0);
  const [fieldGeneration, setFieldGeneration] = useState({
    choice: 0,
    password: 0,
    accepted: 0,
    recoveryPassword: 0,
    recoveryApproved: 0,
  });
  const fieldGenerationNow = useRef(fieldGeneration);
  const invalidateInput = (...fields: (keyof typeof fieldGeneration)[]) => {
    inputGenerationNow.current += 1;
    setInputGeneration(inputGenerationNow.current);
    const next = { ...fieldGenerationNow.current };
    for (const field of fields.length
      ? fields
      : (Object.keys(next) as (keyof typeof next)[]))
      next[field]++;
    fieldGenerationNow.current = next;
    setFieldGeneration(next);
  };
  const actionContextNow = useRef({
    manifest,
    packet,
    ownerScope,
    coordinator,
    isContextCurrent,
  });
  useLayoutEffect(() => {
    actionContextNow.current = {
      manifest,
      packet,
      ownerScope,
      coordinator,
      isContextCurrent,
    };
  }, [manifest, packet, ownerScope, coordinator, isContextCurrent]);
  const disabledNow = useRef(disabled),
    recoveryDisabledNow = useRef(recoveryDisabled),
    recoveryOnlyNow = useRef(recoveryOnly),
    pendingNow = useRef(pending);
  useLayoutEffect(() => {
    disabledNow.current = disabled;
    recoveryDisabledNow.current = recoveryDisabled;
    recoveryOnlyNow.current = recoveryOnly;
    pendingNow.current = pending;
  }, [disabled, recoveryDisabled, recoveryOnly, pending]);
  const swap = manifest.swaps[packet],
    wallet = swap?.wallet ?? manifest.tip.wallet;
  const label = swap ? `swap ${packet + 1}` : 'Jito tip';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isSwap = Boolean(swap);
  useEffect(() => {
    const registry = getWallets();
    const refresh = () =>
      setWallets(
        registry
          .get()
          .filter((entry) =>
            isSwap
              ? supportsWarmupExternalWallet(entry)
              : supportsNativeWithdrawalWallet(entry),
          ),
      );
    refresh();
    const removeRegister = registry.on('register', refresh),
      removeUnregister = registry.on('unregister', refresh);
    return () => {
      removeRegister();
      removeUnregister();
    };
  }, [isSwap]);
  const canChange = (recovery: boolean) =>
    mounted.current &&
    !running.current &&
    !coordinator.operationActive() &&
    isContextCurrent() &&
    actionContextNow.current.isContextCurrent() &&
    actionContextNow.current.manifest === manifest &&
    actionContextNow.current.packet === packet &&
    actionContextNow.current.ownerScope === ownerScope &&
    actionContextNow.current.coordinator === coordinator &&
    (recovery
      ? !recoveryDisabledNow.current
      : !disabledNow.current &&
        !recoveryOnlyNow.current &&
        !pendingNow.current);

  async function sign() {
    if (
      !canChange(false) ||
      inputGeneration !== inputGenerationNow.current ||
      recoveryOnly ||
      !accepted ||
      !password ||
      disabled ||
      running.current ||
      pending
    )
      return;
    let operation: JitoOperationToken;
    let approved: JitoBundleManifest;
    let approvedTerms: string;
    try {
      approved = structuredClone(manifest);
      approvedTerms = JSON.stringify(approved);
      if (
        !ownerScope ||
        Array.from({ length: approved.swaps.length + 1 }, (_, index) =>
          coordinator.has(ownerScope, approved.id, index),
        ).some(Boolean)
      )
        throw Error('A Jito signing outcome is still pending.');
      operation = coordinator.startOperation(ownerScope, approved.id, packet);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Another Jito action is in progress.',
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setProgress('preparing');
    setError('');
    const passphrase = password;
    const external =
      choice === 'vault'
        ? null
        : wallets.find((value) => value.name === choice);
    invalidateInput();
    setPassword('');
    const approvedSwap = approved.swaps[packet];
    const approvedWallet = approvedSwap?.wallet ?? approved.tip.wallet;
    const assertCurrent = () => {
      if (
        !mounted.current ||
        !isContextCurrent() ||
        Date.parse(approved.expiresAt) <= Date.now() ||
        JSON.stringify(manifest) !== approvedTerms
      )
        throw Error(
          'Bundle changed or expired. Keep any signature for recovery.',
        );
    };
    let memory: JitoMemoryReservation | null = null;
    // Set before a potentially ambiguous durable insert, not after it returns.
    let durableInsertStarted = false;
    let vault: Awaited<ReturnType<typeof unlockVault>> | null = null;
    try {
      await requireJitoManifest(approved);
      assertCurrent();
      const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
      if (!encrypted)
        throw Error(
          'Create or import this wallet in the encrypted browser vault first.',
        );
      // Validate the normal vault password before persisting UNKNOWN. External
      // wallets use it only for the encrypted local recovery journal.
      vault = await unlockVault(encrypted, passphrase);
      assertCurrent();
      if (choice === 'vault') {
        const item = vault.payload.wallets.find(
          (w) => w.family === 'solana' && w.address === approvedWallet,
        );
        if (!item || !/^[a-f0-9]{64}$/.test(item.seed))
          throw Error('Reviewed wallet is not in this vault.');
        const seed = Uint8Array.from(item.seed.match(/../g)!, (v) =>
          parseInt(v, 16),
        );
        const pair = nacl.sign.keyPair.fromSeed(seed);
        try {
          if (bs58.encode(pair.publicKey) !== approvedWallet)
            throw Error('Reviewed wallet is not in this vault.');
        } finally {
          seed.fill(0);
          pair.secretKey.fill(0);
        }
      } else {
        // No decrypted vault material may survive an extension connection or prompt.
        for (const item of vault.payload.wallets) item.seed = '';
        vault = null;
        if (!external) throw Error('Selected external wallet is unavailable.');
        if (approvedSwap)
          await connectWarmupExternalWallet(external, approvedWallet);
        else await connectNativeWithdrawalWallet(external, approvedWallet);
      }
      assertCurrent();
      await withJitoRecoveryJournalLock(
        ownerScope,
        assertCurrent,
        async (lock) => {
          const snapshot = async () => {
            const result = await readSnapshot();
            assertCurrent();
            if (
              !result ||
              result.ownerScope !== ownerScope ||
              result.projectId !== approved.projectId ||
              result.sessionId !== approved.sessionId ||
              result.legacyReadOnly ||
              result.bundle.manifest.id !== approved.id ||
              result.bundle.manifest.sha256 !== approved.sha256 ||
              !Array.isArray(result.attempts)
            )
              throw Error('Bundle context changed. Reload saved history.');
            return result;
          };
          const readFresh = async () => ({
            ownerScope,
            record: (await snapshot()).bundle,
          });
          const pendingLocal = await listJitoRecoveryJournalPending(
            lock,
            approved.projectId,
            approved.sessionId,
            async () => (await snapshot()).ownerScope,
          );
          if (pendingLocal.some((entry) => entry.bundleId === approved.id))
            throw Error('A Jito signing outcome is still pending.');
          const original = await snapshot();
          if (
            original.bundle.state !== 'reviewed' ||
            original.bundle.signatures[packet] !== null ||
            original.attempts.some((attempt) => attempt.state === 'unknown')
          )
            throw Error('A Jito signing outcome is still pending.');
          memory = await coordinator.reserve(ownerScope, approved, packet);
          assertCurrent();
          durableInsertStarted = true;
          const durable = await reserveJitoRecoveryUnknown(
            lock,
            approved,
            packet,
            passphrase,
            readFresh,
          );
          assertCurrent();
          // Exactly one begin request. A timeout or replay never permits signing.
          const attemptId = crypto.randomUUID();
          const client = createJitoSignAttemptClient({
            identity: {
              ownerScope,
              bundleId: approved.id,
              digest: approved.sha256,
              packet,
              signer: approvedWallet,
              intentId: approvedSwap?.id ?? null,
              attemptId,
            },
            assertCurrent,
          });
          const begun = await client.begin(true);
          if (!begun.permit)
            throw Error(
              'Signing outcome is unknown. Open recovery before another action.',
            );
          await begun.permit.invokeOnce(async () => {
            const hooks = {
              beforeSign: async () => {
                await requireJitoManifest(approved);
                assertCurrent();
                await beforeSign(attemptId);
                await requireJitoManifest(approved);
                assertCurrent();
              },
              onSignerStart: () => {
                assertCurrent();
                coordinator.markStarted(memory!);
                if (mounted.current)
                  setProgress(external ? 'wallet-request' : 'vault-signing');
              },
              retainSigned: async (signed: { transaction: string }) => {
                // Both independent attempts run even when the UI unmounted. A
                // failed durable write prevents registration and keeps UNKNOWN.
                if (vault)
                  for (const item of vault.payload.wallets) item.seed = '';
                if (mounted.current) setProgress('retaining');
                const retained = await Promise.allSettled([
                  coordinator.capture(memory!, approved, signed.transaction),
                  retainJitoRecoverySignature(
                    lock,
                    durable,
                    approved,
                    signed.transaction,
                  ),
                ]);
                if (retained.some((result) => result.status === 'rejected'))
                  throw Error('Signed packet recovery needs attention.');
              },
            };
            const signed = external
              ? approvedSwap
                ? await signApprovedExternalWarmupPacket(
                    external,
                    approvedSwap,
                    assertCurrent,
                    hooks.retainSigned,
                    hooks,
                  )
                : await signExternalNativeWithdrawal(
                    external,
                    approved.tip,
                    assertCurrent,
                    hooks.retainSigned,
                    hooks,
                  )
              : approvedSwap
                ? await signApprovedWarmupPacket(
                    vault!,
                    approvedSwap,
                    assertCurrent,
                    hooks,
                  )
                : await signNativeWithdrawal(
                    vault!,
                    approved.tip,
                    assertCurrent,
                    hooks,
                  );
            assertCurrent();
            if (mounted.current) {
              setPending(signed.transaction);
              setProgress('registering');
            }
            await register(signed.transaction, attemptId, operation);
            assertCurrent();
            await acknowledgeJitoRecoveryRegistered(
              lock,
              approved,
              packet,
              passphrase,
              readFresh,
            );
            assertCurrent();
            await coordinator.acknowledge(
              ownerScope,
              approved,
              packet,
              signed.signature,
              assertCurrent,
            );
            if (mounted.current) {
              setPending(null);
              setAccepted(false);
            }
          });
        },
      );
    } catch (failure) {
      if (memory && !durableInsertStarted) {
        try {
          coordinator.releaseUnstarted(memory);
        } catch {
          /* retain on ambiguity */
        }
      }
      if (mounted.current)
        setError(
          durableInsertStarted
            ? 'This signing attempt needs recovery before another action. Do not sign or submit it again.'
            : failure instanceof Error
              ? failure.message
              : 'Signing did not complete.',
        );
    } finally {
      if (vault) for (const item of vault.payload.wallets) item.seed = '';
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  /** Read and re-verify the locally retained exact packet; this never signs,
   * registers, clears, or submits. No entry is evidence of no signing. */
  async function recover(registerApproved: boolean) {
    if (
      !canChange(true) ||
      inputGeneration !== inputGenerationNow.current ||
      recoveryDisabled ||
      !ownerScope ||
      !recoveryPassword ||
      (registerApproved && (!recoveryApproved || !recoveryView))
    )
      return;
    let operation: JitoOperationToken;
    let approved: JitoBundleManifest;
    let approvedTerms: string;
    try {
      approved = structuredClone(manifest);
      approvedTerms = JSON.stringify(approved);
      operation = coordinator.startOperation(ownerScope, approved.id, packet);
    } catch {
      setError('Recovery is unavailable. Reload saved bundle history.');
      return;
    }
    const expectedView = recoveryView;
    const passphrase = recoveryPassword;
    invalidateInput();
    setRecoveryPassword('');
    setRecoveryApproved(false);
    setError('');
    setRecoveryMessage('');
    running.current = true;
    setBusy(true);
    setProgress(
      registerApproved ? 'recovery-confirming' : 'recovery-inspecting',
    );
    const assertCurrent = () => {
      if (
        !mounted.current ||
        !isContextCurrent() ||
        JSON.stringify(manifest) !== approvedTerms
      )
        throw Error('Recovery context changed. Reload saved history.');
    };
    try {
      await requireJitoManifest(approved, false);
      assertCurrent();
      await withJitoRecoveryJournalLock(
        ownerScope,
        assertCurrent,
        async (lock) => {
          const snapshot = async () => {
            const current = await readSnapshot();
            assertCurrent();
            if (
              !current ||
              current.ownerScope !== ownerScope ||
              current.projectId !== approved.projectId ||
              current.sessionId !== approved.sessionId ||
              current.legacyReadOnly ||
              current.bundle.manifest.id !== approved.id ||
              current.bundle.manifest.sha256 !== approved.sha256 ||
              !Array.isArray(current.attempts)
            )
              throw Error('Recovery context changed. Reload saved history.');
            return current;
          };
          const readFresh = async () => ({
            ownerScope,
            record: (await snapshot()).bundle,
          });
          const inspected = await inspectJitoRecoveryJournal(
            lock,
            approved,
            packet,
            passphrase,
            readFresh,
          );
          if (inspected.status !== 'retained') {
            // Distinguish only what a fresh, owner-scoped exact bundle read
            // actually shows. A missing attempt never proves an unsigned outcome.
            const noServerAttempt =
              inspected.status === 'unknown' &&
              !(await snapshot()).attempts.some((a) => a.packet === packet);
            if (mounted.current) {
              setRecoveryView(null);
              setRecoveryMessage(
                inspected.status === 'unknown'
                  ? noServerAttempt
                    ? 'A local recovery marker exists, but no signed packet is available here and no matching server attempt is visible in the latest verified bundle record. This does not prove no signing occurred. Keep this attempt blocked; do not sign, cancel or submit it again. Preserve this browser data and any recovery file.'
                    : 'A local recovery marker exists, but no signed packet is available here. The signing outcome is unknown. Keep this attempt blocked; do not sign, cancel or submit it again. Preserve this browser data and any recovery file.'
                  : 'No retained packet was found in this browser. That does not prove no signing occurred.',
              );
            }
            return;
          }
          const current = await snapshot();
          const matches = current.attempts.filter((a) => a.packet === packet);
          if (matches.length !== 1)
            throw Error('Exact signing attempt unavailable.');
          const attempt = matches[0];
          const signer = approved.swaps[packet]?.wallet ?? approved.tip.wallet;
          if (
            attempt.bundleId !== approved.id ||
            attempt.manifestSha256 !== approved.sha256 ||
            attempt.signer !== signer ||
            attempt.intentId !== (approved.swaps[packet]?.id ?? null) ||
            (attempt.state === 'registered' &&
              (attempt.signature !== inspected.signature ||
                attempt.transaction !== inspected.transaction ||
                current.bundle.signatures[packet] !== inspected.signature)) ||
            (attempt.state === 'unknown' &&
              (attempt.signature !== null ||
                attempt.transaction !== null ||
                current.bundle.signatures[packet] !== null))
          )
            throw Error('Exact signing attempt differs.');
          if (!registerApproved) {
            if (mounted.current) {
              setRecoveryView({
                attemptId: attempt.attemptId,
                signature: inspected.signature,
              });
              setRecoveryMessage(
                'Exact retained packet verified locally. Review it before separately approving registration.',
              );
            }
            return;
          }
          if (
            !expectedView ||
            expectedView.attemptId !== attempt.attemptId ||
            expectedView.signature !== inspected.signature
          )
            throw Error('Retained packet changed. Review it again.');
          if (attempt.state === 'unknown') {
            await registerEvidence(
              inspected.transaction,
              attempt.attemptId,
              operation,
            );
            assertCurrent();
          }
          const memory = await coordinator.inspect(
            ownerScope,
            approved,
            packet,
          );
          if (memory.status === 'retained') {
            if (memory.signature !== inspected.signature)
              throw Error('Retained packet differs.');
          } else if (memory.status !== 'absent') {
            throw Error('Pending memory recovery needs attention.');
          }
          // This independently fetches the exact authenticated registered record
          // and deletes only the matching retained envelope after confirmation.
          await acknowledgeJitoRecoveryRegistered(
            lock,
            approved,
            packet,
            passphrase,
            readFresh,
          );
          if (memory.status === 'retained') {
            await coordinator.acknowledge(
              ownerScope,
              approved,
              packet,
              inspected.signature,
              assertCurrent,
            );
          }
          if (mounted.current) {
            setRecoveryView(null);
            setPending(null);
            setRecoveryMessage(
              'Exact registration confirmed. Local retained entry acknowledged.',
            );
          }
        },
      );
    } catch {
      if (mounted.current) {
        setRecoveryView(null);
        setError(
          'Recovery could not be verified. Keep the attempt blocked and reload saved history.',
        );
      }
    } finally {
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  /** Explicit, local export of the exact retained packet. Expiry does not
   * invalidate evidence, and this path never signs, registers or submits. */
  async function exportRetained() {
    if (
      !canChange(true) ||
      inputGeneration !== inputGenerationNow.current ||
      recoveryDisabled ||
      !ownerScope ||
      !recoveryPassword ||
      !recoveryView
    )
      return;
    let operation: JitoOperationToken;
    let approved: JitoBundleManifest;
    let approvedTerms: string;
    try {
      approved = structuredClone(manifest);
      approvedTerms = JSON.stringify(approved);
      operation = coordinator.startOperation(ownerScope, approved.id, packet);
    } catch {
      setError('Recovery is unavailable. Reload saved bundle history.');
      return;
    }
    const expected = recoveryView,
      passphrase = recoveryPassword;
    invalidateInput();
    setRecoveryPassword('');
    setRecoveryApproved(false);
    setError('');
    running.current = true;
    setBusy(true);
    setProgress('recovery-exporting');
    const assertCurrent = () => {
      if (
        !mounted.current ||
        !isContextCurrent() ||
        JSON.stringify(manifest) !== approvedTerms
      )
        throw Error('Recovery context changed.');
    };
    try {
      await requireJitoManifest(approved, false);
      assertCurrent();
      await withJitoRecoveryJournalLock(
        ownerScope,
        assertCurrent,
        async (lock) => {
          const snapshot = async () => {
            const current = structuredClone(await readSnapshot());
            assertCurrent();
            if (
              !current ||
              current.ownerScope !== ownerScope ||
              current.projectId !== approved.projectId ||
              current.sessionId !== approved.sessionId ||
              current.legacyReadOnly ||
              current.bundle.manifest.id !== approved.id ||
              current.bundle.manifest.sha256 !== approved.sha256 ||
              !Array.isArray(current.attempts)
            )
              throw Error('Recovery snapshot differs.');
            return current;
          };
          const readFresh = async () => ({
            ownerScope,
            record: (await snapshot()).bundle,
          });
          const retained = await inspectJitoRecoveryJournal(
            lock,
            approved,
            packet,
            passphrase,
            readFresh,
          );
          if (
            retained.status !== 'retained' ||
            retained.signature !== expected.signature
          )
            throw Error('Retained packet differs.');
          const record = await createJitoPacketRecovery(
            approved,
            packet,
            retained.transaction,
          );
          assertCurrent();
          if (record.signature !== expected.signature)
            throw Error('Retained packet differs.');
          const fresh = await snapshot();
          const matches = fresh.attempts.filter(
            (attempt) => attempt.packet === packet,
          );
          if (matches.length !== 1)
            throw Error('Exact signing attempt unavailable.');
          const attempt = matches[0];
          if (
            attempt.attemptId !== expected.attemptId ||
            attempt.bundleId !== approved.id ||
            attempt.manifestSha256 !== approved.sha256 ||
            attempt.signer !==
              (approved.swaps[packet]?.wallet ?? approved.tip.wallet) ||
            attempt.intentId !== (approved.swaps[packet]?.id ?? null) ||
            (attempt.state === 'unknown' &&
              (attempt.signature !== null ||
                attempt.transaction !== null ||
                fresh.bundle.signatures[packet] !== null)) ||
            (attempt.state === 'registered' &&
              (attempt.signature !== retained.signature ||
                attempt.transaction !== retained.transaction ||
                fresh.bundle.signatures[packet] !== retained.signature)) ||
            !['unknown', 'registered'].includes(attempt.state)
          )
            throw Error('Exact signing attempt differs.');
          assertCurrent();
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(record, null, 2)], {
              type: 'application/json',
            }),
          );
          try {
            const link = document.createElement('a');
            link.href = url;
            link.download = `bundle-${approved.id}-packet-${packet + 1}-recovery.json`;
            assertCurrent();
            link.click();
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        },
      );
    } catch {
      if (mounted.current)
        setError(
          'Retained packet could not be verified for export. Keep the attempt blocked and reload saved history.',
        );
    } finally {
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  async function exportRecovery() {
    const current = () =>
      mounted.current &&
      isContextCurrent() &&
      actionContextNow.current.isContextCurrent() &&
      actionContextNow.current.ownerScope === ownerScope &&
      actionContextNow.current.packet === packet &&
      actionContextNow.current.manifest === manifest &&
      actionContextNow.current.coordinator === coordinator &&
      pendingNow.current === pending;
    if (
      !pending ||
      running.current ||
      coordinator.operationActive() ||
      !current()
    )
      return;
    const detached = structuredClone(manifest);
    const terms = JSON.stringify(detached);
    running.current = true;
    setBusy(true);
    setProgress('recovery-exporting');
    setError('');
    try {
      const record = await createJitoPacketRecovery(detached, packet, pending);
      if (!current() || JSON.stringify(manifest) !== terms) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(record, null, 2)], {
          type: 'application/json',
        }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `bundle-${detached.id}-packet-${packet + 1}-recovery.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (mounted.current) setError('Recovery export unavailable.');
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      {progress && (
        <output aria-live="polite">
          {
            {
              preparing:
                'Preparing the signing request and checking the wallet. No signature has been requested yet.',
              'wallet-request':
                'Waiting for the wallet to respond to the signing request. This does not submit a transaction.',
              'vault-signing':
                'Signing this packet in the browser. This does not submit a transaction.',
              retaining:
                'Saving the returned signed packet for recovery. It has not been submitted.',
              registering:
                'Registering the signed packet for recovery. This does not submit a transaction.',
              'recovery-inspecting':
                'Checking the retained recovery packet. This does not sign or submit.',
              'recovery-confirming':
                'Confirming the retained recovery packet. This does not sign or submit.',
              'recovery-exporting':
                'Preparing the recovery file. This does not sign or submit.',
            }[progress]
          }
        </output>
      )}
      <p>
        Signer for {label}: <code>{wallet}</code>. This action signs one packet.
        It does not submit it.
      </p>
      <p>
        A browser vault and its password are required to protect recovery,
        including when signing with an external wallet. To import a signed
        packet file, use the bundle&apos;s file recovery section.
      </p>
      <p>
        External wallets must expose the selected mainnet account and its exact
        public key throughout signing. Wallets that hide the account, including
        some Phantom configurations, cannot be used for this flow.
      </p>
      {!recoveryOnly && (
        <>
          <label htmlFor={`${field}-signer`}>Signing method for {label}</label>
          <select
            id={`${field}-signer`}
            value={choice}
            disabled={busy || disabled || Boolean(pending)}
            onChange={(event) => {
              if (
                !canChange(false) ||
                fieldGeneration.choice !== fieldGenerationNow.current.choice
              )
                return;
              invalidateInput('choice', 'accepted');
              setChoice(event.target.value);
              setAccepted(false);
            }}
          >
            <option value="vault">Encrypted browser vault</option>
            {wallets.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
          <label htmlFor={`${field}-password`}>
            Vault password for {label}
          </label>
          <Input
            id={`${field}-password`}
            type="password"
            autoComplete="off"
            value={password}
            disabled={busy || disabled || Boolean(pending)}
            onChange={(e) => {
              if (
                canChange(false) &&
                fieldGeneration.password === fieldGenerationNow.current.password
              ) {
                invalidateInput('password', 'accepted');
                setAccepted(false);
                setPassword(e.target.value);
              }
            }}
          />
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy || disabled || Boolean(pending)}
              onChange={(e) => {
                if (
                  canChange(false) &&
                  fieldGeneration.accepted ===
                    fieldGenerationNow.current.accepted
                ) {
                  invalidateInput('accepted');
                  setAccepted(e.target.checked);
                }
              }}
            />
            <span className="min-w-0 flex-1 break-words">
              I approve signing {label} in bundle {manifest.id}, with the
              displayed order, amounts and tip.
            </span>
          </label>
          <Button
            disabled={
              disabled || busy || !accepted || Boolean(pending) || !password
            }
            onClick={() => void sign()}
          >
            Sign {label} only
          </Button>
        </>
      )}
      {pending && (
        <>
          <label htmlFor={`${field}-retained`}>
            Retained signed {label} packet
          </label>
          <textarea
            id={`${field}-retained`}
            readOnly
            spellCheck={false}
            rows={3}
            value={pending}
            className="w-full break-all rounded-md border p-2 font-mono text-xs"
          />
          <p>
            Registration or acknowledgement needs attention. Keep this exact
            signed packet private. Opening recovery does not sign or submit.
          </p>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => void exportRecovery()}
          >
            Download signed packet recovery file
          </Button>
        </>
      )}
      <details>
        <summary>Recover retained {label} packet</summary>
        <p>
          Use the vault password that was active when this packet was signed,
          even if you changed it later. Recovery never signs or submits a
          transaction. Browser data can be lost.
        </p>
        <label htmlFor={`${field}-recovery-password`}>
          Vault password for recovery
        </label>
        <Input
          id={`${field}-recovery-password`}
          type="password"
          autoComplete="off"
          value={recoveryPassword}
          disabled={busy || recoveryDisabled}
          onChange={(event) => {
            if (
              !canChange(true) ||
              fieldGeneration.recoveryPassword !==
                fieldGenerationNow.current.recoveryPassword
            )
              return;
            invalidateInput('recoveryPassword', 'recoveryApproved');
            setRecoveryPassword(event.target.value);
            setRecoveryApproved(false);
          }}
        />
        <Button
          variant="outline"
          disabled={busy || recoveryDisabled || !recoveryPassword}
          onClick={() => void recover(false)}
        >
          Inspect retained {label} packet
        </Button>
        {recoveryView && (
          <>
            <p>
              Verified retained signature: <code>{recoveryView.signature}</code>
            </p>
            <p>
              Re-enter the same vault password to download this exact signed
              packet, register it, or acknowledge its existing receipt.
            </p>
            <p>
              A downloaded signed packet is sensitive: anyone with it may be
              able to submit it while it remains valid. Keep the file private.
            </p>
            <Button
              variant="outline"
              disabled={busy || recoveryDisabled || !recoveryPassword}
              onClick={() => void exportRetained()}
            >
              Download retained {label} packet privately
            </Button>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={recoveryApproved}
                disabled={busy || recoveryDisabled}
                onChange={(event) => {
                  if (
                    canChange(true) &&
                    fieldGeneration.recoveryApproved ===
                      fieldGenerationNow.current.recoveryApproved
                  ) {
                    invalidateInput('recoveryApproved');
                    setRecoveryApproved(event.target.checked);
                  }
                }}
              />
              I approve registering only this exact retained {label} packet or
              acknowledging its matching receipt. This does not sign or submit.
            </label>
            <Button
              variant="outline"
              disabled={
                busy ||
                recoveryDisabled ||
                !recoveryPassword ||
                !recoveryApproved
              }
              onClick={() => void recover(true)}
            >
              Confirm retained {label} registration only
            </Button>
          </>
        )}
        {recoveryMessage && <output>{recoveryMessage}</output>}
      </details>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
