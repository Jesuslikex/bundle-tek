'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { JitoBundleManifest } from '@/lib/jito-bundle';
import {
  createJitoPacketRecovery,
  readJitoPacketRecovery,
  JITO_RECOVERY_FILE_MAX_BYTES,
} from '@/lib/jito-packet-recovery';
import type {
  JitoMemorySignatureRecovery,
  JitoOperationToken,
} from '@/lib/jito-memory-signature-recovery';
import { Button } from './ui/button';

type Recovery = Awaited<ReturnType<typeof createJitoPacketRecovery>>;

/** Explicit local inspection for a freshly verified terminal bundle only. */
export function JitoTerminalRecoveryImport({
  manifest,
  packet,
  ownerScope,
  coordinator,
  disabled,
  isContextCurrent,
  readTerminalSignature,
}: {
  manifest: JitoBundleManifest;
  packet: number;
  ownerScope: string;
  coordinator: JitoMemorySignatureRecovery;
  disabled: boolean;
  isContextCurrent: () => boolean;
  readTerminalSignature: () => Promise<string | null>;
}) {
  const field = useId(),
    mounted = useRef(false),
    running = useRef(false);
  const [recovery, setRecovery] = useState<Recovery | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function assertCurrent() {
    if (!mounted.current || !isContextCurrent())
      throw Error('Bundle context changed. Reload saved history.');
  }
  function begin(): JitoOperationToken {
    assertCurrent();
    if (!ownerScope || coordinator.has(ownerScope, manifest.id, packet))
      throw Error('Original Jito packet recovery is pending.');
    return coordinator.startOperation(ownerScope);
  }
  async function verifyFresh(record: Recovery) {
    assertCurrent();
    const signature = await readTerminalSignature();
    assertCurrent();
    if (signature !== null && signature !== record.signature)
      throw Error('Saved bundle signature differs from this recovery file.');
    if (coordinator.has(ownerScope, manifest.id, packet))
      throw Error('Original Jito packet recovery is pending.');
  }
  async function inspect(file: File) {
    if (running.current || disabled) return;
    let operation: JitoOperationToken;
    try {
      operation = begin();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Recovery unavailable.',
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    setRecovery(null);
    try {
      if (file.size > JITO_RECOVERY_FILE_MAX_BYTES)
        throw Error('Recovery file exceeds the packet limit.');
      const checked = await readJitoPacketRecovery(
        await file.text(),
        manifest,
        packet,
      );
      assertCurrent();
      await verifyFresh(checked);
      assertCurrent();
      setRecovery(checked);
    } catch (failure) {
      if (mounted.current && isContextCurrent())
        setError(
          failure instanceof Error
            ? failure.message
            : 'Recovery inspection unavailable.',
        );
    } finally {
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function download() {
    if (running.current || disabled || !recovery) return;
    let operation: JitoOperationToken;
    try {
      operation = begin();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Recovery unavailable.',
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const checked = await createJitoPacketRecovery(
        manifest,
        packet,
        recovery.transaction,
      );
      assertCurrent();
      if (checked.signature !== recovery.signature)
        throw Error('Retained recovery signature differs.');
      await verifyFresh(checked);
      assertCurrent();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(checked, null, 2)], {
          type: 'application/json',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `bundle-${manifest.id}-packet-${packet + 1}-recovery.json`;
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
      coordinator.finishOperation(operation);
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section aria-label={`Terminal recovery for packet ${packet + 1}`}>
      <label htmlFor={`${field}-terminal-recovery`}>
        Verify saved recovery file for packet {packet + 1}
      </label>
      <p>
        Cancellation does not prove a wallet never signed. Expiry observations
        may not cover all history. Signed packets are private and may be
        submitted while valid.
      </p>
      <input
        id={`${field}-terminal-recovery`}
        type="file"
        accept="application/json,.json"
        disabled={busy || disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void inspect(file);
        }}
      />
      {recovery && (
        <>
          <p>
            Exact signed packet verified for this saved bundle. Inspection does
            not register, sign or submit it. Keep the file private.
          </p>
          <Button
            disabled={busy || disabled}
            variant="outline"
            onClick={() => void download()}
          >
            Download verified packet privately
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
