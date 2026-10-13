import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect } from 'vitest';
import { ConditionalSigningReview } from './conditional-signing-review';
it('shows exact level terms, captured observation, expiry and separate signing/submission requirements', () => {
  const html = renderToStaticMarkup(
    <ConditionalSigningReview
      conditional={{
        format: 'conditional-preparation-v1',
        orderId: '11111111-1111-4111-8111-111111111111',
        orderRevision: 3,
        level: 2,
        termsSha256: 'a'.repeat(64),
        pair: 'selected-pool',
        direction: 'at-or-below',
        targetUsd: '100.01',
        unitsRaw: '123',
        observedMarketCapUsd: '99.99',
        observedAt: '2026-10-11T12:00:00.000Z',
        expiresAt: '2026-10-11T12:00:30.000Z',
        source: 'api.dexscreener.com',
      }}
    />,
  );
  for (const text of [
    'level 2',
    'revision 3',
    '123 atomic token units',
    'at or below',
    '100.01',
    'selected-pool',
    '99.99',
    '2026-10-11T12:00:30.000Z',
    'a'.repeat(64),
    'separate submission',
    'no background trades',
  ])
    expect(html).toContain(text);
});
it('labels conditional Buy input as SOL and keeps the target token precision separate', () => {
  const html = renderToStaticMarkup(
    <ConditionalSigningReview
      conditional={{
        format: 'conditional-preparation-v2',
        side: 'Buy',
        inputMint: 'So11111111111111111111111111111111111111112',
        inputDecimals: 9,
        outputMint: '11111111111111111111111111111111',
        outputDecimals: 6,
        orderId: '11111111-1111-4111-8111-111111111111',
        orderRevision: 1,
        level: 1,
        termsSha256: 'b'.repeat(64),
        pair: 'selected-pool',
        direction: 'at-or-below',
        targetUsd: '100',
        unitsRaw: '11',
        observedMarketCapUsd: '80',
        observedAt: '2026-10-13T00:00:00.000Z',
        expiresAt: '2026-10-13T00:00:30.000Z',
        source: 'api.dexscreener.com',
      }}
    />,
  );
  expect(html).toContain('Conditional buy');
  expect(html).toContain('11 atomic SOL input units');
  expect(html).toContain('9 decimals');
  expect(html).toContain('6 decimals');
  expect(html).toContain('minimum token output');
  expect(html).not.toContain('11 atomic token units');
});
