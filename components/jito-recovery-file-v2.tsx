'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { unlockVault, VAULT_STORAGE_KEY } from '@/lib/browser-wallet-vault';
import {
  requireJitoManifest,
  type JitoBundleManifest,
} from '@/lib/jito-bundle';
import {
  JITO_RECOVERY_FILE_MAX_BYTES,
  readJitoPacketRecovery,
} from '@/lib/jito-packet-recovery';
import {
  acknowledgeJitoRecoveryRegistered,
  inspectJitoRecoveryJournal,
  reserveJitoImportedEvidence,
  resumeJitoRecoveryUnknown,
  retainJitoRecoverySignature,
  withJitoRecoveryJournalLock,
} from '@/lib/jito-recovery-journal';
import type {
  JitoMemorySignatureRecovery,
  JitoOperationToken,
} from '@/lib/jito-memory-signature-recovery';
import type { JitoPacketV2Snapshot } from './jito-packet-signing';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** Separate evidence-only UI. Parent must provide a fresh, authenticated and
 * completely checked v2 snapshot and an exact evidence registration callback.
 * Neither callback may sign, broadcast, or grant new signing authority. */
export function JitoRecoveryFileV2({
  manifest,
  packet,
  ownerScope,
  coordinator,
  disabled,
  isContextCurrent,
  readSnapshot,
  registerEvidence,
}: {
  manifest: JitoBundleManifest;
  packet: number;
  ownerScope: string;
  coordinator: JitoMemorySignatureRecovery;
  disabled: boolean;
  isContextCurrent: () => boolean;
  readSnapshot: () => Promise<JitoPacketV2Snapshot>;
  registerEvidence: (
    transaction: string,
    attemptId: string,
    token?: JitoOperationToken,
  ) => Promise<void>;
}) {
  const field = useId(),
    mounted = useRef(true),
    running = useRef(false);
  const [file, setFile] = useState<File | null>(null),
    [password, setPassword] = useState(''),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [view, setView] = useState<{ attemptId: string; signature: string } | null>(
      null,
    );
  const label = manifest.swaps[packet] ? `swap ${packet + 1}` : 'Jito tip';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run(register: boolean) {
    if (
      running.current ||
      disabled ||
      !ownerScope ||
      !password ||
      (register ? !approved || !view : !file)
    )
      return;
    let operation: JitoOperationToken;
    let detached: JitoBundleManifest;
    let terms: string;
    try {
      detached = structuredClone(manifest);
      terms = JSON.stringify(detached);
      operation = coordinator.startOperation(ownerScope, detached.id, packet);
    } catch {
      setError('Recovery is unavailable. Reload saved history.');
      return;
    }
    const chosen = file,
      passphrase = password,
      expected = view;
    setPassword('');
    setApproved(false);
    setError('');
    setMessage('');
    running.current = true;
    setBusy(true);
    let needsReload = false;
    const assertCurrent = () => {
      if (
        !mounted.current ||
        !isContextCurrent() ||
        JSON.stringify(manifest) !== terms
      )
        throw Error('Recovery context changed.');
    };
    try {
      await requireJitoManifest(detached, false);
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
              current.projectId !== detached.projectId ||
              current.sessionId !== detached.sessionId ||
              current.legacyReadOnly ||
              current.bundle.manifest.id !== detached.id ||
              current.bundle.manifest.sha256 !== detached.sha256 ||
              !Array.isArray(current.attempts)
            )
              throw Error('Recovery snapshot differs.');
            const matches = current.attempts.filter(
              (attempt) => attempt.packet === packet,
            );
            if (matches.length !== 1)
              throw Error('Exact signing attempt unavailable.');
            const attempt = matches[0];
            if (
              attempt.bundleId !== detached.id ||
              attempt.manifestSha256 !== detached.sha256 ||
              attempt.signer !==
                (detached.swaps[packet]?.wallet ?? detached.tip.wallet) ||
              attempt.intentId !== (detached.swaps[packet]?.id ?? null) ||
              !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
                attempt.attemptId,
              ) ||
              (attempt.state === 'unknown' &&
                (attempt.signature !== null ||
                  attempt.transaction !== null ||
                  current.bundle.signatures[packet] !== null)) ||
              (attempt.state === 'registered' &&
                (typeof attempt.signature !== 'string' ||
                  typeof attempt.transaction !== 'string' ||
                  current.bundle.signatures[packet] !== attempt.signature)) ||
              !['unknown', 'registered'].includes(attempt.state)
            )
              throw Error('Recovery attempt differs.');
            return { current, attempt };
          };
          const readFresh = async () => ({
            ownerScope,
            record: (await snapshot()).current.bundle,
          });
          const inspect = () =>
            inspectJitoRecoveryJournal(
              lock,
              detached,
              packet,
              passphrase,
              readFresh,
            );
          if (!register) {
            if (!chosen || chosen.size > JITO_RECOVERY_FILE_MAX_BYTES)
              throw Error('Recovery file exceeds the packet limit.');
            const checked = await readJitoPacketRecovery(
              await chosen.text(),
              detached,
              packet,
            );
            assertCurrent();
            const initial = await snapshot();
            const existing = await inspect();
            if (existing.status === 'retained') {
              if (
                existing.signature !== checked.signature ||
                existing.transaction !== checked.transaction
              )
                throw Error('Retained packet differs.');
            } else if (existing.status === 'unknown') {
              const reservation = await resumeJitoRecoveryUnknown(
                lock,
                detached,
                packet,
                passphrase,
                readFresh,
              );
              await retainJitoRecoverySignature(
                lock,
                reservation,
                detached,
                checked.transaction,
              );
            } else if (initial.attempt.state === 'unknown') {
              // With no local password check, authenticate the normal vault password
              // first. Drop all decrypted material before any further async work.
              const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
              if (!encrypted) throw Error('Browser vault is required.');
              const session = await unlockVault(encrypted, passphrase);
              try {
                assertCurrent();
              } finally {
                for (const item of session.payload.wallets) item.seed = '';
              }
              const reservation = await reserveJitoImportedEvidence(
                lock,
                detached,
                packet,
                passphrase,
                checked.transaction,
                initial.attempt.attemptId,
                async () => {
                  const fresh = await snapshot();
                  return {
                    ownerScope,
                    record: fresh.current.bundle,
                    attempt: fresh.attempt,
                  };
                },
              );
              await retainJitoRecoverySignature(
                lock,
                reservation,
                detached,
                checked.transaction,
              );
            } else {
              if (
                initial.attempt.signature !== checked.signature ||
                initial.attempt.transaction !== checked.transaction ||
                initial.current.bundle.signatures[packet] !== checked.signature
              )
                throw Error('Registered packet differs.');
              if (mounted.current) {
                setView(null);
                setFile(null);
                setMessage(
                  'This exact packet is already registered. No local entry was changed.',
                );
              }
              return;
            }
            const retained = await inspect();
            const fresh = await snapshot();
            if (
              retained.status !== 'retained' ||
              retained.signature !== checked.signature ||
              retained.transaction !== checked.transaction ||
              fresh.attempt.attemptId !== initial.attempt.attemptId ||
              (fresh.attempt.state === 'registered' &&
                (fresh.attempt.signature !== checked.signature ||
                  fresh.attempt.transaction !== checked.transaction ||
                  fresh.current.bundle.signatures[packet] !==
                    checked.signature))
            )
              throw Error('Recovery packet differs.');
            if (mounted.current) {
              setFile(null);
              setView({
                attemptId: fresh.attempt.attemptId,
                signature: checked.signature,
              });
              setMessage(
                'Exact signed packet verified and retained. Review it before separately approving registration.',
              );
            }
            return;
          }
          const retained = await inspect();
          const fresh = await snapshot();
          if (
            !expected ||
            retained.status !== 'retained' ||
            retained.signature !== expected.signature ||
            fresh.attempt.attemptId !== expected.attemptId ||
            (fresh.attempt.state === 'registered' &&
              (fresh.attempt.signature !== retained.signature ||
                fresh.attempt.transaction !== retained.transaction ||
                fresh.current.bundle.signatures[packet] !==
                  retained.signature)) ||
            (fresh.attempt.state === 'unknown' &&
              (fresh.attempt.signature !== null ||
                fresh.attempt.transaction !== null ||
                fresh.current.bundle.signatures[packet] !== null))
          )
            throw Error('Recovery packet changed.');
          const beforeMemory = await coordinator.inspect(
            ownerScope,
            detached,
            packet,
          );
          if (beforeMemory.status === 'retained') {
            if (beforeMemory.signature !== retained.signature)
              throw Error('Memory packet differs.');
          } else if (beforeMemory.status !== 'absent') {
            needsReload = true;
            throw Error('Memory outcome needs attention.');
          }
          if (fresh.attempt.state === 'unknown') {
            await registerEvidence(
              retained.transaction,
              fresh.attempt.attemptId,
              operation,
            );
            assertCurrent();
          }
          const memory = await coordinator.inspect(
            ownerScope,
            detached,
            packet,
          );
          if (memory.status === 'retained') {
            if (memory.signature !== retained.signature)
              throw Error('Memory packet differs.');
          } else if (memory.status !== 'absent') {
            needsReload = true;
            throw Error('Memory outcome needs attention.');
          }
          await acknowledgeJitoRecoveryRegistered(
            lock,
            detached,
            packet,
            passphrase,
            readFresh,
          );
          if (memory.status === 'retained')
            await coordinator.acknowledge(
              ownerScope,
              detached,
              packet,
              retained.signature,
              assertCurrent,
            );
          if (mounted.current) {
            setView(null);
            setMessage(
              'Exact registration confirmed. Local retained entry acknowledged.',
            );
          }
        },
      );
    } catch {
      if (mounted.current) {
        setView(null);
        setError(
          needsReload
            ? 'This signing outcome is still held in memory. Reload the page, then inspect the retained packet again before approving registration.'
            : 'Recovery file or attempt could not be verified. Keep the attempt blocked.',
        );
      }
    } finally {
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p>
        Recover an already signed {label} packet. This never signs or submits a
        transaction. Keep the file private.
      </p>
      <label htmlFor={`${field}-file`}>Signed packet recovery file</label>
      <input
        id={`${field}-file`}
        type="file"
        accept="application/json,.json"
        disabled={busy || disabled}
        onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          setView(null);
          setApproved(false);
        }}
      />
      <label htmlFor={`${field}-password`}>Vault password for recovery</label>
      <Input
        id={`${field}-password`}
        type="password"
        autoComplete="off"
        value={password}
        disabled={busy || disabled}
        onChange={(event) => {
          setPassword(event.target.value);
          setApproved(false);
        }}
      />
      <p>
        For an existing entry use the password active when it was created, even
        if changed later.
      </p>
      <Button
        variant="outline"
        disabled={busy || disabled || !file || !password}
        onClick={() => void run(false)}
      >
        Verify and retain {label} file
      </Button>
      {view && (
        <>
          <p>
            Verified signature: <code>{view.signature}</code>
          </p>
          <p>
            Re-enter the same password to approve only exact registration or
            acknowledgement.
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={approved}
              disabled={busy || disabled}
              onChange={(event) => setApproved(event.target.checked)}
            />
            I approve registering only this exact retained packet or
            acknowledging its matching receipt. This does not sign or submit.
          </label>
          <Button
            variant="outline"
            disabled={busy || disabled || !approved || !password}
            onClick={() => void run(true)}
          >
            Confirm exact registration only
          </Button>
        </>
      )}
      {message && <output>{message}</output>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
