'use client';
import { useTradeSessionActivity } from './use-trade-session-activity';
import {
  sessionEventLabels,
  sessionEventDetail,
} from '@/lib/imported-trade-session-events';
import { Button } from './ui/button';
export function TradeSessionTimeline({
  projectId,
  sessionId,
  revision = 0,
}: {
  projectId: string;
  sessionId?: string;
  revision?: number;
}) {
  const history = useTradeSessionActivity(revision, projectId, sessionId);
  return (
    <section
      aria-label="Trade session timeline"
      className="min-w-0 max-w-full space-y-2 break-words"
    >
      <h4>Trade session timeline</h4>
      <p>
        Captured states are retained independently of current wallet and project
        revisions. A saved session is not execution approval.
      </p>
      {history.error && <p role="alert">{history.error}</p>}
      {history.events.map((e) => (
        <article key={e.id} className="rounded-md border p-3">
          <h5>{sessionEventLabels[e.type]}</h5>
          <p>{e.createdAt}</p>
          <p>{sessionEventDetail(e)}</p>
        </article>
      ))}
      {!history.loading && !history.error && history.events.length === 0 && (
        <p>No captured session events.</p>
      )}
      {history.loading && <output>Loading session history…</output>}
      {history.cursor && (
        <Button
          variant="outline"
          disabled={history.loading}
          onClick={history.older}
        >
          Load older session events
        </Button>
      )}
    </section>
  );
}
