import { beforeAll, expect, it } from 'vitest';
import { pumpGroupChainEffectsFixture } from '../test/pump-group-chain-effects-fixture';
import {
  collectPumpGroupChainEffects,
  parsePumpGroupChainEffects,
} from './pump-group-chain-effects';
import { pumpHolderDigest } from './pump-holder-review';
import { parsePumpGroupRequest } from './pump-launch-group-request';
import type { PumpLaunchRpc } from './pump-launch-simulation';
let f: Awaited<ReturnType<typeof pumpGroupChainEffectsFixture>>,
  stock: typeof f;
beforeAll(async () => {
  f = await pumpGroupChainEffectsFixture();
  stock = await pumpGroupChainEffectsFixture(true);
}, 120000);
const collect = (
  rpc: PumpLaunchRpc = f.rpc,
  fixture = f,
  signal = new AbortController().signal,
) => collectPumpGroupChainEffects(fixture.review, fixture.signed, signal, rpc);
it('reconciles exact finalized native launch deltas and saved token targets without granting permissions or inventing P&L', async () => {
  const report = await collect();
  expect(report.complete).toBe(true);
  expect(
    report.packets.every((p) => p.wallets.length === report.wallets.length),
  ).toBe(true);
  expect(
    report.wallets.every(
      (w) =>
        w.complete && ['matches', 'not-requested'].includes(w.targetStatus),
    ),
  ).toBe(true);
  expect(report.knownNetworkFeeRaw).toBe(
    String(f.signed.packets.length * 5000),
  );
  expect(report.wallets[0].knownSolDeltaRaw.startsWith('-')).toBe(true);
  expect(report).toMatchObject({
    tipIncluded: false,
    currentHoldings: false,
    economicSettlementVerified: false,
    atomicityVerified: false,
    executionAllowed: false,
    reservationsChanged: false,
  });
  expect(
    await parsePumpGroupChainEffects(
      JSON.parse(JSON.stringify(report)),
      f.group,
    ),
  ).toEqual(report);
});
it('uses exact SPL quote precision, owner/program and integer amounts beyond JavaScript number precision', async () => {
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    const value = await stock.rpc(method, params, signal);
    if (method !== 'getTransaction') return value;
    const r = value as (typeof stock.receipts)[number];
    for (const before of r.meta.preTokenBalances.filter(
      (t) => t.mint === stock.review.input.create.quoteMint,
    )) {
      const after = r.meta.postTokenBalances.find(
        (t) => t.accountIndex === before.accountIndex,
      )!;
      const delta =
        BigInt(after.uiTokenAmount.amount) -
        BigInt(before.uiTokenAmount.amount);
      before.uiTokenAmount.amount = '900719925474099300';
      after.uiTokenAmount.amount = (900719925474099300n + delta).toString();
    }
    return r;
  };
  const report = await collect(rpc, stock);
  expect(report.complete).toBe(true);
  expect(
    report.wallets
      .filter((w) => w.targetKind !== 'none')
      .every((w) => w.knownQuoteDeltaRaw === '-1000'),
  ).toBe(true);
  expect(report.quoteDecimals).toBe(
    stock.fixture.input.create.quoteMintAccount!.data[44],
  );
  expect(await parsePumpGroupChainEffects(report, stock.group)).toEqual(report);
});
it('keeps missing receipts and missing token metadata incomplete with explicitly partial subtotals', async () => {
  const missing = await collect(async (method, params, signal) =>
    method === 'getTransaction' &&
    params[0] === f.signed.packets.at(-1)!.signature
      ? null
      : f.rpc(method, params, signal),
  );
  expect(missing.complete).toBe(false);
  expect(missing.packets.at(-1)?.outcome).toBe('not-observed');
  expect(missing.wallets.every((w) => !w.complete)).toBe(true);
  const absent = await collect(async (method, params, signal) => {
    const value = await f.rpc(method, params, signal);
    if (method === 'getTransaction')
      delete (value as { meta: { postTokenBalances?: unknown } }).meta
        .postTokenBalances;
    return value;
  });
  expect(absent.complete).toBe(false);
  expect(absent.wallets.some((w) => w.targetStatus === 'unknown')).toBe(true);
  expect(await parsePumpGroupChainEffects(absent, f.group)).toEqual(absent);
});
it('retains known fees when balance metadata is absent and never treats unknown effects as zero', async () => {
  const report = await collect(async (method, params, signal) => {
    const value = await f.rpc(method, params, signal);
    if (method === 'getTransaction')
      delete (value as { meta: { preBalances?: unknown } }).meta.preBalances;
    return value;
  });
  expect(report.complete).toBe(false);
  expect(report.knownNetworkFeeRaw).toBe(
    String(f.signed.packets.length * 5000),
  );
  expect(
    report.packets.every((p) => !p.effectsAvailable && p.wallets.length === 0),
  ).toBe(true);
});
it('reports target discrepancies without releasing or granting signing permission', async () => {
  let changed = false;
  const report = await collect(async (method, params, signal) => {
    const value = await f.rpc(method, params, signal);
    if (method === 'getTransaction' && !changed) {
      const r = value as (typeof f.receipts)[number];
      const row = r.meta.postTokenBalances.find(
        (t) => t.mint === f.review.input.create.mint,
      )!;
      row.uiTokenAmount.amount = (
        BigInt(row.uiTokenAmount.amount) - 1n
      ).toString();
      changed = true;
    }
    return value;
  });
  expect(report.complete).toBe(true);
  expect(report.wallets.some((w) => w.targetStatus === 'differs')).toBe(true);
  expect(report.reservationsChanged).toBe(false);
});
it('shows finalized failures as fee-only deltas and reports unmet token targets separately from receipt completeness', async () => {
  const report = await collect(async (method, params, signal) => {
    const value = await f.rpc(method, params, signal);
    if (method === 'getTransaction') {
      const r = value as (typeof f.receipts)[number];
      r.meta.err = { InstructionError: [0, 'Custom'] };
      r.meta.postBalances = [...r.meta.preBalances];
      r.meta.postBalances[0] = (
        BigInt(r.meta.postBalances[0]) - 5000n
      ).toString();
      r.meta.postTokenBalances = structuredClone(r.meta.preTokenBalances);
    }
    return value;
  });
  expect(report.complete).toBe(true);
  expect(report.packets.every((p) => p.outcome === 'failed')).toBe(true);
  expect(report.wallets.every((w) => w.knownTokenDeltaRaw === '0')).toBe(true);
  expect(
    report.wallets
      .filter((w) => w.targetKind !== 'none')
      .every((w) => w.targetStatus === 'differs'),
  ).toBe(true);
  expect(report.reservationsChanged).toBe(false);
});
it('does not claim complete token coverage when older RPC metadata omits owner or program identity', async () => {
  const report = await collect(async (method, params, signal) => {
    const value = await f.rpc(method, params, signal);
    if (method === 'getTransaction')
      for (const t of (value as (typeof f.receipts)[number]).meta
        .postTokenBalances)
        Reflect.deleteProperty(t, 'programId');
    return value;
  });
  expect(report.complete).toBe(false);
  expect(report.wallets.some((w) => w.targetStatus === 'unknown')).toBe(true);
});
it.each([
  'bytes',
  'custody',
  'duplicate',
  'lamports',
  'slot',
  'program',
  'mint',
  'decimals',
] as const)('rejects inconsistent finalized %s evidence', async (mutation) => {
  await expect(
    collect(async (method, params, signal) => {
      const value = await f.rpc(method, params, signal);
      if (method !== 'getTransaction') return value;
      const r = value as (typeof f.receipts)[number];
      if (mutation === 'bytes') r.transaction[0] = 'AQ==';
      if (mutation === 'custody')
        r.meta.postTokenBalances[0].owner = f.review.input.create.mint;
      if (mutation === 'program')
        r.meta.postTokenBalances[0].programId = f.review.input.create.mint;
      if (mutation === 'mint')
        r.meta.postTokenBalances[0].mint = f.review.input.create.payer;
      if (mutation === 'decimals')
        r.meta.postTokenBalances[0].uiTokenAmount.decimals = 9;
      if (mutation === 'duplicate')
        r.meta.postTokenBalances.push(r.meta.postTokenBalances[0]);
      if (mutation === 'lamports')
        r.meta.postBalances[0] = (
          BigInt(r.meta.postBalances[0]) + 1n
        ).toString();
      if (mutation === 'slot') r.slot = '1';
      return r;
    }),
  ).rejects.toThrow();
});
it('rejects a different network and honors cancellation even if the provider ignores AbortSignal', async () => {
  await expect(collect(async () => 'different-network')).rejects.toThrow(
    'network',
  );
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = collect(
    async () => {
      entered();
      return new Promise(() => {});
    },
    f,
    controller.signal,
  );
  const assertion = expect(pending).rejects.toThrow('cancelled');
  await started;
  controller.abort();
  await assertion;
});
it('rejects substituted scope, totals and permission claims even with a recomputed response digest', async () => {
  const original = await collect();
  for (const patch of [
    { reviewId: crypto.randomUUID() },
    { knownNetworkFeeRaw: '0' },
    { economicSettlementVerified: true },
    { currentHoldings: true },
    { complete: false },
  ]) {
    const report = { ...original, ...patch };
    const { sha256: _old, ...body } = report;
    await expect(
      parsePumpGroupChainEffects(
        { ...body, sha256: await pumpHolderDigest(body) },
        f.group,
      ),
    ).rejects.toThrow();
  }
  expect(
    parsePumpGroupRequest(
      { action: 'chain-effects', id: f.review.id },
      'https://bundle.test',
    ),
  ).toEqual({ action: 'chain-effects', id: f.review.id });
  expect(() =>
    parsePumpGroupRequest(
      {
        action: 'chain-effects',
        id: f.review.id,
        endpoint: 'https://other.test',
      },
      'https://bundle.test',
    ),
  ).toThrow();
});
it('rejects duplicate review identities before RPC and rejects omitted participant effects despite a recomputed digest', async () => {
  const review = structuredClone(f.review);
  review.input.holders[0].address = review.input.create.payer;
  const { contextSha256: _oldContext, ...context } = review;
  review.contextSha256 = await pumpHolderDigest(context);
  let reads = 0;
  await expect(
    collectPumpGroupChainEffects(
      review,
      f.signed,
      new AbortController().signal,
      async () => {
        reads++;
        return null;
      },
    ),
  ).rejects.toThrow('distinct');
  expect(reads).toBe(0);
  const report = await collect();
  report.packets[0].wallets.pop();
  const { sha256: _oldSha, ...body } = report;
  await expect(
    parsePumpGroupChainEffects(
      { ...body, sha256: await pumpHolderDigest(body) },
      f.group,
    ),
  ).rejects.toThrow('participant coverage');
});
