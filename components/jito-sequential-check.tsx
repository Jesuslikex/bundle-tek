'use client';
import { useEffect, useRef, useState } from 'react';
import {
  requireJitoManifest,
  type JitoBundleManifest,
} from '@/lib/jito-bundle';
import {
  requireJitoSequentialCheckResult,
  type JitoSequentialCheckResult,
} from '@/lib/jito-sequential-check-result';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import { JITO_OWNER_SCOPE_HEADER } from '@/lib/jito-owner-scope';
import { Button } from './ui/button';

const refusedText: Record<JitoSequentialCheckResult['reason'], string> = {
  'frame-integrity-only': 'Local sequential frame checks passed.',
  'bank-unavailable': 'The exact simulation bank is unavailable.',
  'fees-refused': 'Fresh packet fees did not pass the common-bank checks.',
  'simulation-refused': 'Sequential simulation did not pass the frame checks.',
  'rate-limited': 'The provider rate limit stopped this check.',
  interrupted: 'The check was interrupted.',
  'transport-unavailable': 'The configured read transport was unavailable.',
  'http-refused': 'The provider refused this check.',
  'request-binding-differs': 'The simulation request binding differs.',
  'plan-refused': 'These packets could not form a valid read plan.',
};

/** Explicit read only. Never feeds signing, registration, send or chain recovery. */
export function JitoSequentialCheck(props: {
  manifest: JitoBundleManifest;
  disabled: boolean;
  ownerScope: string;
}) {
  return (
    <JitoSequentialCheckForContext key={JSON.stringify(props)} {...props} />
  );
}
function JitoSequentialCheckForContext({
  manifest,
  disabled,
  ownerScope,
}: {
  manifest: JitoBundleManifest;
  disabled: boolean;
  ownerScope: string;
}) {
  const [result, setResult] = useState<JitoSequentialCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const running = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  async function check() {
    if (disabled || running.current || !mounted.current) return;
    running.current = true;
    setBusy(true);
    setResult(null);
    setError('');
    const snapshot = structuredClone(manifest);
    const controller = new AbortController();
    abort.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(55000),
    ]);
    const assertCurrent = () => {
      if (
        signal.aborted ||
        !mounted.current ||
        disabled ||
        !/^[a-f0-9]{64}$/.test(ownerScope) ||
        Date.parse(snapshot.expiresAt) <= Date.now()
      )
        throw Error('Sequential check context changed.');
    };
    try {
      await requireJitoManifest(snapshot, false);
      assertCurrent();
      const response = await fetch('/api/imported-projects/jito-bundles', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: {
          'content-type': 'application/json',
          [JITO_OWNER_SCOPE_HEADER]: ownerScope,
        },
        body: JSON.stringify({
          action: 'check-sequential',
          id: snapshot.id,
          sha256: snapshot.sha256,
        }),
      });
      if (response.headers.get(JITO_OWNER_SCOPE_HEADER) !== ownerScope)
        throw Error('Signed-in account changed.');
      const value = await readBoundedPanelJson(response, signal);
      assertCurrent();
      if (response.status === 429) {
        setError(
          'Wait at least 15 seconds before requesting another bundle provider review. This check does not retry automatically.',
        );
        return;
      }
      if (
        !response.ok ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !Object.hasOwn(value, 'sequentialCheck')
      )
        throw Error('Sequential check unavailable.');
      const checked = requireJitoSequentialCheckResult(
        (value as { sequentialCheck: unknown }).sequentialCheck,
        snapshot,
      );
      assertCurrent();
      setResult(checked);
    } catch {
      if (mounted.current && !disabled)
        setError(
          'Sequential check unavailable or changed. Reload the saved bundle before trying again. Nothing was signed or submitted by this check.',
        );
    } finally {
      controller.abort();
      if (abort.current === controller) abort.current = null;
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Sequential bundle check"
      className="space-y-2 rounded-md border p-3"
    >
      <p>
        Check the saved unsigned packets together, in order, using the
        configured read provider.
      </p>
      <p>
        This diagnostic does not approve signing or execution, qualify the
        provider, or replace chain recovery. It never signs, sends or retries a
        bundle.
      </p>
      <p>
        This check is optional. Sign and Submit do not depend on this check;
        each still requires its own checks and approval. This check does not
        establish provider readiness or complete bundle economic and runtime
        qualification.
      </p>
      <Button
        variant="outline"
        disabled={disabled || busy}
        onClick={() => void check()}
      >
        {busy
          ? 'Checking sequential simulation…'
          : 'Check sequential simulation'}
      </Button>
      {disabled && (
        <p>
          A check requires a current, unsigned bundle. Reload saved history if
          its state changed.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <div className="space-y-1">
          <output className="block">{refusedText[result.reason]}</output>
          <p>
            Original minimum slot: {result.minimumSlot}.{' '}
            {result.simulationSlot === null
              ? 'No common simulation bank was admitted.'
              : `Observed fee bank: ${result.simulationSlot}.`}
          </p>
          {result.fees.length > 0 && (
            <ul>
              {result.fees.map((fee) => (
                <li key={fee.packet}>
                  Packet {fee.packet + 1}: {fee.feeLamports} lamports at slot{' '}
                  {fee.slot}.
                </li>
              ))}
            </ul>
          )}
          <p>
            Observed{' '}
            <time dateTime={result.observedAt}>{result.observedAt}</time>.
            Original review expires{' '}
            <time dateTime={result.expiresAt}>{result.expiresAt}</time>.
          </p>
          <p>
            Economic outcomes, provider provenance, program and signature
            readiness remain unverified. Request a fresh review when these
            packets expire; this check never extends their lifetime.
          </p>
        </div>
      )}
    </section>
  );
}
