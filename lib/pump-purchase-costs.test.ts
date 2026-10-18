import { beforeAll, expect, it, vi } from 'vitest';
import { pumpGroupPaymentFixture } from '../test/pump-group-payment-fixture';
import { collectPumpGroupReceiptEvidence } from './pump-group-receipt-evidence';
import {
  allocatePumpPurchaseCosts,
  pumpPurchaseCostShare,
} from './pump-purchase-costs';
import type { PumpGroupRecordedCosts } from './pump-group-recorded-costs';
import type { PumpGroupReceiptEvidence } from './pump-group-receipt-evidence';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { pumpHolderDigest } from './pump-holder-review';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';

let f: Awaited<ReturnType<typeof pumpGroupPaymentFixture>>,
  stock: typeof f,
  evidence: PumpGroupReceiptEvidence,
  stockEvidence: PumpGroupReceiptEvidence;
const signal = () => new AbortController().signal;
beforeAll(async () => {
  f = await pumpGroupPaymentFixture();
  stock = await pumpGroupPaymentFixture(true);
  evidence = await collectPumpGroupReceiptEvidence(f.group, signal(), f.rpc);
  stockEvidence = await collectPumpGroupReceiptEvidence(
    stock.group,
    signal(),
    stock.rpc,
  );
}, 120000);
// Synthetic terminal-cost projection: tests below prove allocation, not owner
// service/broadcast provenance. Production integration must replay that proof.
function costs(e = evidence): PumpGroupRecordedCosts {
  const packets = e.report.packets.map((p) => ({
    index: p.index,
    outcome: p.outcome === 'not-observed' ? ('unobserved' as const) : p.outcome,
    networkFeeLamports: p.networkFeeRaw,
  }));
  const total = packets.reduce(
    (s, p) => s + BigInt(p.networkFeeLamports ?? '0'),
    0n,
  );
  return {
    format: 'pump-group-recorded-costs-v1',
    reviewId: e.report.reviewId,
    mint: e.report.mint,
    observedAt: e.report.observedAt,
    outcome: 'partial',
    packets,
    groupNetworkFeeLamports: total.toString(),
    tipNetworkFeeLamports: '5003',
    tipLamports: '10001',
    knownTotalLamports: (total + 15004n).toString(),
    feeAndTipCoverageComplete: packets.every(
      (p) => p.networkFeeLamports !== null,
    ),
    economicSettlementVerified: false,
    profitCalculated: false,
    purchasePrincipalIncluded: false,
    rentIncluded: false,
    signingAllowed: false,
    executionAllowed: false,
    reservationsChanged: false,
  };
}
const sum = (
  p: Awaited<ReturnType<typeof allocatePumpPurchaseCosts>>,
  key: 'packetFeeShareLamports' | 'tipShareLamports' | 'tipFeeShareLamports',
) => p.sources.reduce((s, row) => s + BigInt(row[key]), 0n);
it('conserves residual integers and values above Number precision over every admitted count', () => {
  for (const total of [0n, 1n, 17n, (1n << 64n) - 1n])
    for (let count = 1; count <= 201; count++) {
      const shares = Array.from({ length: count }, (_, i) =>
        pumpPurchaseCostShare(total, i, count),
      );
      expect(shares.reduce((s, v) => s + v, 0n)).toBe(total);
      expect(
        shares.every(
          (v) =>
            v === total / BigInt(count) || v === total / BigInt(count) + 1n,
        ),
      ).toBe(true);
    }
});
it.each([
  [-1n, 0, 1],
  [1n, -1, 1],
  [1n, 1, 1],
  [1n, 0.5, 2],
  [1n, 0, 0],
  [1n, 0, 202],
  [1n, 0, NaN],
] as const)('rejects invalid interval %s/%s/%s', (total, i, count) => {
  expect(() => pumpPurchaseCostShare(total, i, count)).toThrow('bounds');
});
it('allocates real parsed synthetic native buys and all known costs without assigning setup as trade spend', async () => {
  const p = await allocatePumpPurchaseCosts(
    evidence,
    f.group,
    costs(),
    signal(),
  );
  expect(p.sources).toHaveLength(18);
  expect(p.reviewedBuyCount).toBe(18);
  expect(p.allocationComplete).toBe(true);
  expect(sum(p, 'packetFeeShareLamports').toString()).toBe(
    p.knownPacketFeesLamports,
  );
  expect(sum(p, 'tipShareLamports')).toBe(10001n);
  expect(sum(p, 'tipFeeShareLamports')).toBe(5003n);
  expect(p.unallocatedPacketFeesLamports).toBe('0');
  expect(p.unallocatedTipLamports).toBe('0');
  expect(p.unallocatedTipFeeLamports).toBe('0');
  expect(p.knownSetupFundingLamports).toBe('70500000');
  expect(p.unallocatedSetupFundingLamports).toBe('0');
  expect(new Set(p.sources.map((s) => s.originId)).size).toBe(18);
  for (const row of p.sources) {
    expect(row.purchaseQuoteRaw).toBe('1000');
    expect(row.nativeTradeCostExcludingSetupLamports).toBe(
      (1000n + BigInt(row.executionCostLamports)).toString(),
    );
    const { sha256, ...core } = row;
    expect(sha256).toBe(await pumpHolderDigest(core));
  }
  const { sha256, ...core } = p;
  expect(sha256).toBe(await pumpHolderDigest(core));
  expect(p).toMatchObject({
    acquisitionBasisVerified: false,
    profitCalculated: false,
    signingAllowed: false,
    executionAllowed: false,
    reservationsChanged: false,
  });
});
it('keeps token quote units and SOL fees separate without a peg or assumed conversion', async () => {
  const p = await allocatePumpPurchaseCosts(
    stockEvidence,
    stock.group,
    costs(stockEvidence),
    signal(),
  );
  expect(p.sources).toHaveLength(18);
  expect(
    p.sources.every(
      (s) =>
        s.nativeTradeCostExcludingSetupLamports === null &&
        s.purchaseQuoteRaw === '1000',
    ),
  ).toBe(true);
  expect(p.knownSetupFundingLamports).toBe('74500000');
  expect(sum(p, 'tipShareLamports')).toBe(10001n);
});
async function partial(unqualified = false) {
  const rpc: PumpLaunchRpc = async (method, params, s) => {
    const value = await f.rpc(method, params, s);
    if (
      method === 'getTransaction' &&
      params[0] === f.signed.packets[1].signature
    ) {
      if (!unqualified) return null;
      (
        value as { meta: { innerInstructions?: unknown } }
      ).meta.innerInstructions = undefined;
    }
    return value;
  };
  return collectPumpGroupReceiptEvidence(f.group, signal(), rpc);
}
it.each([false, true])(
  'does not reassign unresolved buy shares, and later receipts preserve every earlier source (%s)',
  async (unqualified) => {
    const e = await partial(unqualified),
      p = await allocatePumpPurchaseCosts(e, f.group, costs(e), signal()),
      complete = await allocatePumpPurchaseCosts(
        evidence,
        f.group,
        costs(),
        signal(),
      );
    expect(p.sources.length).toBeGreaterThan(0);
    expect(p.sources.length).toBeLessThan(18);
    expect(p.allocationComplete).toBe(false);
    expect(p.omitted.length).toBe(18 - p.sources.length);
    expect(BigInt(p.unallocatedTipLamports)).toBeGreaterThan(0n);
    expect(sum(p, 'tipShareLamports') + BigInt(p.unallocatedTipLamports)).toBe(
      10001n,
    );
    expect(
      sum(p, 'tipFeeShareLamports') + BigInt(p.unallocatedTipFeeLamports),
    ).toBe(5003n);
    for (const source of p.sources)
      expect(source).toEqual(
        complete.sources.find((s) => s.originId === source.originId),
      );
    expect(p.unknownFeePackets).toEqual(unqualified ? [] : [1]);
    if (unqualified) expect(p.unallocatedPacketFeesLamports).toBe('5000');
  },
);
it('retains known fees from an older settlement when the selected raw snapshot lacks a receipt', async () => {
  const e = await partial(),
    p = await allocatePumpPurchaseCosts(e, f.group, costs(), signal());
  expect(p.unknownFeePackets).toEqual([]);
  expect(p.unallocatedPacketFeesLamports).toBe('5000');
  expect(p.allocationComplete).toBe(false);
});
it.each(['tipLamports', 'tipNetworkFeeLamports'] as const)(
  'refuses unknown %s rather than assuming zero',
  async (field) => {
    const c = costs();
    c[field] = null;
    c.knownTotalLamports = (
      BigInt(c.groupNetworkFeeLamports) +
      BigInt(c.tipLamports ?? '0') +
      BigInt(c.tipNetworkFeeLamports ?? '0')
    ).toString();
    c.feeAndTipCoverageComplete = false;
    await expect(
      allocatePumpPurchaseCosts(evidence, f.group, c, signal()),
    ).rejects.toThrow('finalized tip');
  },
);
it('allows a failed finalized tip with zero debit and a recorded transaction fee', async () => {
  const c = costs();
  c.tipLamports = '0';
  c.knownTotalLamports = (BigInt(c.groupNetworkFeeLamports) + 5003n).toString();
  const p = await allocatePumpPurchaseCosts(evidence, f.group, c, signal());
  expect(sum(p, 'tipShareLamports')).toBe(0n);
  expect(sum(p, 'tipFeeShareLamports')).toBe(5003n);
});
it.each(['outcome', 'fee'] as const)(
  'refuses independently retained %s disagreement',
  async (kind) => {
    const c = costs();
    if (kind === 'outcome') c.packets[0].outcome = 'failed';
    else {
      c.packets[0].networkFeeLamports = '5001';
      c.groupNetworkFeeLamports = (
        BigInt(c.groupNetworkFeeLamports) + 1n
      ).toString();
      c.knownTotalLamports = (BigInt(c.knownTotalLamports) + 1n).toString();
    }
    await expect(
      allocatePumpPurchaseCosts(evidence, f.group, c, signal()),
    ).rejects.toThrow('disagree');
  },
);
it('refuses receipt tampering before admitting any cost source', async () => {
  const e = structuredClone(evidence);
  (e.receipts[0]!.meta as { fee: number }).fee++;
  await expect(
    allocatePumpPurchaseCosts(e, f.group, costs(), signal()),
  ).rejects.toThrow();
});
it('rejects cancellation before beginning reconstruction', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    allocatePumpPurchaseCosts(evidence, f.group, costs(), controller.signal),
  ).rejects.toThrow();
});
it('does not publish a completed allocation if cancellation arrives during its final digest', async () => {
  const controller = new AbortController(),
    digest = crypto.subtle.digest.bind(crypto.subtle),
    spy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementation(async (algorithm, data) => {
        const result = await digest(algorithm, data);
        if (
          new TextDecoder()
            .decode(data)
            .includes('"format":"pump-purchase-cost-allocation-v1"')
        )
          controller.abort();
        return result;
      });
  try {
    await expect(
      allocatePumpPurchaseCosts(evidence, f.group, costs(), controller.signal),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
it('keeps origin identity stable when the same signed transactions are retained under another review', async () => {
  const review = structuredClone(f.review);
  review.id = crypto.randomUUID();
  const { contextSha256: _priorContext, ...context } = review;
  review.contextSha256 = await pumpHolderDigest(context);
  const group = {
      review,
      signedEvidence: await verifyPumpLaunchGroupSignatures(
        review,
        f.signed.packets.map((p) => p.transaction),
      ),
    },
    e = await collectPumpGroupReceiptEvidence(group, signal(), f.rpc),
    p = await allocatePumpPurchaseCosts(e, group, costs(e), signal()),
    original = await allocatePumpPurchaseCosts(
      evidence,
      f.group,
      costs(),
      signal(),
    );
  expect(p.reviewId).not.toBe(original.reviewId);
  expect(p.sources.map((s) => s.originId)).toEqual(
    original.sources.map((s) => s.originId),
  );
});
it('keeps failed packet fees as overhead and never allocates rolled-back buys', async () => {
  const last = f.signed.packets.length - 1,
    rpc: PumpLaunchRpc = async (m, p, s) => {
      const r = await f.rpc(m, p, s);
      if (m === 'getTransaction' && p[0] === f.signed.packets[last].signature) {
        const receipt = r as (typeof f.receipts)[number];
        receipt.meta.err = { InstructionError: [0, { Custom: 42 }] };
        receipt.meta.postBalances = [...receipt.meta.preBalances];
        receipt.meta.postBalances[0] = (
          BigInt(receipt.meta.postBalances[0]) - 5000n
        ).toString();
        receipt.meta.postTokenBalances = structuredClone(
          receipt.meta.preTokenBalances,
        );
      }
      return r;
    },
    e = await collectPumpGroupReceiptEvidence(f.group, signal(), rpc),
    p = await allocatePumpPurchaseCosts(e, f.group, costs(e), signal());
  expect(p.sources.every((s) => s.packetIndex !== last)).toBe(true);
  expect(p.omitted.some((s) => s.packetIndex === last)).toBe(true);
  expect(p.unallocatedPacketFeesLamports).toBe('5000');
  expect(sum(p, 'tipShareLamports') + BigInt(p.unallocatedTipLamports)).toBe(
    10001n,
  );
});
