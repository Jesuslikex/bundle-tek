import { expect, it } from 'vitest';
import {
  recordedCostInputs,
  recordedCostResponse,
  recordedCostReviewId,
  recordedCostMint,
} from '../test/pump-group-recorded-costs-fixture';
import {
  reconcilePumpGroupRecordedCosts,
  validatedPumpGroupRecordedCosts,
} from './pump-group-recorded-costs';
const selected = { reviewId: recordedCostReviewId, mint: recordedCostMint };
it('reconciles packet fees and the separate tip without double-counting the aggregate', () => {
  const f = recordedCostInputs();
  expect(
    reconcilePumpGroupRecordedCosts(f.group, f.broadcast, f.observation),
  ).toEqual(recordedCostResponse);
});
it('includes failed transaction fees but no failed tip transfer', () => {
  const f = recordedCostInputs();
  f.group.state = 'failed';
  f.observation.state = 'failed';
  f.recovery.state = 'failed';
  f.closure.kind = 'failed';
  f.observation.receipt.packets.forEach((p) => (p.succeeded = false));
  f.recovery.tip.succeeded = false;
  f.recovery.tip.tipDebitRaw = '0';
  f.closure.tipDebitRaw = '0';
  const report = reconcilePumpGroupRecordedCosts(
    f.group,
    f.broadcast,
    f.observation,
  );
  expect(report).toMatchObject({
    knownTotalLamports: '15000',
    tipLamports: '0',
    feeAndTipCoverageComplete: true,
    outcome: 'failed',
  });
  expect(report.packets.map((p) => p.outcome)).toEqual(['failed', 'failed']);
});
it('preserves unknown tip and packet fees instead of claiming a zero-cost expired attempt', () => {
  const f = recordedCostInputs();
  f.group.state = 'cancelled';
  f.closure.kind = 'expired-unobserved';
  f.closure.networkFeeUnresolved = true;
  f.recovery.state = 'expired-unobserved';
  f.observation.state = 'expired-unobserved';
  f.recovery.tip = {
    signature: 'synthetic-tip-only',
    finalized: false,
    succeeded: null,
    slot: null,
    networkFeeRaw: null,
    tipDebitRaw: null,
  };
  f.observation.receipt.packets.forEach((p) =>
    Object.assign(p, {
      finalized: false,
      succeeded: null,
      slot: null,
      networkFeeRaw: null,
    }),
  );
  f.closure.groupNetworkFeeRaw = '0';
  f.closure.knownNetworkFeeRaw = '0';
  f.closure.tipDebitRaw = null;
  f.closure.tipNetworkFeeRaw = null;
  f.observation.receipt.knownNetworkFeeRaw = '0';
  expect(
    reconcilePumpGroupRecordedCosts(f.group, f.broadcast, f.observation),
  ).toMatchObject({
    knownTotalLamports: '0',
    tipLamports: null,
    tipNetworkFeeLamports: null,
    feeAndTipCoverageComplete: false,
  });
});
it('keeps a settled partial group visibly incomplete when a packet was unobserved', () => {
  const f = recordedCostInputs();
  f.group.state = 'failed';
  f.observation.state = 'partial';
  f.recovery.state = 'partial-final';
  f.closure.kind = 'partial';
  Object.assign(f.closure, {
    packetCount: 2,
    landedPacketCount: 1,
    succeededPacketCount: 1,
    groupNetworkFeeRaw: '5000',
    knownNetworkFeeRaw: '10000',
  });
  Object.assign(f.observation.receipt.packets[1], {
    finalized: false,
    succeeded: null,
    slot: null,
    networkFeeRaw: null,
  });
  f.observation.receipt.knownNetworkFeeRaw = '5000';
  f.observation.receipt.expiry = { pastExpiryMargin: true } as never;
  const report = reconcilePumpGroupRecordedCosts(
    f.group,
    f.broadcast,
    f.observation,
  );
  expect(report).toMatchObject({
    knownTotalLamports: '11000',
    feeAndTipCoverageComplete: false,
    outcome: 'partial',
  });
  expect(validatedPumpGroupRecordedCosts(report, selected)).toEqual(report);
});
it('uses exact integer arithmetic beyond the JavaScript number range', () => {
  const f = recordedCostInputs();
  f.observation.receipt.packets.forEach(
    (p) => (p.networkFeeRaw = '9007199254740993'),
  );
  f.observation.receipt.knownNetworkFeeRaw = '18014398509481986';
  f.closure.groupNetworkFeeRaw = '18014398509481986';
  f.closure.knownNetworkFeeRaw = '18014398509486986';
  expect(
    reconcilePumpGroupRecordedCosts(f.group, f.broadcast, f.observation)
      .knownTotalLamports,
  ).toBe('18014398509487986');
});
it.each([
  'group fees',
  'tip fee',
  'tip amount',
  'observation',
  'time',
  'missing fee',
  'outcome',
  'tip evidence',
  'authority',
] as const)('rejects inconsistent retained %s', (change) => {
  const f = recordedCostInputs();
  if (change === 'group fees') {
    f.closure.groupNetworkFeeRaw = '10001';
    f.closure.knownNetworkFeeRaw = '15001';
  }
  if (change === 'tip fee') {
    f.closure.tipNetworkFeeRaw = '5001';
    f.closure.knownNetworkFeeRaw = '15001';
  }
  if (change === 'tip amount') f.closure.tipDebitRaw = '1001';
  if (change === 'observation') f.recovery.groupObservationId = 'different';
  if (change === 'time') f.closure.observedAt = '2026-10-18T09:00:00.000Z';
  if (change === 'missing fee')
    f.observation.receipt.packets[0].networkFeeRaw = null;
  if (change === 'outcome') f.recovery.state = 'partial-final';
  if (change === 'tip evidence') f.recovery.tip.tipDebitRaw = '1001';
  if (change === 'authority')
    Object.assign(f.closure, { economicSettlementVerified: true });
  expect(() =>
    reconcilePumpGroupRecordedCosts(f.group, f.broadcast, f.observation),
  ).toThrow('No cost totals');
});
it('binds the public cost result to its row and independently checks sums/coverage/authority', () => {
  expect(
    validatedPumpGroupRecordedCosts(recordedCostResponse, selected),
  ).toEqual(recordedCostResponse);
  for (const update of [
    { reviewId: 'different' },
    { mint: 'different' },
    { knownTotalLamports: '15000' },
    { tipLamports: 1 },
    { executionAllowed: true },
    { rentIncluded: true },
    { feeAndTipCoverageComplete: false },
    { packets: [] },
  ])
    expect(() =>
      validatedPumpGroupRecordedCosts(
        { ...recordedCostResponse, ...update },
        selected,
      ),
    ).toThrow();
});
