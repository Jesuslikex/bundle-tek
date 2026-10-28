'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { JitoBundleRecord } from '@/lib/jito-bundle';
import {
  createJitoPacketRecovery,
  readJitoPacketRecovery,
  JITO_RECOVERY_FILE_MAX_BYTES,
} from '@/lib/jito-packet-recovery';
import { readJitoRecoveryLocator } from '@/lib/jito-recovery-locator';
import type {
  JitoMemorySignatureRecovery,
  JitoOperationToken,
} from '@/lib/jito-memory-signature-recovery';
import { JitoMemoryRecovery } from './jito-memory-recovery';
import { Button } from './ui/button';
import styles from './jito-recovery-lookup.module.css';

type Recovery = Awaited<ReturnType<typeof createJitoPacketRecovery>>;
export type JitoLocatedRecovery =
  | {
      kind: 'retained';
      record: JitoBundleRecord;
      packet: number;
      recovery: Recovery;
    }
  | {
      kind: 'readonly';
      record: JitoBundleRecord;
      packet: number;
      recovery: Recovery;
    };

/** The caller supplies authenticated exact-record reads and owns view teardown. */
export function JitoRecoveryLookup({
  projectId,
  sessionId,
  ownerScope,
  coordinator,
  revision,
  disabled,
  isContextCurrent,
  readExactBundle,
  canRegister,
  registerPacket,
  view,
  setView,
  beginOperation,
  finishOperation,
  observedRecord,
}: {
  projectId: string;
  sessionId: string;
  ownerScope: string | null;
  coordinator: JitoMemorySignatureRecovery;
  revision: number;
  disabled: boolean;
  isContextCurrent: () => boolean;
  readExactBundle: (id: string) => Promise<JitoBundleRecord>;
  canRegister: (record: JitoBundleRecord) => boolean;
  registerPacket: (
    record: JitoBundleRecord,
    packet: number,
    transaction: string,
  ) => Promise<void>;
  view: JitoLocatedRecovery | null;
  setView: (value: JitoLocatedRecovery | null) => void;
  beginOperation: () => JitoOperationToken;
  finishOperation: (token: JitoOperationToken) => void;
  observedRecord: JitoBundleRecord | null;
}) {
  const field = useId(),
    mounted = useRef(false),
    running = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function assertCurrent() {
    if (!mounted.current || !isContextCurrent() || !ownerScope)
      throw Error('Bundle context changed. Reload saved history.');
  }
  function begin(): JitoOperationToken {
    assertCurrent();
    return beginOperation();
  }
  function sameRecord(
    first: JitoBundleRecord,
    next: JitoBundleRecord,
    packet: number,
  ) {
    return (
      next.manifest.id === first.manifest.id &&
      next.manifest.sha256 === first.manifest.sha256 &&
      next.manifest.projectId === projectId &&
      next.manifest.sessionId === sessionId &&
      next.state === first.state &&
      next.signatures[packet] === first.signatures[packet]
    );
  }
  async function lookup(file: File) {
    if (running.current || disabled || view) return;
    let operation: JitoOperationToken;
    try {
      operation = begin();
    } catch {
      setError(
        'Another Jito action is in progress or account verification is unavailable.',
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    let snapshot: Uint8Array | null = null;
    try {
      if (
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > JITO_RECOVERY_FILE_MAX_BYTES
      )
        throw Error('Recovery file is unavailable or invalid.');
      const source = await file.arrayBuffer();
      assertCurrent();
      const sourceLength = Object.getOwnPropertyDescriptor(
        ArrayBuffer.prototype,
        'byteLength',
      )!.get!.call(source) as number;
      if (
        sourceLength !== file.size ||
        sourceLength > JITO_RECOVERY_FILE_MAX_BYTES
      )
        throw Error('Recovery file is unavailable or invalid.');
      snapshot = new Uint8Array(source).slice();
      const locator = await readJitoRecoveryLocator(snapshot);
      assertCurrent();
      if (locator.projectId !== projectId || locator.sessionId !== sessionId)
        throw Error('Recovery file belongs to a different project or session.');
      if (coordinator.has(ownerScope!, locator.bundleId, locator.packet))
        throw Error('Original Jito packet recovery is pending.');
      const first = await readExactBundle(locator.bundleId);
      assertCurrent();
      if (
        first.manifest.id !== locator.bundleId ||
        first.manifest.sha256 !== locator.sha256 ||
        first.manifest.projectId !== projectId ||
        first.manifest.sessionId !== sessionId ||
        locator.packet >= first.signatures.length ||
        !['reviewed', 'cancelled', 'expired'].includes(first.state)
      )
        throw Error('Recovery bundle or state differs.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot);
      const checked = await readJitoPacketRecovery(
        text,
        first.manifest,
        locator.packet,
      );
      assertCurrent();
      if (
        first.signatures[locator.packet] !== null &&
        first.signatures[locator.packet] !== checked.signature
      )
        throw Error('Saved bundle signature differs from this recovery file.');
      const fresh = await readExactBundle(locator.bundleId);
      assertCurrent();
      if (!sameRecord(first, fresh, locator.packet))
        throw Error('Bundle changed. Reload saved history before recovery.');
      if (coordinator.has(ownerScope!, locator.bundleId, locator.packet))
        throw Error('Original Jito packet recovery is pending.');
      if (
        fresh.state === 'reviewed' &&
        fresh.signatures[locator.packet] === null
      ) {
        await coordinator.retainImported(
          ownerScope!,
          fresh.manifest,
          locator.packet,
          checked.transaction,
          operation,
          assertCurrent,
        );
        assertCurrent();
        setView({
          kind: 'retained',
          record: fresh,
          packet: locator.packet,
          recovery: checked,
        });
      } else {
        setView({
          kind: 'readonly',
          record: fresh,
          packet: locator.packet,
          recovery: checked,
        });
      }
    } catch (failure) {
      if (mounted.current && isContextCurrent())
        setError(
          failure instanceof Error
            ? failure.message
            : 'Recovery lookup unavailable.',
        );
    } finally {
      snapshot?.fill(0);
      finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function download() {
    if (running.current || disabled || !view || view.kind !== 'readonly')
      return;
    let operation: JitoOperationToken;
    try {
      operation = begin();
    } catch {
      setError(
        'Another Jito action is in progress or account verification is unavailable.',
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    try {
      if (coordinator.has(ownerScope!, view.record.manifest.id, view.packet))
        throw Error('Original Jito packet recovery is pending.');
      const checked = await createJitoPacketRecovery(
        view.record.manifest,
        view.packet,
        view.recovery.transaction,
      );
      assertCurrent();
      if (checked.signature !== view.recovery.signature)
        throw Error('Retained recovery signature differs.');
      const fresh = await readExactBundle(view.record.manifest.id);
      assertCurrent();
      if (!sameRecord(view.record, fresh, view.packet))
        throw Error('Bundle changed. Reload saved history before recovery.');
      if (
        fresh.signatures[view.packet] !== null &&
        fresh.signatures[view.packet] !== checked.signature
      )
        throw Error('Saved bundle signature differs from this recovery file.');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(checked, null, 2)], {
          type: 'application/json',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `bundle-${fresh.manifest.id}-packet-${view.packet + 1}-recovery.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (mounted.current && isContextCurrent())
        setError(
          failure instanceof Error
            ? failure.message
            : 'Recovery export unavailable.',
        );
    } finally {
      finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function confirmSavedSignature() {
    if (running.current || disabled || !view || view.kind !== 'retained')
      return;
    let operation: JitoOperationToken;
    try {
      operation = begin();
    } catch {
      setError(
        'Another Jito action is in progress or account verification is unavailable.',
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const fresh = await readExactBundle(view.record.manifest.id);
      assertCurrent();
      if (
        fresh.manifest.id !== view.record.manifest.id ||
        fresh.manifest.sha256 !== view.record.manifest.sha256 ||
        fresh.signatures[view.packet] !== view.recovery.signature
      )
        throw Error('Saved bundle does not contain this exact signature.');
      // This legacy bundle-only read does not prove an exact v2 attempt or
      // durable journal acknowledgement. Keep the original memory evidence.
      setNotice(
        'The saved signature matches. This older view cannot clear recovery; use the current bundle recovery controls.',
      );
    } catch (failure) {
      if (mounted.current && isContextCurrent())
        setError(
          failure instanceof Error
            ? failure.message
            : 'Saved signature verification unavailable.',
        );
    } finally {
      finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const observed =
    view?.kind === 'retained' &&
    observedRecord &&
    observedRecord.manifest.id === view.record.manifest.id &&
    observedRecord.manifest.sha256 === view.record.manifest.sha256
      ? observedRecord
      : null;
  const observedDigestConflict =
    view?.kind === 'retained' &&
    observedRecord &&
    observedRecord.manifest.id === view.record.manifest.id &&
    observedRecord.manifest.sha256 !== view.record.manifest.sha256;
  const observedSignature =
    observed && view ? observed.signatures[view.packet] : null;
  const matchingObserved =
    view?.kind === 'retained' &&
    observedSignature !== null &&
    observedSignature === view.recovery.signature;
  const conflictingObserved =
    view?.kind === 'retained' &&
    observedSignature !== null &&
    observedSignature !== view.recovery.signature;
  return (
    <details className={styles.disclosure}>
      <summary className={styles.summary}>
        Find an older bundle from a recovery file
      </summary>
      <div className={styles.content}>
        <p className={styles.copy}>
          Select the signed recovery file once. During lookup, its signed packet
          stays in this browser; its bundle ID and your current project and
          session IDs are sent to find the saved record. If you later approve
          registration, the signed packet is sent to the app server to save it,
          not submitted to the network. Signed packets are private and may be
          submitted while valid.
        </p>
        <label className={styles.label} htmlFor={`${field}-lookup`}>
          Signed Jito recovery file
        </label>
        <input
          id={`${field}-lookup`}
          className={styles.file}
          type="file"
          accept="application/json,.json"
          disabled={disabled || busy || Boolean(view)}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void lookup(file);
          }}
        />
        {view?.kind === 'retained' && (
          <>
            <p>
              Exact signed packet found. Registration requires separate
              approval; no packet was signed or submitted.
            </p>
            <p>
              Load bundle approvals and history before registration. Expired or
              unavailable bundles remain export only.
            </p>
            {matchingObserved && (
              <>
                <p>
                  Saved history contains this signature. You can inspect the
                  saved record here; this older view cannot clear local
                  recovery.
                </p>
                <Button
                  variant="outline"
                  disabled={busy || disabled}
                  onClick={() => void confirmSavedSignature()}
                >
                  Confirm saved signature
                </Button>
              </>
            )}
            {conflictingObserved && (
              <p role="alert">
                Saved history contains a different signature. Keep this original
                packet private; do not register or re-sign it.
              </p>
            )}
            {observedDigestConflict && (
              <p role="alert">
                Saved history contains a different bundle fingerprint. Keep this
                original packet private; do not register or re-sign it.
              </p>
            )}
            {observed && observed.state !== 'reviewed' && !matchingObserved && (
              <p>
                The saved bundle state changed. Registration is unavailable;
                keep this original packet for private recovery.
              </p>
            )}
            <JitoMemoryRecovery
              ownerScope={ownerScope!}
              manifest={view.record.manifest}
              packet={view.packet}
              coordinator={coordinator}
              revision={revision}
              registrationAllowed={
                canRegister(view.record) &&
                !observedDigestConflict &&
                (!observed ||
                  (observed.state === 'reviewed' && observedSignature === null))
              }
              serverSignature={null}
              isContextCurrent={isContextCurrent}
              register={async (transaction) => {
                await registerPacket(view.record, view.packet, transaction);
                if (mounted.current && isContextCurrent()) {
                  setView(null);
                  setNotice(
                    'Exact signature registered. Load bundle history to review the saved record.',
                  );
                }
              }}
            />
          </>
        )}
        {view?.kind === 'readonly' && (
          <>
            <p>
              {view.record.state === 'reviewed'
                ? 'This exact signature is already registered.'
                : view.record.state === 'cancelled' ||
                    view.record.state === 'expired'
                  ? 'This saved bundle is cancelled or expired. Cancellation does not prove a wallet never signed, and expiry observations may not cover all history.'
                  : `This exact signature is saved; the bundle state is ${view.record.state}.`}{' '}
              Inspection does not register, sign or submit. Keep this packet
              private.
            </p>
            <Button
              variant="outline"
              disabled={busy || disabled}
              onClick={() => void download()}
            >
              Download verified packet privately
            </Button>
          </>
        )}
        {view && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (running.current) return;
              setView(null);
              setNotice(
                view.kind === 'retained'
                  ? 'The original packet remains pending in this panel. Load history to reopen it.'
                  : 'Recovery view closed.',
              );
            }}
          >
            Close recovery view
          </Button>
        )}
        {notice && <p>{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
