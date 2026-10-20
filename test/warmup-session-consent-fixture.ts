import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import { warmupSessionReviewFixture } from './warmup-session-review-fixture';
import { loadWalletWarmupProgress } from '@/lib/wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from '@/lib/wallet-warmup-session-review';
import { walletWarmupSessionDigest as digest } from '@/lib/wallet-warmup-session-digest';
import { retainWalletWarmupSessionReview } from '@/lib/wallet-warmup-session-storage';
import { reviewWalletWarmupSessionConsent as review } from '@/lib/wallet-warmup-session-consent';
const signal = () => new AbortController().signal;
/** Synthetic public plan and disposable memory SQL. No secrets or provider requests. */
export async function warmupSessionConsentFixture() {
  const client = createClient({ url: 'file::memory:', intMode: 'number' });
  const db = createTursoDatabase(client);
  for (const sql of [
    'CREATE TABLE wallet_warmup_plans(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,document TEXT,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,plan_id TEXT,id TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,wallet_address TEXT,signature TEXT,remaining_raw TEXT,document TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,plan_id TEXT,id TEXT,buy_receipt_id TEXT,consumed_raw TEXT,signature TEXT,document TEXT)',
    'CREATE TABLE solana_swap_reservations(owner_id TEXT,intent_id TEXT,wallet_address TEXT,state TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,state TEXT)',
  ])
    await db.prepare(sql).run();
  for (const name of [
    '0117_wallet_warmup_session_reviews',
    '0122_wallet_warmup_session_consents',
    '0123_wallet_warmup_session_consent_bounds',
  ])
    for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  const f = warmupSessionReviewFixture();
  await db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'owner',
      f.plan.id,
      1,
      0,
      f.plan.updatedAt,
      JSON.stringify(f.plan.document),
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
    .bind('owner', 'Solana', f.plan.document.addresses[0], 1, 0)
    .run();
  const current = await loadWalletWarmupProgress(
      db,
      'owner',
      f.plan.id,
      1,
      false,
      true,
    ),
    at = Date.now(),
    body = reviewWalletWarmupSession(
      current.plan,
      current.progress,
      current.performance,
      at,
    );
  const kept = await retainWalletWarmupSessionReview(
    db,
    'owner',
    {
      id: crypto.randomUUID(),
      planId: f.plan.id,
      revision: 1,
      reviewedAt: body.reviewedAt,
      reviewSha256: await digest(body.contextKey),
    },
    true,
    signal(),
  );
  const selected = {
    reviewId: kept.id,
    reviewSha256: kept.reviewSha256,
    sessionExpiresAt: new Date(at + 120000).toISOString(),
  };
  const prepared = await review(db, 'owner', selected, signal());
  const input = {
    ...selected,
    id: crypto.randomUUID(),
    termsSha256: prepared.termsSha256,
  };
  return { client, db, plan: f.plan, input, prepared, retainedReview: kept };
}
