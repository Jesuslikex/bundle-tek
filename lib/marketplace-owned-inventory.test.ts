import { expect, it } from 'vitest';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import {
  buildMarketplaceOwnedInventory,
  admitMarketplaceOwnedInventory,
  MarketplaceInventoryClockError,
  MarketplaceInventoryCapacityError,
  marketplaceInventoryCapacityBody,
  isMarketplaceInventoryCapacityResponse,
} from './marketplace-owned-inventory';
const now = Date.parse('2026-10-20T12:00:00Z');

it('retains the100-history-check bound and distinguishes101 as a non-partial capacity refusal', () => {
  const f = marketplaceOwnedFixture(now),
    original = f.sources.runs[0] as { document: string };
  f.sources.runs = Array.from({ length: 100 }, (_, index) => ({
    ...original,
    id: `run-${index}`,
  }));
  expect(buildMarketplaceOwnedInventory(f.sources, now).wallets).toHaveLength(
    2,
  );
  f.sources.runs.push({ ...original, id: 'run-100' });
  expect(() => buildMarketplaceOwnedInventory(f.sources, now)).toThrow(
    MarketplaceInventoryCapacityError,
  );
  try {
    buildMarketplaceOwnedInventory(f.sources, now);
  } catch (error) {
    expect(error).toMatchObject({ errorCode: 'saved-history-run-limit' });
    expect(error).not.toHaveProperty('wallets');
  }
});
it('keeps the aggregate4MiB history boundary exact and refuses one additional byte without partial evidence', () => {
  const f = marketplaceOwnedFixture(now),
    original = f.sources.runs[0] as { document: string };
  const padded =
    original.document +
    ' '.repeat(65536 - new TextEncoder().encode(original.document).length);
  f.sources.runs = Array.from({ length: 64 }, (_, index) => ({
    ...original,
    id: `run-${index}`,
    document: padded,
  }));
  expect(
    f.sources.runs.reduce<number>(
      (sum, value) =>
        sum +
        new TextEncoder().encode((value as { document: string }).document)
          .length,
      0,
    ),
  ).toBe(4 * 1024 * 1024);
  expect(buildMarketplaceOwnedInventory(f.sources, now).wallets).toHaveLength(
    2,
  );
  (f.sources.runs[63] as { document: string }).document += ' ';
  expect(() => buildMarketplaceOwnedInventory(f.sources, now)).toThrow(
    MarketplaceInventoryCapacityError,
  );
  try {
    buildMarketplaceOwnedInventory(f.sources, now);
  } catch (error) {
    expect(error).toMatchObject({ errorCode: 'saved-history-byte-limit' });
  }
});
it('admits only the exact fixed409 capacity body with no inventory or authority', () => {
  const body = marketplaceInventoryCapacityBody(
    new MarketplaceInventoryCapacityError('saved-history-run-limit'),
  );
  expect(isMarketplaceInventoryCapacityResponse(409, body)).toBe(true);
  expect(
    isMarketplaceInventoryCapacityResponse(
      409,
      marketplaceInventoryCapacityBody(
        new MarketplaceInventoryCapacityError('saved-history-byte-limit'),
      ),
    ),
  ).toBe(true);
  for (const value of [
    { ...body, error: 'server-controlled arbitrary error' },
    { ...body, errorCode: 'unknown' },
    { ...body, wallets: [] },
    { ...body, listingEnabled: true },
    { ...body, inventoryShown: true },
    { ...body, format: 'other' },
    null,
    [],
  ])
    expect(isMarketplaceInventoryCapacityResponse(409, value)).toBe(false);
  for (const status of [200, 401, 403, 503])
    expect(isMarketplaceInventoryCapacityResponse(status, body)).toBe(false);
  const getter = { ...body };
  Object.defineProperty(getter, 'error', {
    get() {
      throw Error('must not invoke accessors');
    },
    enumerable: true,
  });
  expect(isMarketplaceInventoryCapacityResponse(409, getter)).toBe(false);
});
it('keeps the exact inventory freshness boundaries and identifies stale or ahead-of-device time', () => {
  const inventory = buildMarketplaceOwnedInventory(
    marketplaceOwnedFixture(now).sources,
    now,
  );
  expect(() => admitMarketplaceOwnedInventory(inventory, now - 1)).toThrow(
    MarketplaceInventoryClockError,
  );
  expect(admitMarketplaceOwnedInventory(inventory, now + 60000)).toEqual(
    inventory,
  );
  expect(() => admitMarketplaceOwnedInventory(inventory, now + 60001)).toThrow(
    MarketplaceInventoryClockError,
  );
});
it('separates observed activity, historical control proof, raw warmup receipts and unknown funding age', () => {
  const f = marketplaceOwnedFixture(now),
    result = buildMarketplaceOwnedInventory(f.sources, now);
  expect(admitMarketplaceOwnedInventory(result, now)).toEqual(result);
  expect(result).toMatchObject({
    listingEnabled: false,
    purchaseEnabled: false,
    deliveryEnabled: false,
  });
  expect(result.wallets[0]).toMatchObject({
    ownershipProofAt: f.date(900000),
    oldestRecordedActivityAt: f.date(30 * 86400000),
    observedActivityAgeSeconds: 30 * 86400,
    warmupReceiptCount: 5,
    latestHistory: {
      balanceLamports: '1234567891',
      sampleCount: 50,
      successfulSampleCount: 48,
    },
  });
  expect(result.wallets[1]).toMatchObject({
    ownershipProofAt: null,
    latestHistory: null,
    oldestRecordedActivityAt: null,
    observedActivityAgeSeconds: null,
    warmupReceiptCount: 0,
  });
  expect(result.wallets[0]).not.toHaveProperty('fundedAt');
  expect(result.wallets[0]).not.toHaveProperty('createdAt');
});
it('retains older sampled evidence even when newer snapshots no longer contain that sample', () => {
  const f = marketplaceOwnedFixture(now),
    older = structuredClone(f.document);
  older.wallets[0].revision = 1;
  older.results[0].observation.oldestObservedAt = f.date(60 * 86400000);
  older.results[0].observation.latestObservedAt = f.date(900000);
  older.results[0].observation.observedAt = f.date(900000);
  f.sources.runs.push({
    id: 'older',
    revision: 1,
    createdAt: f.date(1200000),
    updatedAt: f.date(800000),
    document: JSON.stringify(older),
  });
  const row = buildMarketplaceOwnedInventory(f.sources, now).wallets[0];
  expect(row.observedActivityAgeSeconds).toBe(60 * 86400);
  expect(row.latestHistory?.runId).toBe(f.runId);
});
it('reports failed saved checks without erasing successful evidence or fabricating an empty history', () => {
  const f = marketplaceOwnedFixture(now);
  f.sources.runs.push({
    id: 'failed',
    revision: 2,
    createdAt: f.date(10000),
    updatedAt: f.date(1000),
    document: JSON.stringify({
      chain: 'Solana',
      wallets: [{ address: f.a, revision: 2 }],
      results: [{ address: f.a, error: 'Provider unavailable' }],
    }),
  });
  const row = buildMarketplaceOwnedInventory(f.sources, now).wallets[0];
  expect(row.failedHistoryChecks).toBe(1);
  expect(row.savedHistoryChecks).toBe(1);
  expect(row.latestHistory?.runId).toBe(f.runId);
});
it('preserves captured wallet revisions and never treats a metadata edit as a history refresh', () => {
  const f = marketplaceOwnedFixture(now);
  (f.sources.wallets[0] as { revision: number }).revision = 3;
  const row = buildMarketplaceOwnedInventory(f.sources, now).wallets[0];
  expect(row.latestHistory?.walletRevision).toBe(2);
  expect(row.revision).toBe(3);
});
it('does not infer first funding, creation time or age from an empty provider sample', () => {
  const f = marketplaceOwnedFixture(now);
  Object.assign(f.document.results[0].observation, {
    sampleCount: 0,
    successfulSampleCount: 0,
    oldestObservedAt: null,
    latestObservedAt: null,
  });
  (f.sources.runs[0] as { document: string }).document = JSON.stringify(
    f.document,
  );
  const row = buildMarketplaceOwnedInventory(f.sources, now).wallets[0];
  expect(row.observedActivityAgeSeconds).toBeNull();
  expect(row.latestHistory?.sampleCount).toBe(0);
});
it.each([
  'duplicate-wallet',
  'duplicate-proof',
  'private-key',
  'future-proof',
  'future-sample',
  'reverse-times',
  'mismatched-wallet',
  'duplicate-result',
  'bad-source',
  'both-result-types',
  'bad-count',
  'missing-capture',
  'duplicate-run',
  'capacity',
] as const)('refuses inconsistent source evidence: %s', (kind) => {
  const f = marketplaceOwnedFixture(now);
  if (kind === 'duplicate-wallet') f.sources.wallets.push(f.sources.wallets[0]);
  if (kind === 'duplicate-proof') f.sources.proofs.push(f.sources.proofs[0]);
  if (kind === 'private-key')
    Object.assign(f.sources.wallets[0] as object, {
      privateKey: 'not-a-real-key',
    });
  if (kind === 'future-proof')
    Object.assign(f.sources.proofs[0] as object, { verifiedAt: f.date(-1) });
  if (kind === 'future-sample')
    f.document.results[0].observation.oldestObservedAt = f.date(-1);
  if (kind === 'reverse-times')
    f.document.results[0].observation.latestObservedAt = f.date(31 * 86400000);
  if (kind === 'mismatched-wallet')
    f.document.results[0].observation.address = f.b;
  if (kind === 'duplicate-result')
    f.document.results.push(f.document.results[0]);
  if (kind === 'bad-source')
    f.document.results[0].observation.source =
      'https://rpc.example/private-key';
  if (kind === 'both-result-types')
    Object.assign(f.document.results[0], { error: 'bad' });
  if (kind === 'bad-count')
    f.document.results[0].observation.successfulSampleCount = 51;
  if (kind === 'missing-capture') f.document.wallets[0].address = f.b;
  if (kind === 'duplicate-run') f.sources.runs.push(f.sources.runs[0]);
  if (kind === 'capacity')
    f.sources.wallets = Array(501).fill(f.sources.wallets[0]);
  (f.sources.runs[0] as { document: string }).document = JSON.stringify(
    f.document,
  );
  expect(() => buildMarketplaceOwnedInventory(f.sources, now)).toThrow();
});
it.each([
  'authority',
  'age',
  'duplicate',
  'counts',
  'unsupported-field',
  'unbacked-age',
  'zero-sample-with-time',
  'stale',
] as const)('rejects altered public inventory before display: %s', (kind) => {
  const f = marketplaceOwnedFixture(now),
    result = buildMarketplaceOwnedInventory(f.sources, now);
  if (kind === 'authority') Object.assign(result, { listingEnabled: true });
  if (kind === 'age') result.wallets[0].observedActivityAgeSeconds = 999999;
  if (kind === 'duplicate') result.wallets.push(result.wallets[0]);
  if (kind === 'counts') result.wallets[0].warmupUniqueSignatures = 6;
  if (kind === 'unsupported-field')
    Object.assign(result.wallets[0], { fundedAt: f.date(30 * 86400000) });
  if (kind === 'unbacked-age') {
    result.wallets[0].latestHistory = null;
    result.wallets[0].savedHistoryChecks = 0;
  }
  if (kind === 'zero-sample-with-time')
    result.wallets[0].latestHistory!.sampleCount = 0;
  expect(() =>
    admitMarketplaceOwnedInventory(
      result,
      now + (kind === 'stale' ? 60001 : 0),
    ),
  ).toThrow();
});
