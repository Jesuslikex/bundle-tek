import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { exchangePayoutFixture } from '../test/exchange-payout-fixture';
import { verifyOwnedExchangePayout } from './exchange-payout-service';
import { createTursoDatabase } from '../db/turso';
import { exchangeFundingReviewFixture } from '@/test/exchange-funding-review-fixture';
import {
  approveOwnedExchangeOrderReview,
  attemptOwnedExchangeOrder,
  observeOwnedExchangeOrder,
  prepareOwnedExchangeOrderReview,
  readOwnedExchangeOrder,
} from './exchange-order-service';
import {
  exchangeOrderAuthority,
  requireExchangeOrderTerms,
} from './exchange-order-review';
let client: Client,
  db: D1Database,
  fixture: ReturnType<typeof exchangeFundingReviewFixture>,
  time: number;
const now = () => time;
const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const refund = { address: address(8), revision: 4 };
const create =
  vi.fn<(body: unknown, signal: AbortSignal) => Promise<unknown>>();
const lookup = vi.fn<(id: string, signal: AbortSignal) => Promise<unknown>>();
const order = () => ({
  id: 'provider-fixture-1',
  currency: 'sol',
  network: 'sol',
  fromAmount: '1.15',
  toAmount: '1.1',
  payinAddress: address(9),
  payoutAddress: fixture.funder.address,
  refundAddress: refund.address,
});
const status = (providerStatus = 'waiting') => ({
  ...order(),
  fromCurrency: 'sol',
  toCurrency: 'sol',
  fromNetwork: 'sol',
  toNetwork: 'sol',
  expectedAmountFrom: '1.15',
  expectedAmountTo: '1.1',
  status: providerStatus,
});
const prepare = () =>
  prepareOwnedExchangeOrderReview(
    db,
    'alice',
    { quoteId: fixture.review.id, refund },
    now,
  );
const consent = (review: Awaited<ReturnType<typeof prepare>>) => ({
  reviewId: review.terms.id,
  sha256: review.sha256,
  exactAmountsAndNetwork: true,
  providerCustody: true,
  verificationMayBeRequired: true,
  refundAddressReviewed: true,
});
const attempt = (
  review: Awaited<ReturnType<typeof prepare>>,
  signal = new AbortController().signal,
) =>
  attemptOwnedExchangeOrder(
    db,
    'alice',
    { reviewId: review.terms.id, sha256: review.sha256 },
    signal,
    { create },
    now,
  );
async function approved() {
  const review = await prepare();
  await approveOwnedExchangeOrderReview(db, 'alice', consent(review), now);
  return review;
}
beforeEach(async () => {
  time = Date.parse('2026-10-18T12:00:00.000Z');
  fixture = exchangeFundingReviewFixture(time);
  client = createClient({ url: ':memory:' });
  db = createTursoDatabase(client);
  await client.executeMultiple(
    'CREATE TABLE funding_plans(owner_id TEXT,id TEXT,document TEXT,revision INTEGER,archived INTEGER,updated_at TEXT); CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER); CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT);',
  );
  for (const name of [
    '0103_exchange_funding_quotes',
    '0104_exchange_funding_orders',
    '0106_exchange_payout_receipts',
  ])
    await client.executeMultiple(await readFile(`drizzle/${name}.sql`, 'utf8'));
  await db
    .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'alice',
      fixture.plan.id,
      JSON.stringify(fixture.plan.document),
      fixture.plan.revision,
      0,
      fixture.plan.updatedAt,
    )
    .run();
  for (const wallet of [fixture.funder, refund]) {
    await db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
      .bind('alice', 'Solana', wallet.address, wallet.revision, 0)
      .run();
    await db
      .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
      .bind('alice', 'Solana', wallet.address)
      .run();
  }
  await db
    .prepare('INSERT INTO exchange_funding_quotes VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(
      fixture.review.id,
      'alice',
      fixture.plan.id,
      3,
      2,
      JSON.stringify(fixture.plan.document),
      JSON.stringify(fixture.review),
      'private-rate-fixture',
      fixture.review.quotedAt,
      fixture.review.expiresAt,
    )
    .run();
  create.mockReset().mockImplementation(async () => order());
  lookup.mockReset().mockImplementation(async () => status());
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
it('binds an owned quote and proven refund to immutable review evidence without provider calls', async () => {
  const review = await prepare();
  expect(review.terms).toMatchObject({
    quote: fixture.review,
    refund,
    ...exchangeOrderAuthority,
  });
  expect(requireExchangeOrderTerms(review.terms)).toEqual(review.terms);
  expect(review.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect((await prepare()).terms.id).toBe(review.terms.id);
  expect(create).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  await expect(
    readOwnedExchangeOrder(db, 'bob', review.terms.id),
  ).rejects.toMatchObject({ status: 404 });
});
it.each([
  'UPDATE funding_plans SET revision=4',
  'UPDATE funding_plans SET archived=1',
  'UPDATE workspace_wallets SET revision=revision+1',
  'UPDATE workspace_wallets SET archived=1',
  'DELETE FROM wallet_ownership_proofs',
])('requires current proven context before review: %s', async (sql) => {
  await db.prepare(sql).run();
  await expect(prepare()).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it('refuses expired quotes, same-wallet refunds and caller-authored authority', async () => {
  time += 56000;
  await expect(prepare()).rejects.toThrow('fresh');
  time -= 56000;
  await expect(
    prepareOwnedExchangeOrderReview(
      db,
      'alice',
      {
        quoteId: fixture.review.id,
        refund: {
          address: fixture.funder.address,
          revision: fixture.funder.revision,
        },
      },
      now,
    ),
  ).rejects.toThrow();
  await expect(
    prepareOwnedExchangeOrderReview(
      db,
      'alice',
      { quoteId: fixture.review.id, refund, signingAllowed: true },
      now,
    ),
  ).rejects.toMatchObject({ status: 400 });
});
it.each([
  'exactAmountsAndNetwork',
  'providerCustody',
  'verificationMayBeRequired',
  'refundAddressReviewed',
] as const)('requires explicit %s acknowledgement', async (key) => {
  const review = await prepare();
  await expect(
    approveOwnedExchangeOrderReview(
      db,
      'alice',
      { ...consent(review), [key]: false },
      now,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    (await readOwnedExchangeOrder(db, 'alice', review.terms.id)).approved,
  ).toBe(false);
});
it('requires exact-hash approval before entering transport', async () => {
  const review = await prepare();
  await expect(attempt(review)).rejects.toThrow('approval');
  await expect(
    approveOwnedExchangeOrderReview(
      db,
      'alice',
      { ...consent(review), sha256: '0'.repeat(64) },
      now,
    ),
  ).rejects.toThrow('differs');
  expect(create).not.toHaveBeenCalled();
});
it('claims one attempt before transport and withholds provider references and deposit instructions', async () => {
  const review = await approved();
  create.mockImplementation(async (body) => {
    expect(
      await db
        .prepare('SELECT id FROM exchange_funding_order_attempts')
        .first(),
    ).not.toBeNull();
    expect(body).toEqual({
      currency: 'sol',
      network: 'sol',
      toAmount: '1.1',
      address: fixture.funder.address,
      refundAddress: refund.address,
      rateId: 'private-rate-fixture',
    });
    return order();
  });
  const result = await attempt(review);
  expect(result).toMatchObject({
    state: 'provider-order-matched',
    providerReferenceRetained: true,
    payoutVerified: false,
    retryCreationAllowed: false,
    ...exchangeOrderAuthority,
  });
  expect(JSON.stringify(result)).not.toContain('provider-fixture-1');
  expect(JSON.stringify(result)).not.toContain('private-rate-fixture');
  expect(JSON.stringify(result)).not.toContain(address(9));
  await attempt(review);
  expect(create).toHaveBeenCalledTimes(1);
});
it.each([5000, 5001])(
  'refuses creation at or past the exact five-second approval boundary (%s ms)',
  async (delay) => {
    const review = await approved();
    time += delay;
    await expect(attempt(review)).rejects.toThrow('expired');
    expect(create).not.toHaveBeenCalled();
  },
);
it('accepts the last millisecond inside approval but does not extend it by reapproving', async () => {
  const review = await approved();
  time += 4999;
  await attempt(review);
  expect(create).toHaveBeenCalledTimes(1);
  await approveOwnedExchangeOrderReview(db, 'alice', consent(review), now);
  expect(
    (await readOwnedExchangeOrder(db, 'alice', review.terms.id))
      .approvalExpiresAt,
  ).toBe('2026-10-18T12:00:05.000Z');
});
it.each([
  'UPDATE funding_plans SET revision=4',
  'UPDATE workspace_wallets SET archived=1',
  'DELETE FROM wallet_ownership_proofs',
])('rechecks context at the atomic attempt claim: %s', async (sql) => {
  const review = await approved();
  await db.prepare(sql).run();
  await expect(attempt(review)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it('keeps a timed-out creation unresolved forever instead of invoking it twice', async () => {
  const review = await approved();
  create.mockRejectedValue(new Error('private upstream error'));
  const result = await attempt(review);
  expect(result.state).toBe('creation-unresolved');
  expect(JSON.stringify(result)).not.toContain('private upstream');
  await attempt(review);
  expect(create).toHaveBeenCalledTimes(1);
  await expect(
    observeOwnedExchangeOrder(
      db,
      'alice',
      review.terms.id,
      new AbortController().signal,
      { lookup },
      now,
    ),
  ).rejects.toThrow('No provider reference');
  expect(lookup).not.toHaveBeenCalled();
});
it.each([
  { toAmount: '1.09' },
  { currency: 'eth' },
  { network: 'devnet' },
  { refundAddress: address(10) },
  { payinAddress: address(7) },
  { payinExtraId: 'memo' },
])(
  'retains the safe provider reference before refusing mismatched response %j',
  async (change) => {
    const review = await approved();
    create.mockImplementation(async () => ({ ...order(), ...change }));
    expect(await attempt(review)).toMatchObject({
      state: 'creation-unresolved',
      providerReferenceRetained: true,
    });
    await attempt(review);
    expect(create).toHaveBeenCalledTimes(1);
  },
);
it('retains a completed provider response even when the request is cancelled after entry', async () => {
  const review = await approved(),
    controller = new AbortController();
  create.mockImplementation(async () => {
    controller.abort();
    return order();
  });
  expect(await attempt(review, controller.signal)).toMatchObject({
    state: 'provider-order-matched',
    providerReferenceRetained: true,
  });
  await attempt(review);
  expect(create).toHaveBeenCalledTimes(1);
});
it('does not claim or call a provider for an already cancelled request', async () => {
  const review = await approved(),
    controller = new AbortController();
  controller.abort();
  await expect(attempt(review, controller.signal)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(
    await db.prepare('SELECT id FROM exchange_funding_order_attempts').first(),
  ).toBeNull();
});
it('looks up only the retained reference and never promotes provider finished/refunded to verified money', async () => {
  const review = await approved();
  await attempt(review);
  lookup.mockImplementation(async () => status('finished'));
  const result = await observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  expect(lookup.mock.calls[0][0]).toBe('provider-fixture-1');
  expect(result).toMatchObject({
    state: 'payout-unverified',
    payoutVerified: false,
    fundingAllowed: false,
  });
  lookup.mockImplementation(async () => status('waiting'));
  await expect(
    observeOwnedExchangeOrder(
      db,
      'alice',
      review.terms.id,
      new AbortController().signal,
      { lookup },
      now,
    ),
  ).rejects.toThrow('contradicted');
  expect(
    (await readOwnedExchangeOrder(db, 'alice', review.terms.id)).state,
  ).toBe('payout-unverified');
});
it('can reconcile a mismatched create response, pins its recovered deposit address and remains readable after archive', async () => {
  const review = await approved();
  create.mockImplementation(async () => ({ ...order(), toAmount: '1.09' }));
  await attempt(review);
  await db.prepare('UPDATE funding_plans SET archived=1').run();
  await observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  lookup.mockImplementation(async () => ({
    ...status(),
    payinAddress: address(11),
  }));
  await expect(
    observeOwnedExchangeOrder(
      db,
      'alice',
      review.terms.id,
      new AbortController().signal,
      { lookup },
      now,
    ),
  ).rejects.toThrow('changed');
  expect(create).toHaveBeenCalledTimes(1);
});
it('database guards refuse forged consent and mutable/deleted history', async () => {
  const review = await approved();
  await attempt(review);
  await observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  for (const table of [
    'reviews',
    'approvals',
    'attempts',
    'references',
    'results',
    'observations',
  ]) {
    const column = table === 'reviews' ? 'id' : 'review_id';
    await expect(
      db
        .prepare(
          `UPDATE exchange_funding_order_${table} SET ${column}=${column}`,
        )
        .run(),
    ).rejects.toThrow('immutable');
    await expect(
      db.prepare(`DELETE FROM exchange_funding_order_${table}`).run(),
    ).rejects.toThrow('Retain');
  }
  await expect(
    db.prepare('DELETE FROM exchange_funding_quotes').run(),
  ).rejects.toThrow('Retain');
});
it('serializes duplicate creation while the first transport callback is still pending', async () => {
  const review = await approved();
  let complete!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  create.mockImplementation(() => {
    entered();
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const first = attempt(review);
  await started;
  expect((await attempt(review)).state).toBe('creation-unresolved');
  expect(create).toHaveBeenCalledTimes(1);
  complete(order());
  await first;
  expect(
    (await readOwnedExchangeOrder(db, 'alice', review.terms.id)).state,
  ).toBe('provider-order-matched');
});
it('does not enter transport when the database claim consumes the rest of authorization', async () => {
  const review = await approved();
  const execute = client.execute.bind(client);
  vi.spyOn(client, 'execute').mockImplementation(async (...args) => {
    const result = await execute(...args);
    const sqlText = (value: unknown) =>
      typeof value === 'string'
        ? value
        : value &&
            typeof value === 'object' &&
            'sql' in value &&
            typeof value.sql === 'string'
          ? value.sql
          : '';
    const sql = sqlText(args[0]);
    if (sql.includes('INSERT INTO exchange_funding_order_attempts'))
      time += 5000;
    return result;
  });
  expect((await attempt(review)).state).toBe('creation-unresolved');
  expect(create).not.toHaveBeenCalled();
  const saved = await db
    .prepare('SELECT document FROM exchange_funding_order_results')
    .first<{ document: string }>();
  expect(JSON.parse(saved!.document).transportEntered).toBe(false);
});
it('rejects forged approval and unapproved attempts at the database boundary', async () => {
  const review = await prepare();
  await expect(
    db
      .prepare('INSERT INTO exchange_funding_order_approvals VALUES(?,?,?,?,?)')
      .bind(
        review.terms.id,
        'alice',
        review.sha256,
        JSON.stringify({ ...consent(review), providerCustody: false }),
        new Date(time).toISOString(),
      )
      .run(),
  ).rejects.toThrow('separate consent');
  await expect(
    db
      .prepare('INSERT INTO exchange_funding_order_attempts VALUES(?,?,?,?,?)')
      .bind(
        review.terms.id,
        'alice',
        fixture.plan.id,
        crypto.randomUUID(),
        new Date(time).toISOString(),
      )
      .run(),
  ).rejects.toThrow('fresh exact approval');
  expect(create).not.toHaveBeenCalled();
});
it('blocks a second quote from bypassing an unresolved attempt for the same draft', async () => {
  const review = await approved();
  create.mockRejectedValue(new Error('unknown'));
  await attempt(review);
  const quote = { ...fixture.review, id: crypto.randomUUID() };
  await db
    .prepare('INSERT INTO exchange_funding_quotes VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(
      quote.id,
      'alice',
      fixture.plan.id,
      3,
      2,
      JSON.stringify(fixture.plan.document),
      JSON.stringify(quote),
      'new-private-rate',
      quote.quotedAt,
      quote.expiresAt,
    )
    .run();
  await expect(
    prepareOwnedExchangeOrderReview(
      db,
      'alice',
      { quoteId: quote.id, refund },
      now,
    ),
  ).rejects.toThrow('current owned proven context');
  expect(create).toHaveBeenCalledTimes(1);
});
it('refuses a review if expiry is reached while its fingerprint is captured', async () => {
  const clock = vi
    .fn()
    .mockReturnValueOnce(time)
    .mockReturnValueOnce(time)
    .mockReturnValue(time + 56000);
  await expect(
    prepareOwnedExchangeOrderReview(
      db,
      'alice',
      { quoteId: fixture.review.id, refund },
      clock,
    ),
  ).rejects.toThrow('expired');
  expect(
    await db.prepare('SELECT id FROM exchange_funding_order_reviews').first(),
  ).toBeNull();
});
it.each([
  ['refunded', 'refund-unverified'],
  ['failed', 'provider-failed'],
  ['verifying', 'provider-verification-required'],
  ['exchanging', 'provider-processing'],
])(
  'keeps reported %s separate from money verification',
  async (reported, state) => {
    const review = await approved();
    await attempt(review);
    lookup.mockImplementation(async () => status(reported));
    expect(
      await observeOwnedExchangeOrder(
        db,
        'alice',
        review.terms.id,
        new AbortController().signal,
        { lookup },
        now,
      ),
    ).toMatchObject({
      state,
      payoutVerified: false,
      refundVerified: false,
      depositInstructionsAllowed: false,
    });
  },
);
it('database guards reject a stale concurrent status response after a terminal report', async () => {
  const review = await approved();
  await attempt(review);
  let finishSlow!: (value: unknown) => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  lookup.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      finishSlow = resolve;
    });
  });
  const stale = observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  const staleResult = expect(stale).rejects.toThrow('no payout authority');
  await entered;
  lookup.mockImplementation(async () => status('finished'));
  await observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  time += 1;
  finishSlow(status('waiting'));
  await staleResult;
  expect(
    (await readOwnedExchangeOrder(db, 'alice', review.terms.id)).state,
  ).toBe('payout-unverified');
});
it.each([4999, 5000])(
  'the database independently enforces the five-second authorization boundary (%s)',
  async (elapsed) => {
    const review = await approved();
    const insert = db
      .prepare('INSERT INTO exchange_funding_order_attempts VALUES(?,?,?,?,?)')
      .bind(
        review.terms.id,
        'alice',
        fixture.plan.id,
        crypto.randomUUID(),
        new Date(time + elapsed).toISOString(),
      )
      .run();
    if (elapsed < 5000) expect((await insert).meta.changes).toBe(1);
    else await expect(insert).rejects.toThrow('fresh exact approval');
    expect(create).not.toHaveBeenCalled();
  },
);
it('refuses foreign-owner and caller-authored provider-reference lookups', async () => {
  const review = await approved();
  await attempt(review);
  await expect(
    observeOwnedExchangeOrder(
      db,
      'bob',
      review.terms.id,
      new AbortController().signal,
      { lookup },
      now,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    observeOwnedExchangeOrder(
      db,
      'alice',
      'https://other-provider.invalid',
      new AbortController().signal,
      { lookup },
      now,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(lookup).not.toHaveBeenCalled();
});

async function paidOrder() {
  const review = await approved();
  await attempt(review);
  const f = await exchangePayoutFixture();
  lookup.mockResolvedValue({
    ...status('finished'),
    payoutHash: f.expected.signature,
  });
  await observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  const rpc = vi.fn(
    async (method: string) =>
      ({
        getGenesisHash: f.evidence.genesisBefore,
        getSignatureStatuses: f.evidence.status,
        getTransaction: f.evidence.transaction,
        getSlot: f.evidence.finalizedSlot,
      })[method],
  );
  time = f.now;
  return {
    review,
    f,
    rpc,
    verify: () =>
      verifyOwnedExchangePayout(
        db,
        'alice',
        review.terms.id,
        new AbortController().signal,
        rpc,
        now,
      ),
  };
}
it('retains an exact finalized payout once, without releasing the order hold or payment authority', async () => {
  const { review, verify, rpc } = await paidOrder();
  const receipt = await verify();
  expect(receipt).toMatchObject({
    reviewId: review.terms.id,
    payoutVerified: true,
    ...exchangeOrderAuthority,
  });
  expect(await verify()).toEqual(receipt);
  expect(rpc).toHaveBeenCalledTimes(5);
  expect(
    await readOwnedExchangeOrder(db, 'alice', review.terms.id),
  ).toMatchObject({
    state: 'payout-verified',
    payoutVerified: true,
    payoutReceipt: receipt,
    ...exchangeOrderAuthority,
  });
  expect(
    (await readOwnedExchangeOrder(db, 'alice', review.terms.id))
      .retryCreationAllowed,
  ).toBe(false);
  await expect(
    db.prepare('DELETE FROM exchange_funding_payout_receipts').run(),
  ).rejects.toThrow(/Retain/);
  await expect(
    db
      .prepare("UPDATE exchange_funding_payout_receipts SET amount_raw='1'")
      .run(),
  ).rejects.toThrow(/immutable/);
});
it('reconciles a historical payout after draft archive without treating it as current spendable balance', async () => {
  const { verify } = await paidOrder();
  await db.prepare('UPDATE funding_plans SET archived=1').run();
  expect((await verify()).currentSpendabilityVerified).toBe(false);
});
it('refuses foreign ownership before any receipt RPC call', async () => {
  const { review, rpc } = await paidOrder();
  await expect(
    verifyOwnedExchangePayout(
      db,
      'bob',
      review.terms.id,
      new AbortController().signal,
      rpc,
      now,
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(rpc).not.toHaveBeenCalled();
});
it('does not mistake provider finished status without a signature for a verified receipt', async () => {
  const review = await approved();
  await attempt(review);
  lookup.mockResolvedValue(status('finished'));
  await observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  const rpc = vi.fn();
  await expect(
    verifyOwnedExchangePayout(
      db,
      'alice',
      review.terms.id,
      new AbortController().signal,
      rpc,
      now,
    ),
  ).rejects.toThrow(/signature/);
  expect(rpc).not.toHaveBeenCalled();
});
it('keeps a retained finished signature when a later provider response omits it', async () => {
  const { review, verify } = await paidOrder();
  time++;
  lookup.mockResolvedValue(status('finished'));
  await observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  expect((await verify()).payoutVerified).toBe(true);
});
it('pins payin, payout and refund signatures even across concurrent same-status observations', async () => {
  const { review, f } = await paidOrder();
  lookup.mockResolvedValue({
    ...status('finished'),
    payoutHash: bs58.encode(new Uint8Array(64).fill(6)),
  });
  await expect(
    observeOwnedExchangeOrder(
      db,
      'alice',
      review.terms.id,
      new AbortController().signal,
      { lookup },
      now,
    ),
  ).rejects.toThrow(/reference changed/);
  const row = await db
    .prepare(
      'SELECT document FROM exchange_funding_order_observations WHERE review_id=?',
    )
    .bind(review.terms.id)
    .first<{ document: string }>();
  for (const field of ['payinHash', 'refundHash']) {
    const doc = { ...JSON.parse(row!.document), [field]: f.expected.signature };
    await db
      .prepare(
        'INSERT INTO exchange_funding_order_observations VALUES(?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        review.terms.id,
        'alice',
        JSON.stringify(doc),
        new Date(time).toISOString(),
      )
      .run();
    doc[field] = bs58.encode(new Uint8Array(64).fill(5));
    await expect(
      db
        .prepare(
          'INSERT INTO exchange_funding_order_observations VALUES(?,?,?,?,?)',
        )
        .bind(
          crypto.randomUUID(),
          review.terms.id,
          'alice',
          JSON.stringify(doc),
          new Date(time).toISOString(),
        )
        .run(),
    ).rejects.toThrow(/reference changed/);
  }
});
it('does not persist a receipt after RPC refusal or cancellation', async () => {
  const { review, rpc } = await paidOrder();
  rpc.mockRejectedValue(new Error('secret'));
  await expect(
    verifyOwnedExchangePayout(
      db,
      'alice',
      review.terms.id,
      new AbortController().signal,
      rpc,
      now,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(
    await db.prepare('SELECT * FROM exchange_funding_payout_receipts').first(),
  ).toBeNull();
});
it('database guards reject changed receipt identity, amount, time and authority and prevent duplicate credit', async () => {
  const { verify } = await paidOrder();
  await verify();
  const row = await db
    .prepare('SELECT * FROM exchange_funding_payout_receipts')
    .first<Record<string, string>>();
  const insert = (v: Record<string, string>) =>
    db
      .prepare(
        'INSERT INTO exchange_funding_payout_receipts(review_id,owner_id,observation_id,signature,recipient,amount_raw,document,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        ...[
          'review_id',
          'owner_id',
          'observation_id',
          'signature',
          'recipient',
          'amount_raw',
          'document',
          'sha256',
          'created_at',
        ].map((k) => v[k]),
      )
      .run();
  await expect(insert(row!)).rejects.toThrow();
  const changes: Record<string, string>[] = [
    { owner_id: 'bob' },
    { amount_raw: '1' },
    { observation_id: crypto.randomUUID() },
    { sha256: 'invalid' },
    { created_at: '2020-01-01T00:00:00.000Z' },
  ];
  for (const change of changes)
    await expect(insert({ ...row!, ...change })).rejects.toThrow();
  for (const change of [
    { fundingAllowed: true },
    { currentSpendabilityVerified: true },
    { payoutVerified: false },
    { finalizedSlot: 119 },
    { blockTime: 1 },
    { signature: bs58.encode(new Uint8Array(64).fill(3)) },
  ])
    await expect(
      insert({
        ...row!,
        document: JSON.stringify({ ...JSON.parse(row!.document), ...change }),
      }),
    ).rejects.toThrow();
});
it('never credits the same transaction and recipient to a second owned order', async () => {
  const first = await paidOrder();
  await first.verify();
  time = Date.parse('2026-10-18T12:00:00.000Z');
  fixture.plan.id = 'second-funding-plan';
  fixture.review.planId = fixture.plan.id;
  fixture.review.id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'alice',
      fixture.plan.id,
      JSON.stringify(fixture.plan.document),
      3,
      0,
      fixture.plan.updatedAt,
    )
    .run();
  await db
    .prepare('INSERT INTO exchange_funding_quotes VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(
      fixture.review.id,
      'alice',
      fixture.plan.id,
      3,
      2,
      JSON.stringify(fixture.plan.document),
      JSON.stringify(fixture.review),
      'second-private-rate',
      fixture.review.quotedAt,
      fixture.review.expiresAt,
    )
    .run();
  const review = await approved();
  await attempt(review);
  lookup.mockResolvedValue({
    ...status('finished'),
    payoutHash: first.f.expected.signature,
  });
  await observeOwnedExchangeOrder(
    db,
    'alice',
    review.terms.id,
    new AbortController().signal,
    { lookup },
    now,
  );
  time = first.f.now;
  await expect(
    verifyOwnedExchangePayout(
      db,
      'alice',
      review.terms.id,
      new AbortController().signal,
      first.rpc,
      now,
    ),
  ).rejects.toThrow(/hold remains/);
  expect(
    (
      await db
        .prepare('SELECT count(*) AS n FROM exchange_funding_payout_receipts')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});
