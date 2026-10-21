import { expect, it, vi } from 'vitest';
import { readWarmupRuntimeReceiptFloor as read } from './wallet-warmup-runtime-receipt-floor';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import {
  walletWarmupSessionDigest as digest,
  WARMUP_SESSION_SOURCE_FORMAT,
} from './wallet-warmup-session-digest';
import { WARMUP_HISTORY_LIMIT } from './warmup-history-capacity';
import type { WarmupV2AttemptRow } from './wallet-warmup-session-v2-attempt-types';
import type { WarmupSessionPreparationCandidate } from './wallet-warmup-session-preparation';
// This isolates parsing/floor derivation over an already admitted source. Native
// integration tests exercise the actual current-context SQL and original guards.
function fixture() {
  const doc = {
    wallet: 'wallet',
    mint: 'mint',
    decimals: 6,
    tokenProgram: 'program',
    slot: 100,
    acquiredRaw: '101',
    signatureVerified: true,
    commitment: 'finalized',
    network: 'mainnet',
    executionAllowed: false,
    instructionsVerified: false,
  };
  const buy = {
    id: 'buy',
    wallet: 'wallet',
    mint: 'mint',
    cycle: 1,
    remainingRaw: '25',
    verified: 1,
    commitment: 'finalized',
    network: 'mainnet',
    document: JSON.stringify(doc),
  };
  const sale = {
    buyId: 'buy',
    consumedRaw: '76',
    verified: 1,
    commitment: 'finalized',
    network: 'mainnet',
    document: JSON.stringify({
      ...doc,
      slot: 200,
      buyReceiptId: 'buy',
      consumedRaw: '76',
    }),
  };
  const source = {
    format: WARMUP_SESSION_SOURCE_FORMAT,
    planDocument: 'plan',
    buys: [buy],
    sells: [sale],
  };
  const candidate = {
    action: { side: 'Sell', wallet: 'wallet', mint: 'mint', cycle: 1 },
    plan: { id: 'plan-id', revision: 2 },
    planDocument: 'plan',
    sellSource: { buyReceiptId: 'buy', remainingRaw: '25', decimals: 6 },
  } as unknown as WarmupSessionPreparationCandidate;
  const lease = {
    owner_id: 'owner',
    journal_id: 'journal',
    review_version: 2,
    review_sha256: 'head',
    terms_sha256: 'terms',
    action_id: 'action',
  } as WarmupV2AttemptRow;
  return { source, candidate, lease };
}
async function run(
  f: ReturnType<typeof fixture>,
  options: { raw?: string; hash?: string; missing?: boolean } = {},
) {
  const raw = options.raw ?? canonical(f.source),
    first = vi.fn(async () =>
      options.missing
        ? null
        : {
            source_document: raw,
            source_sha256: options.hash ?? (await digest(raw)),
          },
    ),
    bind = vi.fn(() => ({ first }));
  const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;
  return {
    value: await read(db, f.lease, f.candidate, new AbortController().signal),
    bind,
  };
}
it('returns the latest selected-lot finalized receipt and binds the exact original context', async () => {
  const f = fixture();
  const result = await run(f);
  expect(result.value).toBe(200);
  expect(result.bind).toHaveBeenCalledWith(
    'owner',
    'journal',
    2,
    'head',
    'terms',
    'action',
    'plan-id',
    2,
  );
});
it.each([
  'hash',
  'canonical',
  'missing',
  'duplicate',
  'no-buy',
  'capacity',
  'network',
  'unverified',
  'slot',
  'wallet',
  'mint',
  'program',
  'decimals',
  'accounting',
  'cycle',
  'format',
  'plan',
  'units',
])('refuses malformed original source: %s', async (kind) => {
  const f = fixture(),
    options: { raw?: string; hash?: string; missing?: boolean } = {};
  const sale = JSON.parse(f.source.sells[0].document);
  if (kind === 'hash') options.hash = '0'.repeat(64);
  if (kind === 'canonical') options.raw = JSON.stringify(f.source, null, 2);
  if (kind === 'missing') options.missing = true;
  if (kind === 'duplicate') f.source.buys.push({ ...f.source.buys[0] });
  if (kind === 'no-buy') f.source.buys = [];
  if (kind === 'capacity')
    f.source.sells = Array.from({ length: WARMUP_HISTORY_LIMIT + 1 }, () => ({
      ...f.source.sells[0],
    }));
  if (kind === 'network') f.source.sells[0].network = 'devnet';
  if (kind === 'unverified') f.source.sells[0].verified = 0;
  if (kind === 'slot') sale.slot = 100;
  if (['wallet', 'mint', 'program', 'decimals'].includes(kind))
    sale[kind === 'program' ? 'tokenProgram' : kind] =
      kind === 'decimals' ? 9 : 'different';
  if (kind === 'accounting') f.source.buys[0].remainingRaw = '24';
  if (kind === 'cycle') f.source.buys[0].cycle = 2;
  if (kind === 'format') f.source.format = 'wrong' as typeof f.source.format;
  if (kind === 'plan') f.source.planDocument = 'different';
  if (kind === 'units') f.source.sells[0].consumedRaw = '18446744073709551616';
  if (f.source.sells[0]) f.source.sells[0].document = JSON.stringify(sale);
  await expect(run(f, options)).rejects.toThrow();
});
