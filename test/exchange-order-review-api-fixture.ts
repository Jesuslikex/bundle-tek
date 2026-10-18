import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { createTursoDatabase } from '../db/turso';
import { exchangeFundingReviewFixture } from './exchange-funding-review-fixture';
export async function exchangeOrderReviewApiFixture() {
  const now = Date.parse('2026-10-18T12:00:00.000Z'),
    base = exchangeFundingReviewFixture(now);
  const client = createClient({ url: ':memory:' }),
    db = createTursoDatabase(client);
  const refund = {
    address: bs58.encode(new Uint8Array(32).fill(8)),
    revision: 4,
  };
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
        base.plan.revision,
        base.funder.revision,
        JSON.stringify(base.plan.document),
        JSON.stringify(base.review),
        'private-fixture-rate',
        base.review.quotedAt,
        base.review.expiresAt,
      )
      .run();
    return {
      client,
      db,
      base,
      refund,
      now,
      input: { quoteId: base.review.id, refund },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
