import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoBundleActivity } from '@/lib/jito-bundle-activity';
import type { JitoBundleEvent } from '@/lib/jito-bundle-events';
const history = vi.hoisted(() => vi.fn());
vi.mock('./use-jito-bundle-activity', () => ({
  useJitoBundleActivity: history,
}));
import {
  JitoBundleTimeline,
  JitoBundleEventList,
} from './jito-bundle-timeline';
it('keeps unopened timelines idle without history reads or execution controls', async () => {
  const f = await jitoBundleFixture();
  const record = {
    manifest: f.manifest,
    state: 'reviewed' as const,
    bundleId: null,
    signatures: [null, null],
    updatedAt: f.manifest.createdAt,
  };
  const html = renderToStaticMarkup(<JitoBundleTimeline bundle={record} />);
  expect(html).toContain('Recorded bundle timeline');
  expect(history).not.toHaveBeenCalled();
  expect(html).not.toContain('Refresh bundle timeline');
  expect(html).not.toContain('Submit');
  expect(html).not.toContain('type="password"');
});
it('shows captured registration and uncertain submission separately with event timestamps', async () => {
  const f = await jitoBundleFixture();
  const projection = jitoBundleActivity({
    manifest: f.manifest,
    state: 'submitting',
    bundleId: null,
    signatures: [f.swap.signed.signature, f.tip.signed.signature],
    updatedAt: f.manifest.createdAt,
  });
  const event: JitoBundleEvent = {
    id: 'a'.repeat(32),
    sequence: 3,
    type: 'bundle.submitting',
    packet: null,
    bundleId: f.manifest.id,
    projectId: f.manifest.projectId,
    sessionId: f.manifest.sessionId,
    document: projection,
    createdAt: f.manifest.createdAt,
  };
  const registered: JitoBundleEvent = {
    ...event,
    id: 'b'.repeat(32),
    sequence: 2,
    type: 'packet.registered',
    packet: 0,
    document: { ...projection, state: 'reviewed', signedCount: 1 },
  };
  const html = renderToStaticMarkup(
    <JitoBundleEventList events={[event, registered]} />,
  );
  expect(html).toContain('submission reserved; outcome uncertain');
  expect(html).toContain('packet 1 signature registered');
  expect(html).toContain('1/2 signatures registered');
  expect(html).toContain('dateTime="' + event.createdAt + '"');
  expect(html).toContain('do not establish submission');
  expect(html).not.toContain('bundle finalized');
  expect(html).not.toContain(f.swap.signed.transaction);
  expect(html).not.toContain(f.swap.signed.signature);
});
