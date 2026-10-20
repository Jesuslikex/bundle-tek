import bs58 from 'bs58';
import type { OwnedInventorySources } from '../lib/marketplace-owned-inventory';
/** Public synthetic inventory metadata only; no keys, transactions or provider calls. */
export function marketplaceOwnedFixture(now = Date.now()) {
  const a = bs58.encode(new Uint8Array(32).fill(1)),
    b = bs58.encode(new Uint8Array(32).fill(2)),
    date = (delta: number) => new Date(now - delta).toISOString();
  const observedAt = date(300000),
    oldest = date(30 * 86400000),
    runId = '11111111-1111-4111-8111-111111111111';
  const observation = {
    address: a,
    chain: 'Solana',
    source: 'rpc.example',
    observedAt,
    nativeBalance: '1.234567891',
    currency: 'SOL',
    block: '1234',
    outgoingTransactions: null,
    sampleCount: 50,
    successfulSampleCount: 48,
    oldestObservedAt: oldest,
    latestObservedAt: observedAt,
    coverage:
      'Latest 50 finalized signatures only. Not wallet creation or funding age.',
  };
  const document = {
    chain: 'Solana',
    wallets: [{ address: a, revision: 2 }],
    results: [{ address: a, observation }],
  };
  const sources: OwnedInventorySources = {
    wallets: [
      {
        address: a,
        label: 'Inventory A',
        revision: 2,
        updatedAt: date(3600000),
      },
      {
        address: b,
        label: 'Inventory B',
        revision: 1,
        updatedAt: date(3600000),
      },
    ],
    proofs: [{ address: a, verifiedAt: date(900000) }],
    runs: [
      {
        id: runId,
        revision: 3,
        createdAt: date(600000),
        updatedAt: date(100000),
        document: JSON.stringify(document),
      },
    ],
    receipts: [{ address: a, receiptCount: 5, uniqueSignatures: 5 }],
  };
  return { a, b, sources, document, observation, runId, date };
}
