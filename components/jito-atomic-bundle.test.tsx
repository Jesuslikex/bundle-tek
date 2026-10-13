import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { JitoAtomicBundle } from './jito-atomic-bundle';
import type { TradeSession } from '@/lib/imported-trade-session';
it('exposes bounded group preparation and separate signing/submission rather than automatic execution', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const session: TradeSession = {
    id,
    revision: 1,
    state: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    terms: {
      format: 'imported-trade-session-v1',
      projectId: id,
      projectRevision: 1,
      mint: 'So11111111111111111111111111111111111111112',
      decimals: 9,
      side: 'Buy',
      totalRaw: '1',
      entries: [
        {
          entry: 1,
          wallet: '11111111111111111111111111111111',
          walletRevision: 1,
          amount: '0.000000001',
          unitsRaw: '1',
        },
      ],
    },
  };
  const html = renderToStaticMarkup(
    <JitoAtomicBundle projectId={id} session={session} locked={false} />,
  );
  for (const text of [
    'up to 4 wallet swaps',
    'Prepare and review selected Jito swaps',
    'Jito tip (lamports)',
    'never falls back to individual submission',
    'Acceptance does not guarantee landing',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('Submit complete Jito bundle');
  expect(html).not.toContain('type="password"');
});
