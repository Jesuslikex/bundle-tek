import type { TradeSessionCapture } from '@/lib/imported-trade-session';
export function ImportedSessionReview({
  session: s,
}: {
  session: TradeSessionCapture;
}) {
  return (
    <section
      className="warmup-address space-y-2 rounded-md border p-3"
      aria-label="Trade session entry approval"
    >
      <h6>Session entry {s.entry}</h6>
      <p>
        Session {s.sessionId}, revision {s.sessionRevision}. Exact input:{' '}
        {s.unitsRaw} atomic units.
      </p>
      {s.notBefore && (
        <p>
          Scheduled entry start (UTC): {s.notBefore}. Submission may happen
          later after your approval.
        </p>
      )}
      <p>Saved terms fingerprint: {s.termsSha256}.</p>
      <p>
        This entry requires its own signature and separate submission. Other
        wallets in the session will not trade automatically.
      </p>
    </section>
  );
}
