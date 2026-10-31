'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  JITO_UNSIGNED_REVIEW_LIMIT,
  openJitoCpmmUnsignedReview,
  saveJitoCpmmUnsignedReview,
  type JitoCpmmReviewContext,
  type JitoCpmmUnsignedReview,
} from '@/lib/jito-cpmm-unsigned-review';
import { Button } from './ui/button';
import { awaitJitoEvidence } from '@/lib/jito-evidence-json';

type Props = JitoCpmmReviewContext & {
  disabled: boolean;
  isContextCurrent: () => boolean;
};
const recordedSpan = (review: JitoCpmmUnsignedReview) =>
  String(BigInt(review.maximumSlot) - BigInt(review.minimumSlot));
export function JitoCpmmUnsignedReviewPanel(props: Props) {
  return (
    <ReviewForContext
      key={JSON.stringify([
        props.ownerScope,
        props.projectId,
        props.sessionId,
        props.disabled,
      ])}
      {...props}
    />
  );
}
function ReviewForContext(props: Props) {
  const approvedNow = useRef(false);
  const id = useId(),
    mounted = useRef(true),
    busyNow = useRef(false);
  const [review, setReview] = useState<JitoCpmmUnsignedReview | null>(null);
  const [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  const current = () =>
    !props.disabled && mounted.current && props.isContextCurrent();
  async function open(file: File) {
    if (!current() || busyNow.current) return;
    busyNow.current = true;
    approvedNow.current = false;
    setBusy(true);
    setApproved(false);
    setReview(null);
    setNotice('');
    const controller = new AbortController();
    abort.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10000),
    ]);
    try {
      if (file.size < 1 || file.size > JITO_UNSIGNED_REVIEW_LIMIT)
        throw Error();
      // File reads have no provider or wallet side effects. The timeout fences
      // publication even when the browser's native read cannot be cancelled.
      const buffer = await awaitJitoEvidence(signal, file.arrayBuffer());
      signal.throwIfAborted();
      if (!current() || buffer.byteLength !== file.size) throw Error();
      const opened = await openJitoCpmmUnsignedReview(new Uint8Array(buffer), {
        ownerScope: props.ownerScope,
        projectId: props.projectId,
        sessionId: props.sessionId,
      });
      signal.throwIfAborted();
      if (!current()) throw Error();
      setReview(opened.review);
      setNotice(
        opened.recovered
          ? 'Historical review reopened. Approval was not restored. Review every value again.'
          : 'Research file opened for inspection. Its checksum does not authenticate the provider or wallet ownership.',
      );
    } catch {
      if (current())
        setNotice(
          'Review file unavailable, changed, too large or for a different account, project or session. No action was resumed.',
        );
    } finally {
      controller.abort();
      busyNow.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function save() {
    if (!current() || busyNow.current || !approvedNow.current || !review)
      return;
    busyNow.current = true;
    approvedNow.current = false;
    setApproved(false);
    setBusy(true);
    const original = review;
    try {
      const saved = await saveJitoCpmmUnsignedReview(
        original,
        {
          ownerScope: props.ownerScope,
          projectId: props.projectId,
          sessionId: props.sessionId,
        },
        true,
      );
      if (!current()) throw Error();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(saved, null, 2)], {
          type: 'application/json',
        }),
      );
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `jito-unsigned-review-${original.sha256}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      setApproved(false);
      setNotice(
        'Review file prepared for download. Keep it to reopen this historical inspection. It cannot sign, send or restore approval.',
      );
    } catch {
      if (current())
        setNotice(
          'Review could not be saved. Reload the account context and review again.',
        );
    } finally {
      busyNow.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <details className="space-y-3 rounded-md border p-3">
      <summary>Raydium unsigned research review and recovery</summary>
      <p>
        Signing and submission are off. This separate public-reference research
        flow does not qualify your saved user bundle.
      </p>
      <p>
        Open the compact unsigned review file from the local qualifier, or a
        previously saved review. Imported results are historical, file-reported
        evidence, not a live price, an authenticated provider proof or
        authorization.
      </p>
      <label htmlFor={id}>Open unsigned review file (maximum 16 KiB)</label>
      <input
        id={id}
        type="file"
        className="block w-full min-w-0 max-w-full"
        accept="application/json,.json"
        disabled={props.disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void open(file);
        }}
      />
      {props.disabled && (
        <p>Verify the signed-in account and load bundle history first.</p>
      )}
      {notice && <output className="block">{notice}</output>}
      {review && (
        <section
          aria-label="Exact unsigned Raydium research plan"
          className="min-w-0 space-y-2 break-words"
        >
          <p>
            Public reference payer (ownership not verified):{' '}
            <code>{review.payer}</code>
          </p>
          <p>
            Pool: <code>{review.pool}</code>
          </p>
          <p>
            Input mint: <code>{review.inputMint}</code>. Output mint:{' '}
            <code>{review.outputMint}</code>.
          </p>
          <p>
            Amounts in raw token units: input {review.inputRaw}; expected output{' '}
            {review.expectedOutputRaw}; encoded minimum output{' '}
            {review.minimumOutputRaw}.
          </p>
          <p>
            Amounts in lamports: network fees {review.networkFeeLamports} (cap{' '}
            {review.maximumFeeLamports}); tip {review.tipLamports}; account
            creation rent {review.createdRentLamports}; retained system rent{' '}
            {review.retainedRentLamports}.
          </p>
          <p>
            Recorded independent minimum-value difference:{' '}
            {review.priceDifferenceBps} basis points.
          </p>
          <p>
            Recorded slots: {review.minimumSlot} → {review.simulationSlot} →{' '}
            {review.maximumSlot}; span {recordedSpan(review)} of 32. Historical
            capture:{' '}
            <time dateTime={review.capturedAt}>{review.capturedAt}</time>.
          </p>
          <p>
            Blockhash: <code>{review.blockhash}</code>; last valid block height{' '}
            {review.lastValidBlockHeight}. Current validity has not been
            checked.
          </p>
          <ol>
            {review.packetSha256s.map((hash, i) => (
              <li key={hash}>
                {
                  [
                    'Simulation-only anchor',
                    'USDC account setup',
                    'Raydium swap',
                    'Jito tip',
                  ][i]
                }
                : <code>{hash}</code>
              </li>
            ))}
          </ol>
          <p>
            Exact review checksum: <code>{review.sha256}</code>. A checksum
            detects changes; it does not prove who created the file.
          </p>
          <label>
            <input
              type="checkbox"
              checked={approved}
              disabled={busy || props.disabled}
              onChange={(e) => {
                if (current() && !busyNow.current) {
                  approvedNow.current = e.target.checked;
                  setApproved(e.target.checked);
                }
              }}
            />{' '}
            I approve saving this exact unsigned inspection only. This does not
            authorize signing, submission or another trade.
          </label>
          <Button
            disabled={!approved || busy || props.disabled}
            onClick={() => void save()}
          >
            Save reviewed plan file
          </Button>
        </section>
      )}
    </details>
  );
}
