import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { directMovementFixture } from '../test/direct-movement-fixture';
import { classifyWalletMovement } from './wallet-movement-classification';
import {
  evaluateCounterTrade,
  initialCounterLedger,
  type CounterRules,
} from './counter-trade';
import type {
  PoolTradeMovement,
  PoolTradeMovementContext,
} from './pool-trade-movement';

const rules: CounterRules = {
  format: 'counter-evaluator-v1',
  responseSide: 'Sell',
  replicationPercent: '20',
  trigger: { kind: 'rate', percent: '100' },
  minimumResponseTokenRaw: '500',
  ignoredWallets: [],
};
function signal(index = 1, side: 'Buy' | 'Sell' = 'Buy', solQuote = false) {
  const tx = directMovementFixture(0, 0);
  if (solQuote) {
    const previous = tx.tokenChanges[0].mint,
      sol = 'So11111111111111111111111111111111111111112';
    tx.tokenChanges[0].mint = sol;
    tx.movementInstructions = tx.movementInstructions!.map((i) => ({
      ...i,
      ...(i.accounts
        ? { accounts: i.accounts.map((a) => (a === previous ? sol : a)) }
        : {}),
      ...(i.info?.mint === previous ? { info: { ...i.info, mint: sol } } : {}),
    }));
  }
  const token = tx.tokenChanges[side === 'Buy' ? 1 : 0];
  const signature = bs58.encode(new Uint8Array(64).fill(index));
  const context: PoolTradeMovementContext = {
    projectId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    mint: token.mint,
    decimals: token.decimals,
    pool: tx.tokenChanges[0].mint,
    tapeObservedAt: '2026-10-13T12:00:00.000Z',
    trade: {
      id: `trade-${index}`,
      transaction: signature,
      sender: tx.address,
      block: tx.slot,
      side,
      timestamp: '2026-10-13T12:00:00.000Z',
      tokenAmount: '1',
      quoteAmount: '1',
      priceUsd: '1',
      volumeUsd: '1',
    },
  };
  const movement: PoolTradeMovement = {
    format: 'pool-trade-movement-v1',
    executionAllowed: false,
    projectId: context.projectId,
    revision: 1,
    pool: context.pool,
    mint: context.mint,
    wallet: tx.address,
    signature,
    tradeId: context.trade.id,
    tapeObservedAt: context.tapeObservedAt,
    slot: tx.slot,
    providerBlock: tx.slot,
    blockAgrees: true,
    blockTime: tx.blockTime,
    commitment: 'confirmed',
    failed: false,
    walletSigner: true,
    providerSide: side,
    sideAgrees: true,
    tokenChange: {
      beforeRaw: token.beforeRaw,
      afterRaw: token.afterRaw,
      changeRaw: token.changeRaw,
      decimals: token.decimals,
    },
    classification: classifyWalletMovement(tx, token.mint),
    observedAt: '2026-10-13T12:00:01.000Z',
    source: 'fixture.test',
  };
  return { context, movement };
}
it('accumulates accepted small trades, conserves exact contributions and proposes without execution authority', () => {
  const first = signal(),
    ledger = initialCounterLedger(rules, first.context);
  let result = evaluateCounterTrade(
    rules,
    ledger,
    first.movement,
    first.context,
  );
  expect(result.decision.outcome).toBe('buffered');
  expect(result.ledger.queuedTokenRaw).toBe('200');
  for (const index of [2, 3]) {
    const next = signal(index);
    result = evaluateCounterTrade(
      rules,
      result.ledger,
      next.movement,
      next.context,
    );
  }
  expect(result.executionAllowed).toBe(false);
  expect(result.decision.proposalTokenRaw).toBe('600');
  expect(result.ledger.queuedTokenRaw).toBe('0');
  expect(ledger.decisions).toEqual([]);
});
it('persists a probability decision through JSON reload without rerolling or double-adding', () => {
  const s = signal(),
    r: CounterRules = { ...rules, trigger: { kind: 'rate', percent: '40' } },
    draw = vi.fn(() => 39_999_999);
  const result = evaluateCounterTrade(
    r,
    initialCounterLedger(r, s.context),
    s.movement,
    s.context,
    draw,
  );
  const replay = evaluateCounterTrade(
    r,
    JSON.parse(JSON.stringify(result.ledger)),
    s.movement,
    s.context,
    draw,
  );
  expect(replay.replayed).toBe(true);
  expect(replay.ledger.queuedTokenRaw).toBe('200');
  expect(draw).toHaveBeenCalledTimes(1);
  const next = signal(2);
  expect(
    evaluateCounterTrade(
      r,
      result.ledger,
      next.movement,
      next.context,
      () => 40_000_000,
    ).decision.outcome,
  ).toBe('probability-rejected');
});
it('never samples excluded actors or accepts unknown, mismatched, failed or wrong-direction evidence', () => {
  const guardedRules: CounterRules = {
    ...rules,
    trigger: { kind: 'rate', percent: '40' },
  };
  const s = signal(),
    draw = vi.fn(() => 0),
    excluded = { ...guardedRules, ignoredWallets: [s.movement.wallet] };
  expect(
    evaluateCounterTrade(
      excluded,
      initialCounterLedger(excluded, s.context),
      s.movement,
      s.context,
      draw,
    ).decision.outcome,
  ).toBe('excluded-wallet');
  const r = { ...rules, responseSide: 'Buy' as const };
  expect(
    evaluateCounterTrade(
      r,
      initialCounterLedger(r, s.context),
      s.movement,
      s.context,
      draw,
    ).decision.outcome,
  ).toBe('ineligible-evidence');
  const unknown = {
    ...s.movement,
    classification: {
      kind: 'unknown' as const,
      basis: 'unresolved' as const,
      reason: 'No route proof',
      counterpartyAccounts: [],
    },
    sideAgrees: null,
  };
  expect(
    evaluateCounterTrade(
      rules,
      initialCounterLedger(rules, s.context),
      unknown,
      s.context,
      draw,
    ).decision.outcome,
  ).toBe('ineligible-evidence');
  const mismatch = { ...s.movement, slot: 101, blockAgrees: false };
  expect(
    evaluateCounterTrade(
      rules,
      initialCounterLedger(rules, s.context),
      mismatch,
      s.context,
      draw,
    ).decision.outcome,
  ).toBe('ineligible-evidence');
  expect(draw).not.toHaveBeenCalled();
  for (const movement of [
    { ...unknown, failed: true },
    { ...unknown, walletSigner: false },
  ]) {
    expect(
      evaluateCounterTrade(
        guardedRules,
        initialCounterLedger(guardedRules, s.context),
        movement,
        s.context,
        draw,
      ).decision.outcome,
    ).toBe('ineligible-evidence');
  }
  expect(draw).not.toHaveBeenCalled();
});
it('handles zero/full response probability without a draw and never proposes replication dust', () => {
  const s = signal(),
    draw = vi.fn(() => 0);
  const never: CounterRules = {
    ...rules,
    trigger: { kind: 'rate', percent: '0' },
  };
  expect(
    evaluateCounterTrade(
      never,
      initialCounterLedger(never, s.context),
      s.movement,
      s.context,
      draw,
    ).decision.outcome,
  ).toBe('probability-rejected');
  const tiny = { ...rules, replicationPercent: '0.000001' };
  expect(
    evaluateCounterTrade(
      tiny,
      initialCounterLedger(tiny, s.context),
      s.movement,
      s.context,
      draw,
    ).decision.outcome,
  ).toBe('dust');
  expect(draw).not.toHaveBeenCalled();
});
it('uses observed token thresholds independently of response accumulation and supports Buy token targets', () => {
  const s = signal(),
    r: CounterRules = {
      ...rules,
      trigger: { kind: 'minimum-token', minimumRaw: '1001' },
    };
  expect(
    evaluateCounterTrade(
      r,
      initialCounterLedger(r, s.context),
      s.movement,
      s.context,
    ).decision.outcome,
  ).toBe('below-trigger');
  const sell = signal(2, 'Sell'),
    buy: CounterRules = {
      ...rules,
      responseSide: 'Buy',
      minimumResponseTokenRaw: '1',
    };
  expect(
    evaluateCounterTrade(
      buy,
      initialCounterLedger(buy, sell.context),
      sell.movement,
      sell.context,
    ).decision.proposalTokenRaw,
  ).toBe('200000');
});
it('withholds SOL-trigger evaluation for a non-SOL observed quote and rejects stale scope or altered replay evidence', () => {
  const s = signal(),
    r: CounterRules = {
      ...rules,
      trigger: { kind: 'minimum-sol', minimumRaw: '1' },
    };
  expect(
    evaluateCounterTrade(
      r,
      initialCounterLedger(r, s.context),
      s.movement,
      s.context,
    ).decision.outcome,
  ).toBe('ineligible-evidence');
  const result = evaluateCounterTrade(
    rules,
    initialCounterLedger(rules, s.context),
    s.movement,
    s.context,
  );
  expect(() =>
    evaluateCounterTrade(
      rules,
      result.ledger,
      { ...s.movement, slot: 101, providerBlock: 101 },
      { ...s.context, trade: { ...s.context.trade, block: 101 } },
    ),
  ).toThrow('already-decided');
  const other = {
    ...s.context,
    projectId: '00000000-0000-4000-8000-000000000002',
  };
  expect(() =>
    evaluateCounterTrade(
      rules,
      result.ledger,
      { ...s.movement, projectId: other.projectId },
      other,
    ),
  ).toThrow('scope');
  expect(() =>
    evaluateCounterTrade(
      rules,
      { ...result.ledger, queuedTokenRaw: '201' },
      s.movement,
      s.context,
    ),
  ).toThrow('reconcile');
});
it('rejects invalid percentages, probability samples and unsafe accumulation', () => {
  const s = signal();
  for (const replicationPercent of ['0', '1e2', '-1', '1.0000001'])
    expect(() =>
      initialCounterLedger({ ...rules, replicationPercent }, s.context),
    ).toThrow();
  const r: CounterRules = { ...rules, trigger: { kind: 'rate', percent: '1' } };
  for (const sample of [-1, 100_000_000, 1.5, NaN])
    expect(() =>
      evaluateCounterTrade(
        r,
        initialCounterLedger(r, s.context),
        s.movement,
        s.context,
        () => sample,
      ),
    ).toThrow('sample');
});
it('applies SOL thresholds only to an independently classified SOL quote at the exact atomic boundary', () => {
  const s = signal(1, 'Buy', true);
  expect(s.movement.classification.quote?.mint).toBe(
    'So11111111111111111111111111111111111111112',
  );
  for (const [minimumRaw, outcome] of [
    ['1000000', 'buffered'],
    ['1000001', 'below-trigger'],
  ] as const) {
    const r: CounterRules = {
      ...rules,
      trigger: { kind: 'minimum-sol', minimumRaw },
    };
    expect(
      evaluateCounterTrade(
        r,
        initialCounterLedger(r, s.context),
        s.movement,
        s.context,
      ).decision.outcome,
    ).toBe(outcome);
  }
});
it('keeps large exact token targets and rejects overflow before mutating a ledger', () => {
  const s = signal();
  const r: CounterRules = {
    ...rules,
    replicationPercent: '100',
    minimumResponseTokenRaw: '1',
  };
  s.movement.tokenChange = {
    beforeRaw: '0',
    afterRaw: '9007199254740993',
    changeRaw: '9007199254740993',
    decimals: 6,
  };
  const ledger = initialCounterLedger(r, s.context);
  expect(
    evaluateCounterTrade(r, ledger, s.movement, s.context).decision
      .proposalTokenRaw,
  ).toBe('9007199254740993');
  s.movement.tokenChange.afterRaw = s.movement.tokenChange.changeRaw =
    '18446744073709551615';
  const excessive: CounterRules = {
    ...r,
    replicationPercent: '200',
    trigger: { kind: 'rate', percent: '40' },
  };
  const draw = vi.fn(() => 0);
  expect(() =>
    evaluateCounterTrade(
      excessive,
      initialCounterLedger(excessive, s.context),
      s.movement,
      s.context,
      draw,
    ),
  ).toThrow('exceeds');
  expect(draw).not.toHaveBeenCalled();
  expect(ledger.decisions).toEqual([]);
});
it('does not reroll after a tape refresh and rejects a corrupted retained draw', () => {
  const s = signal(),
    r: CounterRules = { ...rules, trigger: { kind: 'rate', percent: '40' } };
  const result = evaluateCounterTrade(
    r,
    initialCounterLedger(r, s.context),
    s.movement,
    s.context,
    () => 1,
  );
  const nextContext = {
    ...s.context,
    tapeObservedAt: '2026-10-13T12:01:00.000Z',
    trade: { ...s.context.trade, id: 'refreshed-provider-id' },
  };
  const refreshed = {
    ...s.movement,
    tradeId: nextContext.trade.id,
    tapeObservedAt: nextContext.tapeObservedAt,
    observedAt: '2026-10-13T12:01:01.000Z',
  };
  const draw = vi.fn(() => 0);
  expect(
    evaluateCounterTrade(r, result.ledger, refreshed, nextContext, draw)
      .replayed,
  ).toBe(true);
  expect(draw).not.toHaveBeenCalled();
  const corrupt = structuredClone(result.ledger);
  corrupt.decisions[0].draw = 100_000_000;
  expect(() =>
    evaluateCounterTrade(r, corrupt, refreshed, nextContext, draw),
  ).toThrow('retained Counter probability');
});
