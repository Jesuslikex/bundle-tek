import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { JitoChainObservationView } from './jito-chain-observation';
import type { JitoChainObservation } from '@/lib/jito-chain-observation';

it('describes partial provider reports without granting an action or asserting atomic settlement', () => {
  const observation: JitoChainObservation = {
    format: 'jito-chain-observation-v1',
    bundleId: 'bundle',
    bundleSha256: 'ab'.repeat(32),
    state: 'submitted',
    observedAt: '2026-10-28T12:00:00.000Z',
    packets: [
      { packet: 0, signature: 'sig', status: 'finalized-failure', slot: 300 },
      { packet: 1, signature: 'tip', status: 'not-found', slot: null },
    ],
  };
  const html = renderToStaticMarkup(
    <JitoChainObservationView observation={observation} swapCount={1} />,
  );
  expect(html).toContain('Provider-reported packet outcomes');
  expect(html).toContain('Finalized, failure reported');
  expect(html).toContain('Not found by this provider');
  expect(html).toContain('not verified settlement receipts or proof');
  expect(html).toContain('Do not resend');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('<a ');
});
