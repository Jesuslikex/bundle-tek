import {
  solanaFamilyExclusionFixture,
  familyExclusionD1,
  advanceFamilyExclusionClock,
} from './solana-family-exclusion-fixture';
import { warmupSessionSettlementFixture } from './warmup-session-settlement-fixture';
import { buildWarmupPlan } from '../lib/wallet-warmup';
import { loadWalletWarmupProgress } from '../lib/wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from '../lib/wallet-warmup-session-review';
import { retainWalletWarmupSessionReview } from '../lib/wallet-warmup-session-storage';
import { walletWarmupSessionDigest as digest } from '../lib/wallet-warmup-session-digest';
import { decodeWarmupBuyReceipt } from '../lib/warmup-buy-receipt';

/** All original migrations/guards. Synthetic signed transfer envelopes and
 * controlled receipt metadata only; no funded DEX, provider or execution proof. */
export async function warmupExecutionSourceFixture(
  history: 'none' | 'buy' | 'sold' = 'none',
  options: { acquiredRaw?: string; intervalSeconds?: number } = {},
) {
  const databaseAt = Date.now();
  const sqlite = solanaFamilyExclusionFixture();
  try {
    const packets = await warmupSessionSettlementFixture();
    if (options.acquiredRaw !== undefined) {
      if (history !== 'buy')
        throw Error('Raw-amount fixture supports a captured buy only');
      const raw = structuredClone(packets.buy.raw);
      raw.meta.postTokenBalances[0].uiTokenAmount.amount = options.acquiredRaw;
      packets.buyDocument = {
        ...packets.buyDocument,
        ...(await decodeWarmupBuyReceipt(
          raw,
          packets.buy.preparation,
          packets.buy.signature,
        )),
      };
    }
    const owner = 'source-owner';
    const at = Date.now();
    let now = at;
    const date = new Date(at).toISOString();
    const input = {
      name: 'Synthetic source snapshot',
      chain: 'Solana',
      addresses: [packets.wallet],
      walletRevisions: [{ address: packets.wallet, revision: 1 }],
      tokens: [packets.mint],
      amount: '0.001',
      feeReserve: '0.01',
      cycles: 2,
      intervalSeconds: options.intervalSeconds ?? 60,
      startAt: date,
    };
    const planId = packets.buy.preparation.planId;
    sqlite
      .prepare(`INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at)
     VALUES(?,'Solana',?,'','Synthetic source wallet','trading',?)`)
      .run(owner, packets.wallet, date);
    sqlite
      .prepare(`INSERT INTO wallet_warmup_plans(owner_id,id,revision,archived,updated_at,document)
     VALUES(?,?,1,0,?,?)`)
      .run(
        owner,
        planId,
        date,
        JSON.stringify({
          ...input,
          totalBudget: buildWarmupPlan(input, at).totalBudget,
        }),
      );
    const buy = () =>
      sqlite
        .prepare(`INSERT INTO warmup_buy_receipts
     (id,owner_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,signature,document,created_at,remaining_raw)
     VALUES(?,?,?,?,1,1,?,1,?,?,?,?)`)
        .run(
          packets.buy.receiptId,
          owner,
          packets.buy.preparation.id,
          planId,
          packets.wallet,
          packets.buy.signature,
          JSON.stringify(packets.buyDocument),
          date,
          packets.buyDocument.acquiredRaw,
        );
    const sell = () => {
      sqlite
        .prepare(
          'UPDATE warmup_buy_receipts SET remaining_raw=? WHERE owner_id=? AND id=?',
        )
        .run('0', owner, packets.buy.receiptId);
      sqlite
        .prepare(`INSERT INTO warmup_sell_receipts
       (id,owner_id,preparation_id,buy_receipt_id,plan_id,signature,consumed_raw,document,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(
          packets.sell.receiptId,
          owner,
          packets.sell.preparation.id,
          packets.buy.receiptId,
          planId,
          packets.sell.signature,
          packets.sellDocument.consumedRaw,
          JSON.stringify(packets.sellDocument),
          date,
        );
    };
    if (history !== 'none') buy();
    if (history === 'sold') sell();
    const db = familyExclusionD1(sqlite);
    db.batch = async <T>(statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements)
          results.push(await statement.all<T>());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    };
    const loaded = await loadWalletWarmupProgress(
      db,
      owner,
      planId,
      1,
      false,
      true,
    );
    const reviewed = reviewWalletWarmupSession(
      loaded.plan,
      loaded.progress,
      loaded.performance,
      at,
    );
    const kept = await retainWalletWarmupSessionReview(
      db,
      owner,
      {
        id: crypto.randomUUID(),
        planId,
        revision: 1,
        reviewedAt: reviewed.reviewedAt,
        reviewSha256: await digest(reviewed.contextKey),
      },
      true,
      new AbortController().signal,
      () => at + 1,
    );
    now = at + 1;
    advanceFamilyExclusionClock(sqlite, at + 2 - databaseAt);
    return {
      sqlite,
      db,
      packets,
      owner,
      planId,
      kept,
      at,
      buy,
      sell,
      input: { reviewId: kept.id, reviewSha256: kept.reviewSha256 },
      clock: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  } catch (e) {
    sqlite.close();
    throw e;
  }
}
