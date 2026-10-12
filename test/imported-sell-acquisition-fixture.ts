import bs58 from 'bs58';
import {
  importedLotPage,
  proposedImportedLotLink,
} from '../lib/imported-lot-links';
import type { ImportedTradeReceipt } from '../lib/imported-trade-ledger';
export const acquisitionId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const acquisitionWallet = bs58.encode(new Uint8Array(32).fill(7)),
  acquisitionMint = bs58.encode(new Uint8Array(32).fill(3));
export function acquisitionReceipt(
  n: number,
  side: 'Buy' | 'Sell' = 'Buy',
  units = '3',
  wallet = acquisitionWallet,
  slot = n,
): ImportedTradeReceipt {
  return {
    id: acquisitionId(n),
    projectId: acquisitionId(1),
    preparationId: acquisitionId(n + 10000),
    projectRevision: n,
    walletRevision: 1,
    createdAt: '2026-10-11T00:00:00Z',
    document: {
      network: 'mainnet',
      commitment: 'finalized',
      signatureVerified: true,
      signature: bs58.encode(new Uint8Array(64).fill(n)),
      wallet,
      mint: acquisitionMint,
      decimals: 0,
      preparationSha256: 'a'.repeat(64),
      side,
      tokenUnitsRaw: units,
      source: 'fixture.test',
      observedAt: '2026-10-11T00:00:00Z',
      slot,
      blockTime: null,
      networkFeeLamports: '1',
      nativeChangeRaw: side === 'Buy' ? '-101' : '49',
      rentChangeRaw: '0',
      nativeSettlementRaw: side === 'Buy' ? '-100' : '50',
    },
  };
}
export function acquisitionFixture(count = 55) {
  const receipts = Array.from({ length: count }, (_, i) =>
    acquisitionReceipt(i + 2),
  );
  const links = [];
  if (count) {
    receipts.push(
      acquisitionReceipt(100, 'Sell', '1', acquisitionWallet, 1000),
    );
    links.push(
      proposedImportedLotLink(
        receipts,
        [],
        acquisitionId(1),
        acquisitionId(2),
        acquisitionId(100),
        acquisitionId(200),
        '2026-10-11T00:00:00Z',
      ),
    );
  }
  return importedLotPage(
    {
      projectId: acquisitionId(1),
      mint: acquisitionMint,
      decimals: 0,
      revision: links.length,
      receipts,
      links,
      receiptDocumentHashes: Object.fromEntries(
        receipts.map((r) => [r.id, 'b'.repeat(64)]),
      ),
      observedAt: '2026-10-11T00:00:00Z',
    },
    acquisitionId(1),
    acquisitionMint,
    0,
  );
}
