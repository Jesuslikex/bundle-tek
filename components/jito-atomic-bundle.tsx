'use client';
import { TransactionDeliveryNotice } from '@/components/transaction-delivery-notice';
import { useEffect, useId, useRef, useState } from 'react';
import {
  requireJitoManifest,
  jitoIntentSelection,
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
export function JitoAtomicBundle(props: JitoAtomicBundleProps) {
  return <JitoAtomicBundleForContext key={JSON.stringify(props)} {...props} />;
}
function JitoAtomicBundleForContext({
  projectId,
  session,
  locked,
}: JitoAtomicBundleProps) {
  const tipId = useId();
  const [eligible, setEligible] = useState<WarmupSigningReview[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [entries, setEntries] = useState<number[]>([]),
    [tip, setTip] = useState('1000'),
    [bundles, setBundles] = useState<JitoBundleRecord[]>([]),
    [acceptedSubmit, setAcceptedSubmit] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true),
    running = useRef(false),
    abort = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      abort.current?.abort();
      clearInterval(timer);
    };
  }, []);
  async function request(body?: object) {
    if (!mounted.current)
      throw new Error('Bundle context changed. Reload saved history.');
    const controller = new AbortController();
    abort.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(60000),
    ]);
    const response = await fetch(
      body
        ? '/api/imported-projects/jito-bundles'
        : `/api/imported-projects/jito-bundles?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(session.id)}`,
      {
        ...(body
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
        cache: 'no-store',
        signal,
      },
    );
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Sign in to recover saved bundles.');
    }
    let value: unknown;
    try {
      value = await readBoundedPanelJson(response, signal);
    } catch {
      throw new Error(
        'Bundle response unavailable. Reload saved history before another action.',
      );
    }
    if (!mounted.current || signal.aborted)
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
  async function action(body?: object) {
    if (!mounted.current)
      throw new Error('Bundle context changed. Reload saved history.');
    if (running.current)
      throw new Error('Wait for the current bundle operation.');
    running.current = true;
    setBusy(true);
    setError('');
    setAcceptedSubmit(null);
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
        if (mounted.current) {
          setBundles((prior) =>
            [
              bundle,
              ...prior.filter((b) => b.manifest.id !== bundle.manifest.id),
            ].slice(0, 20),
          );
          setAcceptedSubmit(null);
        }
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
        if (mounted.current) {
          setBundles(checked);
          setEligible(data.eligible);
          setSelected([]);
          setAcceptedSubmit(null);
        }
      }
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : 'Bundle operation unavailable.',
        );
      throw e;
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const run = (body?: object) => {
    void action(body).catch(() => {});
  };
  return (
    <details className="space-y-3 rounded-md border p-3">
      <summary>Jito atomic bundle · up to 4 wallet swaps</summary>
      <section
        aria-label="Jito atomic bundle"
        className="min-w-0 space-y-3 break-words"
      >
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
        <Button disabled={busy} variant="outline" onClick={() => run()}>
          Load bundle approvals and history
        </Button>
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
            busy || locked || session.state !== 'active' || !entries.length
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
            busy || locked || session.state !== 'active' || !selected.length
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
          const canSign =
            !busy &&
            !locked &&
            session.state === 'active' &&
            m.sessionRevision === session.revision &&
            bundle.state === 'reviewed' &&
            !expired;
          const complete = bundle.signatures.every(Boolean);
          return (
            <article key={m.id} className="space-y-3 rounded-md border p-3">
              <h5>Bundle {m.id}</h5>
              <JitoBundleTimeline bundle={bundle} />
              <JitoSequentialCheck
                key={m.sha256}
                manifest={m}
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
              {bundle.state === 'reviewed' &&
                m.swaps.concat([]).map((_, i) =>
                  bundle.signatures[i] ? null : (
                    <JitoPacketSigning
                      key={`${m.id}:${i}`}
                      manifest={m}
                      packet={i}
                      disabled={!canSign}
                      register={async (transaction) => {
                        await action({
                          action: 'register',
                          id: m.id,
                          sha256: m.sha256,
                          approved: true,
                          packet: i,
                          transaction,
                        });
                      }}
                    />
                  ),
                )}
              {bundle.state === 'reviewed' && !bundle.signatures.at(-1) && (
                <JitoPacketSigning
                  key={`${m.id}:tip`}
                  manifest={m}
                  packet={m.swaps.length}
                  disabled={!canSign}
                  register={async (transaction) => {
                    await action({
                      action: 'register',
                      id: m.id,
                      sha256: m.sha256,
                      approved: true,
                      packet: m.swaps.length,
                      transaction,
                    });
                  }}
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
                    disabled={busy}
                    variant="outline"
                    onClick={() => run({ action: 'recover', id: m.id })}
                  >
                    Check chain outcomes
                  </Button>
                )}
              {!bundle.signatures.some(Boolean) &&
                bundle.state === 'reviewed' && (
                  <Button
                    disabled={busy}
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
