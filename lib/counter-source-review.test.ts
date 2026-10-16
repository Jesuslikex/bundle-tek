import { afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { counterBuyFixture } from '../test/counter-buy-fixture';
import {
  evaluateCounterTrade,
  initialCounterLedger,
  validateCounterLedger,
} from './counter-trade';
import {
  counterProposalSources,
  reviewCounterBuySources,
} from './counter-source-review';
afterEach(() => vi.useRealTimers());
function fixture(buffered = false, rate = false) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:02.000Z'));
  const f = counterBuyFixture(),
    original = f.plan.ledger.decisions[0].source!;
  original.movement.blockTime = Date.parse(f.plan.createdAt) / 1000;
  f.plan.rules.minimumResponseTokenRaw = buffered
    ? (BigInt(f.plan.ledger.decisions[0].contributionTokenRaw) * 2n).toString()
    : '1';
  if (rate) f.plan.rules.trigger = { kind: 'rate', percent: '50' };
  const first = evaluateCounterTrade(
    f.plan.rules,
    initialCounterLedger(f.plan.rules, f.plan.ledger.scope),
    original.movement,
    original.context,
    () => 17,
  );
  f.plan.ledger = first.ledger;
  if (buffered) {
    const source = structuredClone(original);
    source.context.trade.transaction = bs58.encode(new Uint8Array(64).fill(2));
    source.context.trade.id = 'second';
    source.movement.signature = source.context.trade.transaction;
    source.movement.tradeId = 'second';
    const second = evaluateCounterTrade(
      f.plan.rules,
      f.plan.ledger,
      source.movement,
      source.context,
      () => 18,
    );
    f.plan.ledger = second.ledger;
    f.identity = second.decision.identity;
  }
  const observe = vi.fn(async (context: typeof original.context) => {
    const source = f.plan.ledger.decisions.find(
      (d) => d.source?.context.trade.transaction === context.trade.transaction,
    )!.source!;
    return {
      ...structuredClone(source.movement),
      observedAt: new Date().toISOString(),
    };
  });
  return {
    ...f,
    observe,
    run: () =>
      reviewCounterBuySources(
        f.plan,
        f.identity,
        new AbortController().signal,
        observe,
      ),
  };
}
it('retains detached source evidence, without changing a replayed decision or old history', () => {
  const f = fixture(),
    d = f.plan.ledger.decisions[0],
    source = d.source!;
  const context = structuredClone(source.context),
    movement = structuredClone(source.movement),
    detached = evaluateCounterTrade(
      f.plan.rules,
      initialCounterLedger(f.plan.rules, f.plan.ledger.scope),
      movement,
      context,
    );
  context.trade.id = 'caller-mutated';
  movement.source = 'caller-mutated.test';
  expect(detached.decision.source!.context.trade.id).toBe(
    source.context.trade.id,
  );
  expect(detached.decision.source!.movement.source).toBe(
    source.movement.source,
  );
  const replay = evaluateCounterTrade(
    f.plan.rules,
    f.plan.ledger,
    { ...source.movement, observedAt: new Date().toISOString() },
    source.context,
  );
  expect(replay.replayed).toBe(true);
  expect(replay.ledger).toBe(f.plan.ledger);
  const legacy = structuredClone(f.plan.ledger);
  delete legacy.decisions[0].source;
  expect(validateCounterLedger(f.plan.rules, legacy)).toBe(legacy);
  f.plan.ledger = legacy;
  expect(() => counterProposalSources(f.plan, f.identity)).toThrow(
    'lacks retained',
  );
});
it('rechecks every buffered contributor and preserves each retained probability draw', async () => {
  const f = fixture(true, true);
  const result = await f.run();
  expect(result.sourceTradeCount).toBe(2);
  expect(f.observe).toHaveBeenCalledTimes(2);
  expect(f.plan.ledger.decisions.map((d) => d.draw)).toEqual([17, 18]);
  expect(Date.parse(result.sourceValidUntil)).toBe(
    Date.parse(f.plan.createdAt) + 300000,
  );
});
it.each(['missing', 'old', 'future', 'pre-activation', 'null-time'] as const)(
  'rejects %s source before any RPC',
  async (mode) => {
    const f = fixture(true),
      source = f.plan.ledger.decisions[0].source!;
    if (mode === 'missing') delete f.plan.ledger.decisions[0].source;
    if (mode === 'old') vi.setSystemTime(Date.now() + 300001);
    if (mode === 'future')
      source.movement.observedAt = new Date(Date.now() + 1001).toISOString();
    if (mode === 'pre-activation')
      source.movement.blockTime = Date.parse(f.plan.createdAt) / 1000 - 2;
    if (mode === 'null-time') source.movement.blockTime = null;
    await expect(f.run()).rejects.toThrow();
    expect(f.observe).not.toHaveBeenCalled();
  },
);
it.each([
  'fingerprint',
  'time',
  'old-observation',
  'wrong-context',
  'failed',
] as const)('rejects changed %s on a buffered contributor', async (mode) => {
  const f = fixture(true),
    original = f.observe.getMockImplementation()!;
  f.observe.mockImplementation(async (context) => {
    const movement = await original(context);
    if (mode === 'fingerprint') movement.classification.reason += ' changed';
    if (mode === 'time') movement.blockTime!++;
    if (mode === 'old-observation')
      movement.observedAt = '2026-10-13T12:00:00.000Z';
    if (mode === 'wrong-context')
      movement.pool = 'So11111111111111111111111111111111111111112';
    if (mode === 'failed') movement.failed = true;
    return movement;
  });
  await expect(f.run()).rejects.toThrow();
});
it('does not include a previous proposal in a later target and refuses cancellation', async () => {
  const f = fixture(),
    first = structuredClone(f.plan.ledger.decisions[0]),
    source = structuredClone(first.source!);
  source.context.trade.transaction = bs58.encode(new Uint8Array(64).fill(3));
  source.movement.signature = source.context.trade.transaction;
  const second = evaluateCounterTrade(
    f.plan.rules,
    f.plan.ledger,
    source.movement,
    source.context,
  );
  f.plan.ledger = second.ledger;
  f.identity = second.decision.identity;
  expect(
    counterProposalSources(f.plan, f.identity).map((x) => x.decision.identity),
  ).toEqual([f.identity]);
  const stop = new AbortController();
  stop.abort();
  await expect(
    reviewCounterBuySources(f.plan, f.identity, stop.signal, f.observe),
  ).rejects.toThrow();
  expect(f.observe).not.toHaveBeenCalled();
});
it('refuses an excluded source wallet even if a retained ledger claims a proposal', async () => {
  const f = fixture();
  f.plan.rules.ignoredWallets = [
    f.plan.ledger.decisions[0].source!.movement.wallet,
  ];
  f.plan.ledger.rulesKey = initialCounterLedger(
    f.plan.rules,
    f.plan.ledger.scope,
  ).rulesKey;
  await expect(f.run()).rejects.toThrow('trade changed');
});
