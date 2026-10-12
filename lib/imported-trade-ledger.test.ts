import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { importedTradePerformance } from './imported-trade-performance';
import {
  importedTradeReceipt,
  summarizeImportedTrades,
  importedTradePage,
  importedTradeCsv,
} from './imported-trade-ledger';
const projectId = crypto.randomUUID(),
  mint = bs58.encode(new Uint8Array(32).fill(2));
export const receipt = (side: 'Buy' | 'Sell' = 'Buy', index = 1) => ({
  id: crypto.randomUUID(),
  projectId,
  preparationId: crypto.randomUUID(),
  projectRevision: 3,
  walletRevision: 2,
  createdAt: '2026-10-11T01:00:00.000Z',
  document: {
    network: 'mainnet',
    mint,
    decimals: 6,
    preparationSha256: 'a'.repeat(64),
    signature: bs58.encode(new Uint8Array(64).fill(index)),
    wallet: bs58.encode(new Uint8Array(32).fill(3)),
    signatureVerified: true,
    commitment: 'finalized',
    side,
    tokenUnitsRaw: '9007199254740993',
    source: 'mainnet.helius-rpc.com',
    observedAt: '2026-10-11T01:00:01.000Z',
    slot: 42,
    blockTime: null,
    networkFeeLamports: '5000',
    nativeChangeRaw: side === 'Buy' ? '-10015000' : '299995000',
    rentChangeRaw: side === 'Buy' ? '10000' : '0',
    nativeSettlementRaw: side === 'Buy' ? '-10000000' : '300000000',
  },
});
it('keeps exact units above safe integer limits and separates settlement, fees, rent and wallet change', () => {
  const buy = receipt(),
    sell = receipt('Sell', 2);
  sell.document.tokenUnitsRaw = '9007199254740992';
  const rows = [buy, sell].map((r) =>
    importedTradeReceipt(r, projectId, mint, 6),
  );
  expect(summarizeImportedTrades(rows)).toEqual({
    receiptCount: 2,
    buyCount: 1,
    sellCount: 1,
    boughtRaw: '9007199254740993',
    soldRaw: '9007199254740992',
    netTokenChangeRaw: '1',
    solSpentRaw: '10000000',
    solReceivedRaw: '300000000',
    networkFeeLamports: '10000',
    nativeChangeRaw: '289980000',
    rentChangeRaw: '10000',
  });
  const csv = importedTradeCsv(rows);
  expect(csv).toContain('"9007199254740993"');
  expect(csv).toContain('"9007199254.740993"');
  expect(csv).toContain('"-0.01"');
  expect(csv.split('\r\n')).toHaveLength(4);
});
it('rejects unverified, stale identity, duplicate and malformed settlement evidence', () => {
  const r = receipt();
  for (const patch of [
    { signatureVerified: false },
    { commitment: 'confirmed' },
    { network: 'devnet' },
    { mint: 'other' },
    { decimals: 9 },
    { nativeSettlementRaw: '1' },
    { nativeChangeRaw: '-0' },
    { networkFeeLamports: '1.5' },
    { slot: -1 },
    { tokenUnitsRaw: '18446744073709551616' },
    { source: 'https://host/?key=secret' },
  ])
    expect(() =>
      importedTradeReceipt(
        { ...r, document: { ...r.document, ...patch } },
        projectId,
        mint,
        6,
      ),
    ).toThrow();
  const valid = importedTradeReceipt(r, projectId, mint, 6);
  expect(() => summarizeImportedTrades([valid, valid])).toThrow('unique');
  expect(() => summarizeImportedTrades(Array(4001).fill(valid))).toThrow();
});
it('validates whole-project summaries independently of a loaded page and permits recorded net selling', () => {
  const sell = importedTradeReceipt(receipt('Sell'), projectId, mint, 6),
    summary = summarizeImportedTrades([sell]);
  expect(summary.netTokenChangeRaw).toBe('-9007199254740993');
  const page = {
    projectId,
    mint,
    decimals: 6,
    receipts: [sell],
    summary,
    performance: importedTradePerformance([sell]),
    nextCursor: null,
    observedAt: new Date().toISOString(),
  };
  expect(importedTradePage(page, projectId, mint, 6)).toBe(page);
  expect(() =>
    importedTradePage(
      { ...page, summary: { ...summary, netTokenChangeRaw: '0' } },
      projectId,
      mint,
      6,
    ),
  ).toThrow();
  expect(() =>
    importedTradePage({ ...page, nextCursor: 'bad' }, projectId, mint, 6),
  ).toThrow();
  expect(summarizeImportedTrades([]).receiptCount).toBe(0);
});
