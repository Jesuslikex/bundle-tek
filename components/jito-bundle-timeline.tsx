'use client';
import { useState } from 'react';
import type { JitoBundleRecord } from '@/lib/jito-bundle';
import {
  jitoBundleEventLabel,
  jitoBundleEventDetail,
  type JitoBundleEvent,
} from '@/lib/jito-bundle-events';
import { useJitoBundleActivity } from './use-jito-bundle-activity';
import { Button } from './ui/button';

export function JitoBundleEventList({ events }: { events: JitoBundleEvent[] }) {
  return (
    <ol
      className="min-w-0 space-y-3 break-words"
      aria-label="Recorded bundle transitions"
    >
      {events.map((event) => (
        <li key={event.id} className="space-y-1 rounded-md border p-3">
          <strong>{jitoBundleEventLabel(event)}</strong>
          <p>
            <time dateTime={event.createdAt}>
              {new Date(event.createdAt).toLocaleString()}
            </time>{' '}
            · event {event.sequence}
          </p>
          <p>{jitoBundleEventDetail(event)}</p>
        </li>
      ))}
    </ol>
  );
}
function TimelineContents({ bundle }: { bundle: JitoBundleRecord }) {
  const [refresh, setRefresh] = useState(0);
  const history = useJitoBundleActivity(
    `${bundle.updatedAt}:${bundle.state}:${bundle.signatures.filter(Boolean).length}:${refresh}`,
    bundle.manifest,
  );
  return (
    <section
      aria-label="Saved Jito bundle timeline"
      className="min-w-0 space-y-3 break-words"
    >
      <p>
        Recorded transitions for this exact bundle, newest first. Signature
        registration is separate from submission and finalization. Retained
        baselines do not reconstruct earlier history.
      </p>
      <Button
        variant="outline"
        disabled={history.loading}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh bundle timeline
      </Button>
      {history.error && <p role="alert">{history.error}</p>}
      {history.loading && (
        <output>Loading recorded bundle transitions…</output>
      )}
      {!history.loading && !history.events.length && !history.error && (
        <p>
          No transitions recorded for this bundle. Earlier bundles without
          events can be recorded as baselines from account Activity.
        </p>
      )}
      <JitoBundleEventList events={history.events} />
      {history.cursor && (
        <Button
          variant="outline"
          disabled={history.loading}
          onClick={history.older}
        >
          Load older bundle transitions
        </Button>
      )}
    </section>
  );
}
export function JitoBundleTimeline({ bundle }: { bundle: JitoBundleRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 rounded-md border p-3"
    >
      <summary>Recorded bundle timeline</summary>
      {open && <TimelineContents key={bundle.manifest.id} bundle={bundle} />}
    </details>
  );
}
