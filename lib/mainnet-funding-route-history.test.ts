import { expect, it } from 'vitest';
import { fundingRouteFixture } from '../test/mainnet-funding-route-fixture';
import {
  createFundingRouteSource,
  decodeFundingRouteHistory,
} from './mainnet-funding-route-history';

it('shows every planned route and missing hop without inventing attempts or delivery', async () => {
  const { source, page } = await fundingRouteFixture();
  page.progress = { revision: 1, records: [] };
  const view = await decodeFundingRouteHistory(source, page);
  expect(view.executionAllowed).toBe(false);
  expect(view.routes.map((r) => r.steps.length)).toEqual([2, 1]);
  expect(
    view.routes
      .flatMap((r) => r.steps)
      .every((s) => s.record === null && !s.receiptMatches),
  ).toBe(true);
  expect(view.routes[0].steps.map((s) => s.amountRaw)).toEqual([
    '10100000',
    '10000000',
  ]);
  expect(view.routes[1].steps[0].leg).toBeNull();
});

it('binds each receipt to exact original terms and final destination without inferring route order or balances', async () => {
  const { source, page } = await fundingRouteFixture();
  if (page.progress.unavailable) throw Error();
  for (const record of page.progress.records) {
    record.state = 'finalized';
    record.signature = `synthetic-only-${record.sequence}`;
    record.receipt = {
      slot: 100,
      observedAt: record.createdAt,
      deliveredRaw: record.amountRaw,
      networkFeeLamports: '5000',
      accountRentLamports: '0',
      transferFeeRaw: null,
    };
  }
  let view = await decodeFundingRouteHistory(source, page);
  expect(
    view.routes.map((r) => r.steps.filter((s) => s.receiptMatches).length),
  ).toEqual([2, 1]);
  expect(view.routes[0].steps.at(-1)?.recipient).toBe(view.routes[0].recipient);
  page.progress.records[1].receipt!.deliveredRaw = '9999999';
  view = await decodeFundingRouteHistory(source, page);
  expect(view.routes[0].steps[0].receiptMatches).toBe(true);
  expect(view.routes[0].steps[1].receiptMatches).toBe(false);
});

it.each([
  'wallet',
  'recipient',
  'amountRaw',
  'amount',
  'scheduledAt',
  'root',
  'unexpected-step',
  'duplicate-signature',
  'direct-explicit',
  'proxy-too-long',
  'receipt-without-signature',
] as const)(
  'withholds coverage for inconsistent captured %s',
  async (field) => {
    const { source, page } = await fundingRouteFixture();
    if (page.progress.unavailable) throw Error();
    const r = page.progress.records[0];
    if (field === 'direct-explicit') page.progress.records[2].funding.leg = 1;
    if (field === 'proxy-too-long') r.funding.leg = 3;
    if (field === 'receipt-without-signature') {
      r.state = 'finalized';
      r.receipt = {
        slot: 100,
        observedAt: r.createdAt,
        deliveredRaw: r.amountRaw,
        networkFeeLamports: '5000',
        accountRentLamports: '0',
        transferFeeRaw: null,
      };
      r.signature = null;
    }
    if (field === 'wallet' || field === 'recipient') r[field] = 'other-address';
    if (field === 'amountRaw') r.amountRaw = '1';
    if (field === 'amount') r.amount = '1';
    if (field === 'scheduledAt')
      r.funding.scheduledAt = '2026-10-21T00:00:00.000Z';
    if (field === 'root') r.funding.termsSha256 = 'a'.repeat(64);
    if (field === 'unexpected-step') r.funding.item = 99;
    if (field === 'duplicate-signature') {
      r.signature = 'same';
      page.progress.records[1].signature = 'same';
    }
    await expect(decodeFundingRouteHistory(source, page)).rejects.toThrow();
  },
);

it.each([
  'revision',
  'planId',
  'authority',
  'unknown',
  'hash',
  'noncanonical',
  'old-revision',
  'unavailable-progress',
  'token',
] as const)('refuses unavailable or ambiguous %s sources', async (field) => {
  const { plan, source, page } = await fundingRouteFixture();
  if (field === 'revision') source.revision++;
  if (field === 'planId') source.planId = 'other-plan';
  if (field === 'authority') Object.assign(source, { executionAllowed: true });
  if (field === 'unknown') Object.assign(source, { extra: true });
  if (field === 'hash') source.termsSha256 = 'a'.repeat(64);
  if (field === 'noncanonical') source.termsJson = ' ' + source.termsJson;
  if (field === 'old-revision') page.currentRevision++;
  if (field === 'unavailable-progress')
    page.progress = { revision: 1, records: null, unavailable: true };
  if (field === 'token') {
    const doc = JSON.parse(source.termsJson);
    doc.currency = 'USDC';
    source.termsJson = JSON.stringify(doc);
  }
  await expect(decodeFundingRouteHistory(source, page)).rejects.toThrow();
  if (field === 'token')
    await expect(
      createFundingRouteSource({
        ...plan,
        document: JSON.parse(source.termsJson),
      }),
    ).rejects.toThrow();
});

it('does not turn an older finalized transition into latest-attempt receipt coverage', async () => {
  const { source, page } = await fundingRouteFixture();
  if (page.progress.unavailable) throw Error();
  const latest = page.progress.records[0];
  page.events = [
    {
      ...structuredClone(latest),
      sequence: 99,
      withdrawalId: 'older-legacy-attempt',
      state: 'finalized',
      signature: 'synthetic-older',
      receipt: {
        slot: 100,
        observedAt: latest.createdAt,
        deliveredRaw: latest.amountRaw,
        networkFeeLamports: '5000',
        accountRentLamports: '0',
        transferFeeRaw: null,
      },
    },
  ];
  latest.state = 'cancelled';
  const view = await decodeFundingRouteHistory(source, page);
  expect(view.routes[0].steps[0].record?.state).toBe('cancelled');
  expect(view.routes[0].steps[0].receiptMatches).toBe(false);
  expect(page.events[0].receipt).not.toBeNull();
});

it('recovers older routes only from whole-term hash-matched original captures while preserving v1', async () => {
  const { plan, source, page } = await fundingRouteFixture();
  expect(source.format).toBe('funding-route-source-v1');
  const current = await decodeFundingRouteHistory(source, page);
  expect(current.sourceRevision).toBe(1);
  const newer = {
    ...plan,
    revision: 2,
    archived: true,
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
  const historical = await createFundingRouteSource(newer, 1);
  page.currentRevision = 2;
  page.archived = true;
  expect(historical).toMatchObject({
    format: 'funding-route-source-v2',
    revision: 1,
    sourceRevision: 2,
  });
  const view = await decodeFundingRouteHistory(historical, page);
  expect(view.revision).toBe(1);
  expect(view.sourceRevision).toBe(2);
  expect(view.updatedAt).toBe(newer.updatedAt);
  expect(view.termsSha256).toBe(source.termsSha256);
  expect(view.routes).toEqual(current.routes);
  expect(view.executionAllowed).toBe(false);
});

it.each([
  'empty',
  'changed',
  'source-revision',
  'future',
  'v1-extra',
  'v2-current',
] as const)('withholds unproven historical %s source', async (kind) => {
  const { plan, source, page } = await fundingRouteFixture();
  const newer = { ...plan, revision: 2 };
  page.currentRevision = 2;
  let candidate: unknown = await createFundingRouteSource(newer, 1);
  if (kind === 'empty') page.progress = { revision: 1, records: [] };
  if (kind === 'changed')
    candidate = await createFundingRouteSource(
      { ...newer, document: { ...newer.document, name: 'Changed label' } },
      1,
    );
  if (kind === 'source-revision')
    candidate = { ...(candidate as object), sourceRevision: 3 };
  if (kind === 'future') {
    await expect(createFundingRouteSource(plan, 2)).rejects.toThrow();
    candidate = { ...(candidate as object), revision: 3 };
  }
  if (kind === 'v1-extra') candidate = { ...source, sourceRevision: 2 };
  if (kind === 'v2-current')
    candidate = { ...(candidate as object), sourceRevision: 1 };
  await expect(decodeFundingRouteHistory(candidate, page)).rejects.toThrow();
});
