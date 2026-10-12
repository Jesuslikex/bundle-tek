import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { summarizeSupplyMovements } from './supply-movement-summary';
import type { SupplyMovementEvidence } from './supply-movement-evidence';
import { supplyWallet as address } from '../test/supply-history-fixture';
const scope = {
  observationId: 'observation',
  wallet: address(1),
  mint: address(2),
  decimals: 6,
  toSlot: 200,
  previousRaw: '500',
  currentRaw: '510',
};
function tx(
  n: number,
  delta: string,
  kind: 'buy' | 'sell' | 'transfer' | 'unknown',
): SupplyMovementEvidence['transactions'][number] {
  const change = BigInt(delta);
  return {
    signature: bs58.encode(new Uint8Array(64).fill(n)),
    slot: 100 + n,
    blockTime: null,
    beforeRaw: change < 0n ? (-change).toString() : '0',
    afterRaw: change > 0n ? delta : '0',
    changeRaw: delta,
    decimals: 6,
    source: 'fixture.test',
    classification: {
      kind,
      basis:
        kind === 'buy' || kind === 'sell'
          ? 'protocol-route-and-transfers'
          : kind === 'transfer'
            ? 'spl-token-transfer'
            : 'unresolved',
      reason: 'Fixture evidence',
      counterpartyAccounts: [],
      ...(kind === 'buy' || kind === 'sell'
        ? {
            protocol: 'Raydium CPMM' as const,
            quote: { mint: address(3), raw: '100', decimals: 9 },
          }
        : {}),
    },
  };
}
function page(
  transactions: SupplyMovementEvidence['transactions'],
): SupplyMovementEvidence {
  return {
    observationId: scope.observationId,
    wallet: scope.wallet,
    mint: scope.mint,
    fromSlot: 100,
    toSlot: 200,
    anchor: 201,
    requestedCursor: null,
    nextCursor: null,
    scannedSignatures: transactions.length,
    failedSignatures: 0,
    unavailableTransactions: 0,
    completeThroughBoundary: true,
    transactions,
    observedAt: new Date().toISOString(),
  };
}
it('deduplicates across wallet/account pages and separates buys, sells, transfers and unresolved net', () => {
  const record = page([
    tx(1, '100', 'buy'),
    tx(2, '-60', 'sell'),
    tx(3, '20', 'transfer'),
    tx(4, '-10', 'transfer'),
    tx(5, '-40', 'unknown'),
  ]);
  const summary = summarizeSupplyMovements(
    [record, { ...record, indexedAddress: address(8) }],
    scope,
  );
  expect(summary).toMatchObject({
    ok: true,
    transactionCount: 5,
    balancesMatch: true,
    decodedNetRaw: '10',
    unexplainedRaw: '0',
    buckets: {
      buy: { count: 1, raw: 100n },
      sell: { count: 1, raw: 60n },
      transferIn: { count: 1, raw: 20n },
      transferOut: { count: 1, raw: 10n },
      unknown: { count: 1, raw: -40n },
    },
  });
});
it('retains exact turnover larger than u64 and distinguishes net reconciliation from totals', () => {
  const max = ((1n << 64n) - 1n).toString();
  const summary = summarizeSupplyMovements(
    [page([tx(1, max, 'buy'), tx(2, `-${max}`, 'sell'), tx(3, max, 'buy')])],
    { ...scope, previousRaw: '0', currentRaw: max },
  );
  expect(summary).toMatchObject({
    ok: true,
    balancesMatch: true,
    buckets: { buy: { raw: 2n * BigInt(max) }, sell: { raw: BigInt(max) } },
  });
});
it('reports missing net evidence and treats legacy undecoded activity as unknown', () => {
  const legacy = tx(1, '3', 'unknown');
  delete legacy.classification;
  expect(summarizeSupplyMovements([page([legacy])], scope)).toMatchObject({
    ok: true,
    decodedNetRaw: '3',
    unexplainedRaw: '7',
    balancesMatch: false,
    buckets: { unknown: { count: 1, raw: 3n } },
  });
  expect(summarizeSupplyMovements([], scope)).toMatchObject({
    ok: true,
    transactionCount: 0,
    unexplainedRaw: '10',
    balancesMatch: false,
  });
});
it('withholds totals for conflicting duplicate balances or classification', () => {
  const record = page([tx(1, '100', 'buy')]);
  for (const altered of [
    tx(1, '99', 'buy'),
    tx(1, '100', 'transfer'),
    { ...tx(1, '100', 'buy'), slot: 102 },
  ]) {
    expect(
      summarizeSupplyMovements([record, page([altered])], scope),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('Conflicting'),
    });
  }
});
it('rejects foreign or mixed intervals, precision, invalid integer balances and substituted classification', () => {
  const record = page([tx(1, '100', 'buy')]);
  for (const patch of [
    { wallet: address(7) },
    { mint: address(7) },
    { observationId: 'other' },
    { toSlot: 199 },
    { fromSlot: 200 },
  ])
    expect(summarizeSupplyMovements([{ ...record, ...patch }], scope).ok).toBe(
      false,
    );
  expect(
    summarizeSupplyMovements([record, { ...record, fromSlot: 99 }], scope).ok,
  ).toBe(false);
  for (const patch of [
    { decimals: 9 },
    { slot: 201 },
    { beforeRaw: '01' },
    { afterRaw: (1n << 64n).toString() },
    { changeRaw: '-0' },
    { changeRaw: '-100' },
    { signature: 'abc' },
  ])
    expect(
      summarizeSupplyMovements(
        [page([{ ...record.transactions[0], ...patch }])],
        scope,
      ).ok,
    ).toBe(false);
});

function inspected(
  transaction: SupplyMovementEvidence['transactions'][number],
  seconds: number,
) {
  return {
    ...page([transaction]),
    observedAt: new Date(Date.UTC(2026, 9, 12, 12, 0, seconds)).toISOString(),
  };
}
function orders<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    orders(values.filter((_, i) => i !== index)).map((rest) => [
      value,
      ...rest,
    ]),
  );
}
it('promotes a later supported decode without double counting, regardless of saved-page order', () => {
  const legacy = tx(1, '100', 'unknown');
  delete legacy.classification;
  for (const records of orders([
    inspected(legacy, 0),
    inspected(tx(1, '100', 'unknown'), 1),
    inspected(tx(1, '100', 'buy'), 2),
  ]))
    expect(summarizeSupplyMovements(records, scope)).toMatchObject({
      ok: true,
      transactionCount: 1,
      decodedNetRaw: '100',
      buckets: { buy: { count: 1, raw: 100n }, unknown: { count: 0 } },
    });
});
it('downgrades an older known label after a newer unresolved inspection in every order', () => {
  for (const records of orders([
    inspected(tx(1, '100', 'unknown'), 0),
    inspected(tx(1, '100', 'buy'), 1),
    inspected(tx(1, '100', 'unknown'), 2),
  ]))
    expect(summarizeSupplyMovements(records, scope)).toMatchObject({
      ok: true,
      transactionCount: 1,
      buckets: { buy: { count: 0 }, unknown: { count: 1, raw: 100n } },
    });
});
it.each([
  ['-100', 'sell', 'sell'],
  ['100', 'transfer', 'transferIn'],
  ['-100', 'transfer', 'transferOut'],
] as const)(
  'updates %s movements to %s with unchanged balance facts',
  (delta, kind, bucket) => {
    for (const records of orders([
      inspected(tx(1, delta, 'unknown'), 0),
      inspected(tx(1, delta, kind), 1),
    ]))
      expect(summarizeSupplyMovements(records, scope)).toMatchObject({
        ok: true,
        transactionCount: 1,
        buckets: { [bucket]: { count: 1, raw: 100n }, unknown: { count: 0 } },
      });
  },
);
it('rejects equal-time classification differences even when a later identical known decode was loaded first', () => {
  for (const records of orders([
    inspected(tx(1, '100', 'buy'), 0),
    inspected(tx(1, '100', 'unknown'), 0),
    inspected(tx(1, '100', 'buy'), 1),
  ]))
    expect(summarizeSupplyMovements(records, scope)).toMatchObject({
      ok: false,
    });
});
it('withholds incompatible known trade and transfer evidence across intervening unknown versions', () => {
  const buy = tx(1, '100', 'buy');
  const variants = [
    tx(1, '100', 'transfer'),
    {
      ...buy,
      classification: { ...buy.classification!, protocol: 'PumpSwap' as const },
    },
    {
      ...buy,
      classification: {
        ...buy.classification!,
        counterpartyAccounts: [address(9)],
      },
    },
    {
      ...buy,
      classification: {
        ...buy.classification!,
        quote: { ...buy.classification!.quote!, raw: '101' },
      },
    },
    {
      ...buy,
      classification: {
        ...buy.classification!,
        quote: { ...buy.classification!.quote!, mint: address(4) },
      },
    },
    {
      ...buy,
      classification: {
        ...buy.classification!,
        quote: { ...buy.classification!.quote!, decimals: 8 },
      },
    },
  ];
  for (const changed of variants)
    for (const records of orders([
      inspected(buy, 0),
      inspected(tx(1, '100', 'unknown'), 1),
      inspected(changed, 2),
    ]))
      expect(summarizeSupplyMovements(records, scope)).toMatchObject({
        ok: false,
      });
});
it('cannot replace contradictory on-chain balances with a newer classification', () => {
  for (const records of orders([
    inspected(tx(1, '100', 'unknown'), 0),
    inspected(tx(1, '99', 'buy'), 1),
  ]))
    expect(summarizeSupplyMovements(records, scope)).toMatchObject({
      ok: false,
    });
});
it('withholds reclassification with invalid dates, anchors or provider provenance in any order', () => {
  const old = inspected(tx(1, '100', 'unknown'), 0);
  const later = inspected(tx(1, '100', 'buy'), 1);
  const invalids = [
    { ...old, observedAt: 'not-a-date' },
    { ...old, observedAt: '2026-10-12' },
    { ...old, anchor: 199 },
    {
      ...old,
      transactions: [
        { ...old.transactions[0], source: 'https://provider.test?key=secret' },
      ],
    },
  ];
  for (const invalid of invalids)
    for (const records of orders([invalid, later]))
      expect(summarizeSupplyMovements(records, scope)).toMatchObject({
        ok: false,
      });
});
it('keeps invalid provenance visible after an identical newer unknown version', () => {
  const invalid = {
    ...inspected(tx(1, '100', 'unknown'), 0),
    observedAt: 'invalid',
  };
  for (const records of orders([
    invalid,
    inspected(tx(1, '100', 'unknown'), 1),
    inspected(tx(1, '100', 'buy'), 2),
  ]))
    expect(summarizeSupplyMovements(records, scope)).toMatchObject({
      ok: false,
    });
});
it('ignores explanation text and counterparty ordering for otherwise identical known evidence', () => {
  const first = tx(1, '100', 'buy');
  first.classification!.counterpartyAccounts = [address(7), address(8)];
  const second = {
    ...first,
    classification: {
      ...first.classification!,
      reason: 'Updated explanation',
      counterpartyAccounts: [address(8), address(7)],
    },
  };
  expect(
    summarizeSupplyMovements(
      [inspected(first, 0), inspected(second, 0)],
      scope,
    ),
  ).toMatchObject({
    ok: true,
    transactionCount: 1,
    buckets: { buy: { count: 1 } },
  });
});
