import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { PoolTradeMovementPanel } from './pool-trade-movement';
import { directMovementFixture } from '../test/direct-movement-fixture';
it('opens as a read-only public transaction review without a signing or trade control', () => {
  const t = directMovementFixture(0, 0), time = new Date().toISOString();
  const html = renderToStaticMarkup(<PoolTradeMovementPanel context={{ projectId: crypto.randomUUID(), revision: 1, pool: t.tokenChanges[0].mint, mint: t.tokenChanges[1].mint, decimals: 6, tapeObservedAt: time, trade: { id: 'fixture', sender: t.address, transaction: bs58.encode(new Uint8Array(64).fill(1)), block: 100, timestamp: time, side: 'Buy', tokenAmount: '0.001', quoteAmount: '0.001', priceUsd: '1', volumeUsd: '1' } }} onClose={() => {}} />);
  for (const text of ['On-chain wallet movement', 'Provider label: Buy', 'Reading confirmed chain evidence', 'does not connect its wallet', 'Refresh chain check']) expect(html).toContain(text);
  expect(html).not.toContain('type="password"'); expect(html).not.toContain('Sign transaction');
});
