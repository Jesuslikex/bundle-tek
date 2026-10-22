import bs58 from 'bs58';
import {
  executionManifest,
  executionId,
  executionHash,
  executionNow,
} from './warmup-execution-ledger-fixture';
import { parseWarmupExecutionManifest } from '../lib/wallet-warmup-execution-manifest';

/** Schema-admitted synthetic capacity only, never owned consent or provider facts. */
export function executionCapacityManifest(
  kind: 'saved' | 'mixed' | 'paired' = 'saved',
  ids: 'source-like' | 'escaped' | 'unicode' | 'surrogate' = 'source-like',
) {
  const m = executionManifest(),
    mint = m.actions[0].mint,
    tokenProgram = m.actions[0].tokenProgram;
  m.wallets = Array.from({ length: 20 }, (_, i) => ({
    wallet: bs58.encode(new Uint8Array(32).fill(10 + i)),
    revision: 1,
    maximumBuyLamports:
      kind === 'mixed' ? '2000' : kind === 'paired' ? '12000' : '0',
    maximumFeeRentLamports: '3000000000000000000',
  }));
  m.actions = [];
  m.savedLots = [];
  let serial = 0;
  const id = (prefix: string, n: number, sourceLike: string) => {
    if (ids === 'source-like') return sourceLike;
    if (ids === 'unicode')
      return '\u0800'.repeat(243) + prefix + String(n).padStart(12, '0');
    const value = serial++;
    return String.fromCharCode(
      ...Array.from(
        { length: 256 },
        (_, i) =>
          (ids === 'surrogate' ? 0xd800 : 0) +
          (i >= 243 ? (value >> (i - 243)) & 1 : 0),
      ),
    );
  };
  if (ids === 'escaped' || ids === 'surrogate') {
    m.ownerId = (ids === 'escaped' ? '\u0000' : '\ud800').repeat(256);
    m.planId = m.ownerId;
  }
  const common = (wallet: string) => ({
    wallet,
    mint,
    tokenProgram,
    decimals: ids === 'unicode' ? 9 : 18,
    scheduledAt: new Date(executionNow).toISOString(),
    maximumFeeRentLamports: '10000000000000000',
  });
  const cycles = kind === 'paired' ? 120 : 20;
  if (kind !== 'saved')
    for (let w = 0; w < 20; w++)
      for (let cycle = 0; cycle < cycles; cycle++) {
        const wallet = m.wallets[w].wallet,
          n = w * cycles + cycle,
          buyId = id('b', n, `Buy:${cycle}:${wallet}`);
        m.actions.push({
          ...common(wallet),
          id: buyId,
          side: 'Buy',
          inputLamports: '100',
        });
        m.actions.push({
          ...common(wallet),
          id: id('s', n, `Sell:${cycle}:${wallet}`),
          side: 'Sell',
          source: { kind: 'action-buy', actionId: buyId },
        });
      }
  for (
    let i = 0;
    i < (kind === 'mixed' ? 4000 : kind === 'saved' ? 4800 : 0);
    i++
  ) {
    const receiptId = executionId(10000 + i),
      wallet = m.wallets[i % 20].wallet;
    m.savedLots.push({
      receiptId,
      wallet,
      mint,
      tokenProgram,
      decimals: ids === 'unicode' ? 9 : 18,
      remainingRaw: '18446744073709551615',
      sourceSha256: executionHash(10),
    });
    m.actions.push({
      ...common(wallet),
      id: id('l', i, `Sell:${i}:${wallet}:${receiptId}`),
      side: 'Sell',
      source: { kind: 'saved-buy', receiptId },
    });
  }
  m.actions.forEach((a, i) => {
    a.scheduledAt = new Date(executionNow + i * 90000).toISOString();
  });
  m.expiresAt = new Date(executionNow + 4799 * 90000 + 300000).toISOString();
  return parseWarmupExecutionManifest(m);
}
