import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect } from 'vitest';
import { ImportedSessionReview } from './imported-session-review';
it('shows the exact session entry capture and independent approval requirements', () => {
  const html = renderToStaticMarkup(
    <ImportedSessionReview
      session={{
        format: 'trade-session-entry-v1',
        sessionId: '11111111-1111-4111-8111-111111111111',
        sessionRevision: 1,
        entry: 2,
        unitsRaw: '123',
        termsSha256: 'a'.repeat(64),
      }}
    />,
  );
  for (const text of [
    'Session entry 2',
    'revision 1',
    '123 atomic units',
    'a'.repeat(64),
    'own signature',
    'separate submission',
    'not trade automatically',
  ])
    expect(html).toContain(text);
});

it('shows the immutable scheduled start separately from actual user-approved submission time', () => {
  const html = renderToStaticMarkup(
    <ImportedSessionReview
      session={{
        format: 'trade-session-entry-v2',
        notBefore: '2026-10-11T10:20:30.123Z',
        sessionId: '11111111-1111-4111-8111-111111111111',
        sessionRevision: 1,
        entry: 2,
        unitsRaw: '123',
        termsSha256: 'a'.repeat(64),
      }}
    />,
  );
  expect(html).toContain('Scheduled entry start (UTC):');
  expect(html).toContain('2026-10-11T10:20:30.123Z');
  expect(html).toContain('later after your approval');
});
