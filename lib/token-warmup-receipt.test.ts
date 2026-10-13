import { beforeAll, expect, it } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { decodeWarmupReceipt } from './warmup-buy-receipt';
import { unsignedPreparationSummary } from './imported-swap-preparation-history';
import { projectWarmupReceipt } from './token-warmup-receipt';
import type { WarmupSigningEvent } from './warmup-signing-events';

const id = (value: number) =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const date = (seconds: number) => `2026-10-13T00:00:0${seconds}.000Z`;
type Evidence = {
  event: WarmupSigningEvent;
  payload: {
    successfulReceipt: Record<string, unknown>;
    linkedBuyReceipt: Record<string, unknown> | null;
    preparation: Record<string, unknown>;
  };
};
let buy: Evidence, sell: Evidence;
beforeAll(async () => {
  const b = await nativeWarmupFixture({ v2: true, existing: true });
  const s = await nativeWarmupFixture({
    side: 'Sell',
    v2: true,
    existing: true,
    slot: 200,
  });
  const buyPreparation = {
    id: id(1),
    planId: 'receipt-history',
    planRevision: 1,
    cycle: 1,
    wallet: b.wallet,
    walletRevision: 1,
    createdAt: date(0),
    document: unsignedPreparationSummary(b.order, b.simulation),
  };
  const decodedBuy = await decodeWarmupReceipt(
    b.receipt,
    buyPreparation,
    b.signed.signature,
    'Buy',
  );
  const buyDocument = {
    ...decodedBuy,
    observedAt: date(1),
    source: 'receipt-fixture.test',
  };
  const buyReceipt = {
    id: id(2),
    preparationId: buyPreparation.id,
    planId: 'receipt-history',
    planRevision: 1,
    cycle: 1,
    wallet: b.wallet,
    walletRevision: 1,
    signature: b.signed.signature,
    document: buyDocument,
    createdAt: date(2),
  };
  const sellPreparation = {
    ...buyPreparation,
    id: id(3),
    createdAt: date(4),
    document: {
      ...unsignedPreparationSummary(s.order, s.simulation),
      buyReceipt: {
        receiptId: buyReceipt.id,
        preparationId: buyPreparation.id,
        signature: b.signed.signature,
        acquiredRaw: decodedBuy.acquiredRaw,
        decimals: decodedBuy.decimals,
        slot: decodedBuy.slot,
        preparationSha256: decodedBuy.preparationSha256,
        limitations: 'Synthetic retained buy link.',
      },
    },
  };
  const { acquiredRaw: consumedRaw, ...decodedSell } =
    await decodeWarmupReceipt(
      s.receipt,
      sellPreparation,
      s.signed.signature,
      'Sell',
    );
  const event = (
    fixture: typeof b,
    preparationId: string,
    sequence: number,
    createdAt: string,
  ): WarmupSigningEvent => ({
    id: sequence.toString(16).padStart(32, '0'),
    sequence,
    intentId: id(sequence + 10),
    preparationId,
    planId: 'receipt-history',
    planRevision: 1,
    cycle: 1,
    wallet: fixture.wallet,
    type: 'approval.finalized',
    state: 'finalized',
    signature: fixture.signed.signature,
    failureReceipt: null,
    createdAt,
    document: {
      side: fixture.order.side,
      sha256: fixture.order.preparation.sha256,
      inputMint: fixture.order.inputMint,
      outputMint: fixture.order.outputMint,
      inputRaw: fixture.order.inAmount,
      minimumOutputRaw: fixture.order.minimumOutAmount,
    },
  });
  buy = {
    event: event(b, buyPreparation.id, 1, date(3)),
    payload: {
      successfulReceipt: buyReceipt,
      linkedBuyReceipt: null,
      preparation: buyPreparation,
    },
  };
  sell = {
    event: event(s, sellPreparation.id, 2, date(6)),
    payload: {
      successfulReceipt: {
        id: id(4),
        preparationId: sellPreparation.id,
        planId: 'receipt-history',
        buyReceiptId: buyReceipt.id,
        signature: s.signed.signature,
        consumedRaw,
        createdAt: date(5),
        document: {
          ...decodedSell,
          consumedRaw,
          buyReceiptId: buyReceipt.id,
          observedAt: date(5),
          source: 'receipt-fixture.test',
        },
      },
      linkedBuyReceipt: buyReceipt,
      preparation: sellPreparation,
    },
  };
});

it('matches signed synthetic mainnet summaries without assuming zero wrapped SOL changes or treating rent as sale proceeds', () => {
  for (const evidence of [buy, sell]) {
    const result = projectWarmupReceipt(evidence.event, evidence.payload);
    expect(result.matched).toBe(true);
    expect(result.details.join(' ')).toContain(
      'Presently retained matching finalized',
    );
    expect(result.details.join(' ')).toContain(
      'does not independently reconstruct raw balances',
    );
    expect(result.details.join(' ')).toContain('Network fee 5000 lamports');
  }
  const result = projectWarmupReceipt(sell.event, sell.payload);
  expect(result.details.join(' ')).toContain(
    'Consumed 1000 atomic token units',
  );
  expect(result.details.join(' ')).toContain('SOL settlement 1000000 lamports');
  const document = sell.payload.successfulReceipt.document as Record<
    string,
    unknown
  >;
  expect(
    BigInt(String(document.nativeChangeRaw)) +
      BigInt(String(document.networkFeeLamports)) +
      BigInt(String(document.rentChangeRaw)),
  ).not.toBe(BigInt(String(document.nativeSettlementRaw)));
});

it('does not upgrade earlier approval states from presently retained receipts', () => {
  for (const state of [
    'awaiting_signature',
    'signed',
    'submitted',
    'failed',
    'cancelled',
  ] as const)
    expect(
      projectWarmupReceipt(
        { ...buy.event, state },
        { successfulReceipt: 'malformed later receipt' },
      ),
    ).toEqual({ matched: false, details: [] });
});

it('keeps missing receipt, linked buy and original preparation evidence explicit', () => {
  expect(
    projectWarmupReceipt(buy.event, {
      ...buy.payload,
      successfulReceipt: null,
    }).details.join(' '),
  ).toContain('evidence is unavailable');
  expect(
    projectWarmupReceipt(sell.event, {
      ...sell.payload,
      linkedBuyReceipt: null,
    }).details.join(' '),
  ).toContain('buy provenance is unavailable');
  expect(
    projectWarmupReceipt(sell.event, {
      ...sell.payload,
      preparation: null,
    }).details.join(' '),
  ).toContain('preparation buy link is unavailable');
});

it('checks a retained approval fee limit without inventing one when the review is unavailable', () => {
  const payload = {
    ...structuredClone(buy.payload),
    intent: { maximumFeeLamports: '4999' },
  };
  expect(projectWarmupReceipt(buy.event, payload).matched).toBe(false);
  payload.intent.maximumFeeLamports = '5000';
  expect(projectWarmupReceipt(buy.event, payload).matched).toBe(true);
  expect(
    projectWarmupReceipt(buy.event, { ...payload, intent: null }).matched,
  ).toBe(true);
});

it('withholds contradictory receipt signatures, ownership context, amounts, programs, dates and exact Buy settlement without replacing the approval state', () => {
  const changes: ((value: Evidence['payload']) => void)[] = [
    (p) => {
      p.successfulReceipt.signature = sell.event.signature;
    },
    (p) => {
      p.successfulReceipt.preparationId = id(90);
    },
    (p) => {
      p.successfulReceipt.planId = 'foreign-plan';
    },
    (p) => {
      p.successfulReceipt.planRevision = 2;
    },
    (p) => {
      p.successfulReceipt.cycle = 2;
    },
    (p) => {
      p.successfulReceipt.walletRevision = 2;
    },
    (p) => {
      p.successfulReceipt.createdAt = date(9);
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).observedAt =
        '2026-10-12T23:59:59.000Z';
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).observedAt =
        date(9);
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).wallet =
        sell.event.document.inputMint;
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).mint =
        sell.event.document.outputMint;
    },
    (p) => {
      (
        p.successfulReceipt.document as Record<string, unknown>
      ).preparationSha256 = 'a'.repeat(64);
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).network =
        'devnet';
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).tokenProgram =
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).acquiredRaw =
        '994';
    },
    (p) => {
      (
        p.successfulReceipt.document as Record<string, unknown>
      ).nativeSettlementRaw = '-999999';
    },
    (p) => {
      (
        p.successfulReceipt.document as Record<string, unknown>
      ).networkFeeLamports = '18446744073709551616';
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).rentChangeRaw =
        '-0';
    },
  ];
  for (const change of changes) {
    const payload = structuredClone(buy.payload);
    change(payload);
    const result = projectWarmupReceipt(buy.event, payload);
    expect(result.matched).toBe(false);
    expect(result.details.join(' ')).toContain('recorded state is retained');
    expect(result.details.join(' ')).toContain('contradicts');
  }
});

it('checks exact Sell consumption, minimum SOL output and the earlier acquired lot and stored buy link', () => {
  const changes: ((value: Evidence['payload']) => void)[] = [
    (p) => {
      p.successfulReceipt.consumedRaw = '999';
    },
    (p) => {
      (
        p.successfulReceipt.document as Record<string, unknown>
      ).nativeSettlementRaw = '994999';
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).consumedRaw =
        '999';
    },
    (p) => {
      (p.successfulReceipt.document as Record<string, unknown>).buyReceiptId =
        id(90);
    },
    (p) => {
      p.linkedBuyReceipt!.cycle = 2;
    },
    (p) => {
      p.linkedBuyReceipt!.createdAt = date(5);
    },
    (p) => {
      (p.linkedBuyReceipt!.document as Record<string, unknown>).acquiredRaw =
        '999';
    },
    (p) => {
      (p.linkedBuyReceipt!.document as Record<string, unknown>).decimals = 7;
    },
    (p) => {
      (p.linkedBuyReceipt!.document as Record<string, unknown>).slot = 400;
    },
    (p) => {
      (p.linkedBuyReceipt!.document as Record<string, unknown>).wallet =
        sell.event.document.inputMint;
    },
    (p) => {
      const doc = p.preparation.document as Record<string, unknown>;
      (doc.buyReceipt as Record<string, unknown>).signature =
        sell.event.signature;
    },
  ];
  for (const change of changes) {
    const payload = structuredClone(sell.payload);
    change(payload);
    expect(projectWarmupReceipt(sell.event, payload).matched).toBe(false);
  }
});

it('accepts disclosed historical buy provenance and ignores later mutable remainder', () => {
  const payload = structuredClone(sell.payload);
  payload.preparation.planRevision = 2;
  payload.preparation.walletRevision = 2;
  payload.linkedBuyReceipt!.remainingRaw = 'not historical evidence';
  const link = (payload.preparation.document as Record<string, unknown>)
    .buyReceipt as Record<string, unknown>;
  link.historicalBuy = { planRevision: 1, walletRevision: 1 };
  expect(
    projectWarmupReceipt({ ...sell.event, planRevision: 2 }, payload).matched,
  ).toBe(true);
  delete link.historicalBuy;
  expect(
    projectWarmupReceipt({ ...sell.event, planRevision: 2 }, payload).matched,
  ).toBe(false);
});
