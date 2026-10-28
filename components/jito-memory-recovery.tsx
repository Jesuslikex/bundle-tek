'use client';
import { useEffect, useRef, useState } from 'react';
import type { JitoBundleManifest } from '@/lib/jito-bundle';
import type {
  JitoMemoryInspection,
  JitoMemorySignatureRecovery,
} from '@/lib/jito-memory-signature-recovery';
import { createJitoPacketRecovery } from '@/lib/jito-packet-recovery';
import { Button } from './ui/button';

/** Caller must first load this exact manifest through a matching owner-scoped GET. */
export function JitoMemoryRecovery({
  ownerScope,
  manifest,
  packet,
  coordinator,
  revision,
  registrationAllowed,
  serverSignature,
  isContextCurrent,
  register,
}: {
  ownerScope: string;
  manifest: JitoBundleManifest;
  packet: number;
  coordinator: JitoMemorySignatureRecovery;
  revision: number;
  registrationAllowed: boolean;
  serverSignature: string | null;
  isContextCurrent: () => boolean;
  register: (transaction: string) => Promise<void>;
}) {
  const [inspection, setInspection] = useState<JitoMemoryInspection | null>(
    null,
  );
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false),
    running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void coordinator
      .inspect(ownerScope, manifest, packet)
      .then(async (value) => {
        if (!active || !isContextCurrent()) return;
        // A history signature alone is not an exact registered receipt or proof
        // that durable journal acknowledgement succeeded. Keep the in-memory
        // packet until its owner-locked recovery operation confirms both.
        if (active && isContextCurrent()) setInspection(value);
      })
      .catch(() => {
        if (active && isContextCurrent())
          setError(
            'Original signed-packet recovery could not be verified. Reload the saved bundle.',
          );
      });
    return () => {
      active = false;
    };
  }, [
    coordinator,
    ownerScope,
    manifest,
    packet,
    revision,
    isContextCurrent,
    serverSignature,
  ]);
  async function exactRetained() {
    if (!isContextCurrent()) throw Error('Bundle context changed.');
    const value = await coordinator.inspect(ownerScope, manifest, packet);
    if (!isContextCurrent() || value.status !== 'retained')
      throw Error('Original signed packet unavailable.');
    return value;
  }
  async function exportPacket() {
    if (running.current || !inspection || inspection.status !== 'retained')
      return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await exactRetained();
      const record = await createJitoPacketRecovery(
        manifest,
        packet,
        value.transaction,
      );
      if (
        !mounted.current ||
        !isContextCurrent() ||
        record.signature !== value.signature
      )
        throw Error('Bundle context changed.');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(record, null, 2)], {
          type: 'application/json',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `bundle-${manifest.id}-packet-${packet + 1}-recovery.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (mounted.current && isContextCurrent())
        setError('Recovery export unavailable. Reload the original bundle.');
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function registerPacket() {
    if (
      running.current ||
      !accepted ||
      !registrationAllowed ||
      !isContextCurrent() ||
      Date.parse(manifest.expiresAt) <= Date.now()
    )
      return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await exactRetained();
      if (
        !registrationAllowed ||
        !isContextCurrent() ||
        Date.parse(manifest.expiresAt) <= Date.now()
      )
        throw Error('Bundle context changed.');
      await register(value.transaction);
      if (mounted.current && isContextCurrent()) setAccepted(false);
    } catch {
      if (mounted.current && isContextCurrent())
        setError(
          'Registration was not confirmed. Keep this original packet and reload bundle history.',
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!inspection || inspection.status === 'absent')
    return error ? <p role="alert">{error}</p> : null;
  return (
    <section aria-label={`In-memory recovery for packet ${packet + 1}`}>
      {inspection.status === 'reserved' ? (
        <p>Signer preparation is in progress; signing has not started.</p>
      ) : inspection.status !== 'retained' ? (
        <p>
          The original wallet signing outcome is still unknown. Do not sign this
          packet again; keep this panel open and check the original wallet and
          bundle history.
        </p>
      ) : (
        <>
          <p>
            The original verified signature is retained only while this panel
            remains mounted. This signed packet can be submitted by anyone who
            has it; keep the recovery file private.
          </p>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => void exportPacket()}
          >
            Download original packet recovery file
          </Button>
          {registrationAllowed && !serverSignature && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={busy}
                  onChange={(event) => setAccepted(event.target.checked)}
                />{' '}
                I approve registering this exact retained packet only.
              </label>
              <Button
                disabled={busy || !accepted}
                variant="outline"
                onClick={() => void registerPacket()}
              >
                Register retained packet only
              </Button>
            </>
          )}
          {(!registrationAllowed || serverSignature) && (
            <p>
              Registration is unavailable for this bundle. You can export the
              original packet without signing or submitting.
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
