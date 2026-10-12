import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreparationHistoryRecord } from './imported-preparation-history';
import { preparationHistoryFixture } from '../test/imported-preparation-history-fixture';
import { WarmupBuyReceiptRecord } from './warmup-buy-receipts';
import type { SavedWarmupBuyReceipt } from '@/lib/warmup-buy-receipt';
it('distinguishes historic simulation success/failure from receipts and never offers signing', () => {
  const document = preparationHistoryFixture();
  const record = {
    id: 'fixture',
    projectId: 'fixture',
    projectRevision: 1,
    walletRevision: 2,
    createdAt: document.quotedAt,
    document,
  };
  const html = renderToStaticMarkup(
    <PreparationHistoryRecord record={record} projectRevision={3} />,
  );
  expect(html).toContain('Simulation completed');
  expect(html).toContain('older project revision');
  expect(html).toContain(document.transaction.sha256);
  expect(html).toContain('-5000');
  expect(html).toContain('no signing or execution clearance');
  expect(html).not.toContain('<button');
  const failed = renderToStaticMarkup(
    <PreparationHistoryRecord
      record={{
        ...record,
        document: {
          ...document,
          simulation: {
            ...document.simulation,
            succeeded: false,
            nativeChangeRaw: null,
          },
        },
      }}
      projectRevision={3}
    />,
  );
  expect(failed).toContain('Simulation failed');
  expect(failed).toContain('unavailable');
  const warmup = renderToStaticMarkup(
    <PreparationHistoryRecord
      record={{
        ...record,
        cycle: 3,
        document: {
          ...document,
          balance: undefined,
          inventory: {
            source: 'fixture.test',
            observedAt: document.quotedAt,
            minSlot: 100,
            maxSlot: 101,
            requestedRaw: '1',
            unfrozenRaw: '100',
            amountCovered: true,
            decimals: 6,
            tokenProgram: 'fixture-program',
            limitations: 'No buy receipt linkage.',
          },
        },
      }}
      projectRevision={3}
      contextLabel="plan"
    />,
  );
  expect(warmup).toContain('older plan revision');
  expect(warmup).toContain('cycle 3');
  expect(warmup).toContain('100 unfrozen atomic units');
  expect(warmup).toContain('No buy receipt linkage.');
  expect(warmup).not.toContain('Balance source:');
  const linked = renderToStaticMarkup(
    <PreparationHistoryRecord
      record={{
        ...record,
        document: {
          ...document,
          buyReceipt: {
            receiptId: 'saved-buy',
            preparationId: 'buy-preparation',
            signature: 'reviewed-signature',
            acquiredRaw: '101',
            decimals: 6,
            slot: 100,
            preparationSha256: 'b'.repeat(64),
            limitations: 'Later consumption not reconstructed.',
          },
        },
      }}
      projectRevision={1}
    />,
  );
  expect(linked).toContain('Matching buy receipt: reviewed-signature');
  expect(linked).toContain('acquired 101 atomic units');
  expect(linked).toContain('Later consumption not reconstructed.');
});

it('renders immutable conditional level and sampled evidence separately from execution permission', () => {
  const document = preparationHistoryFixture();
  const html = renderToStaticMarkup(
    <PreparationHistoryRecord
      record={{
        id: 'fixture',
        projectId: 'fixture',
        projectRevision: 1,
        walletRevision: 1,
        createdAt: document.quotedAt,
        document: {
          ...document,
          conditional: {
            format: 'conditional-preparation-v1',
            orderId: '00000000-0000-4000-8000-000000000001',
            orderRevision: 1,
            level: 2,
            termsSha256: 'c'.repeat(64),
            pair: 'fixture-pool',
            direction: 'at-or-above',
            targetUsd: '4267.25',
            unitsRaw: '1',
            observedMarketCapUsd: '4470.5',
            observedAt: document.quotedAt,
            expiresAt: document.expiresAt,
            source: 'api.dexscreener.com',
          },
        },
      }}
      projectRevision={1}
    />,
  );
  expect(html).toContain('level 2');
  expect(html).toContain('$4267.25');
  expect(html).toContain('$4470.5');
  expect(html).toContain('c'.repeat(64));
  expect(html).toContain(
    'Historical condition evidence does not approve execution',
  );
  expect(html).not.toContain('<button');
});
it('renders retained buy receipts with exact units and separate network fees, without sign controls', () => {
  const record = {
    id: 'saved-receipt',
    preparationId: 'saved-buy',
    planId: 'archived-plan',
    planRevision: 2,
    cycle: 3,
    walletRevision: 4,
    createdAt: new Date().toISOString(),
    document: {
      acquiredRaw: '101',
      decimals: 6,
      slot: 100,
      wallet: 'public-wallet',
      mint: 'public-mint',
      signature: 'public-signature',
      networkFeeLamports: '5000',
      nativeChangeRaw: '-1005000',
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
      limitations:
        'No execution clearance. Later consumption not reconstructed.',
    },
  } as SavedWarmupBuyReceipt;
  const html = renderToStaticMarkup(<WarmupBuyReceiptRecord record={record} />);
  expect(html).toContain('0.000101 tokens (101 atomic units)');
  expect(html).toContain('Cycle 3 · plan r2 · wallet r4');
  expect(html).toContain('Network fee: 5000 lamports');
  expect(html).toContain('Native change: -1005000 lamports');
  expect(html).toContain('Saved buy preparation: saved-buy');
  expect(html).toContain('No execution clearance');
  expect(html).not.toContain('<button');
});
