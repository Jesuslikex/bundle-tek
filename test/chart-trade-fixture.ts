import bs58 from 'bs58';
import type { ImportedTradeReceipt } from '../lib/imported-trade-ledger';
import { supplyScope, supplyProject } from './supply-history-fixture';
export function chartTradeFixture(
  side: 'Buy' | 'Sell' = 'Buy',
  n = 1,
  time: number | null = 1791716400 + 60,
): ImportedTradeReceipt {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    projectId: supplyProject,
    preparationId: '00000000-0000-4000-8000-000000000099',
    projectRevision: 1,
    walletRevision: 1,
    createdAt: '2026-10-11T12:01:00Z',
    document: {
      network: 'mainnet',
      mint: supplyScope.mint,
      decimals: 6,
      preparationSha256: 'a'.repeat(64),
      signature: bs58.encode(new Uint8Array(64).fill(n)),
      wallet: supplyScope.wallets[0].address,
      signatureVerified: true,
      commitment: 'finalized',
      side,
      tokenUnitsRaw: '10000',
      source: 'fixture.test',
      observedAt: '2026-10-11T12:01:00Z',
      slot: 130 + n,
      blockTime: time,
      networkFeeLamports: '5000',
      nativeChangeRaw: side === 'Buy' ? '-10005000' : '14995000',
      rentChangeRaw: '0',
      nativeSettlementRaw: side === 'Buy' ? '-10000000' : '15000000',
    },
  };
}
