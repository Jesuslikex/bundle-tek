'use client';
import { useSessionJobActivity } from './use-session-job-activity';
import {
  sessionJobLabels,
  sessionJobEventDetail,
} from '@/lib/session-preparation-job-events';
import { Button } from './ui/button';
export function SessionJobTimeline({
  projectId,
  sessionId,
  revision = 0,
}: {
  projectId: string;
  sessionId?: string;
  revision?: number;
}) {
  const history = useSessionJobActivity(revision, projectId, sessionId);
  return (
    <section
      aria-label="Preparation job timeline"
      className="min-w-0 max-w-full space-y-2 break-words"
    >
      <h4>Preparation job timeline</h4>
      <p>
        Captured job transitions are retained independently of current job
        state. Unsigned preparation does not authorize signing or submission.
      </p>
      {history.error && <p role="alert">{history.error}</p>}
      {history.events.map((e) => (
        <article key={e.id} className="rounded-md border p-3">
          <h5>{sessionJobLabels[e.document.state]}</h5>
          <p>{e.createdAt}</p>
          <p>{sessionJobEventDetail(e)}</p>
        </article>
      ))}
      {!history.loading && !history.error && history.events.length === 0 && (
        <p>No captured job events.</p>
      )}
      {history.loading && <output>Loading job history…</output>}
      {history.cursor && (
        <Button
          variant="outline"
          disabled={history.loading}
          onClick={history.older}
        >
          Load older job events
        </Button>
      )}
    </section>
  );
}
