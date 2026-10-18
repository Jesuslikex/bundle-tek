import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { createTursoDatabase } from '../db/turso';
import { exchangeFundingReviewFixture } from './exchange-funding-review-fixture';
import { exchangePayoutFixture } from './exchange-payout-fixture';
import {
  prepareOwnedExchangeOrderReview,
  approveOwnedExchangeOrderReview,
  attemptOwnedExchangeOrder,
  observeOwnedExchangeOrder,
} from '../lib/exchange-order-service';
/** Disposable local SQL and deterministic provider/packet fixtures. No live order or vault. */
export async function exchangePayoutApiFixture(withSignature = true) {
  const initial = Date.parse('2026-10-18T12:00:00.000Z'),
    base = exchangeFundingReviewFixture(initial),
    payout = await exchangePayoutFixture();
  const client = createClient({ url: ':memory:' }),
    db = createTursoDatabase(client);
  const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n)),
    refund = { address: key(8), revision: 4 };
  try {
    await client.executeMultiple(
      'CREATE TABLE funding_plans(owner_id TEXT,id TEXT,document TEXT,revision INTEGER,archived INTEGER,updated_at TEXT); CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER); CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT);',
    );
    for (const name of [
      '0012_messy_zzzax',
      '0103_exchange_funding_quotes',
      '0104_exchange_funding_orders',
      '0106_exchange_payout_receipts',
    ])
      await client.executeMultiple(
        await readFile('drizzle/' + name + '.sql', 'utf8'),
      );
    await db
      .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?)')
      .bind(
        'alice',
        base.plan.id,
        JSON.stringify(base.plan.document),
        base.plan.revision,
        0,
        base.plan.updatedAt,
      )
      .run();
    for (const wallet of [base.funder, refund]) {
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
      .prepare(
        'INSERT INTO exchange_funding_quotes VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        base.review.id,
        'alice',
        base.plan.id,
        3,
        2,
        JSON.stringify(base.plan.document),
        JSON.stringify(base.review),
        'private-fixture-rate',
        base.review.quotedAt,
        base.review.expiresAt,
      )
      .run();
    const review = await prepareOwnedExchangeOrderReview(
      db,
      'alice',
      { quoteId: base.review.id, refund },
      () => initial,
    );
    await approveOwnedExchangeOrderReview(
      db,
      'alice',
      {
        reviewId: review.terms.id,
        sha256: review.sha256,
        exactAmountsAndNetwork: true,
        providerCustody: true,
        verificationMayBeRequired: true,
        refundAddressReviewed: true,
      },
      () => initial,
    );
    const order = {
      id: 'private-provider-fixture',
      currency: 'sol',
      network: 'sol',
      fromAmount: '1.15',
      toAmount: '1.1',
      payinAddress: key(9),
      payoutAddress: base.funder.address,
      refundAddress: refund.address,
    };
    await attemptOwnedExchangeOrder(
      db,
      'alice',
      { reviewId: review.terms.id, sha256: review.sha256 },
      new AbortController().signal,
      { create: async () => order },
      () => initial,
    );
    await observeOwnedExchangeOrder(
      db,
      'alice',
      review.terms.id,
      new AbortController().signal,
      {
        lookup: async () => ({
          ...order,
          fromCurrency: 'sol',
          toCurrency: 'sol',
          fromNetwork: 'sol',
          toNetwork: 'sol',
          expectedAmountFrom: '1.15',
          expectedAmountTo: '1.1',
          status: 'finished',
          ...(withSignature ? { payoutHash: payout.expected.signature } : {}),
        }),
      },
      () => initial,
    );
    const result = (method: string): unknown =>
      ({
        getGenesisHash: payout.evidence.genesisBefore,
        getSignatureStatuses: payout.evidence.status,
        getTransaction: payout.evidence.transaction,
        getSlot: payout.evidence.finalizedSlot,
      })[method];
    return {
      client,
      db,
      base,
      review,
      payout,
      result,
      now: payout.now,
      input: { id: review.terms.id, sha256: review.sha256 },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
