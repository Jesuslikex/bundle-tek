import {
  solanaFamilyExclusionFixture,
  familyExclusionD1,
  advanceFamilyExclusionClock,
} from './solana-family-exclusion-fixture';
import { buildWarmupPlan } from '../lib/wallet-warmup';
import { loadWalletWarmupProgress } from '../lib/wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from '../lib/wallet-warmup-session-review';
import { retainWalletWarmupSessionReview } from '../lib/wallet-warmup-session-storage';
import { walletWarmupSessionDigest as digest } from '../lib/wallet-warmup-session-digest';
import { WARMUP_ASSET_PROBE_MINT } from '../scripts/warmup-asset-probe-policy.mjs';

/** In-memory source only, public test address, no keypair, vault, signature or
 * transaction packet. The live probe never requests this wallet's account. */
export async function warmupPublicAssetReviewFixture() {
  const databaseAt = Date.now(),
    sqlite = solanaFamilyExclusionFixture();
  try {
    const owner = 'public-asset-probe',
      planId = 'public-asset-probe';
    const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
    const at = Date.now(),
      date = new Date(at).toISOString();
    const input = {
      name: 'Public asset read-only probe',
      chain: 'Solana',
      addresses: [wallet],
      walletRevisions: [{ address: wallet, revision: 1 }],
      tokens: [WARMUP_ASSET_PROBE_MINT],
      amount: '0.001',
      feeReserve: '0.01',
      cycles: 2,
      intervalSeconds: 60,
      startAt: date,
    };
    sqlite
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at) VALUES(?,'Solana',?,'','Public test fixture','trading',?)",
      )
      .run(owner, wallet, date);
    sqlite
      .prepare(
        'INSERT INTO wallet_warmup_plans(owner_id,id,revision,archived,updated_at,document) VALUES(?,?,1,0,?,?)',
      )
      .run(
        owner,
        planId,
        date,
        JSON.stringify({
          ...input,
          totalBudget: buildWarmupPlan(input, at).totalBudget,
        }),
      );
    const db = familyExclusionD1(sqlite);
    db.batch = async <T>(statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN');
      try {
        const rows = [];
        for (const s of statements) rows.push(await s.all<T>());
        sqlite.exec('COMMIT');
        return rows;
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
    const reviewedAt = Date.now(),
      reviewed = reviewWalletWarmupSession(
        loaded.plan,
        loaded.progress,
        loaded.performance,
        reviewedAt,
      );
    advanceFamilyExclusionClock(sqlite, reviewedAt + 2 - databaseAt);
    const kept = await retainWalletWarmupSessionReview(
      db,
      owner,
      {
        id: crypto.randomUUID(),
        planId,
        revision: 1,
        reviewedAt: new Date(reviewedAt).toISOString(),
        reviewSha256: await digest(reviewed.contextKey),
      },
      true,
      new AbortController().signal,
      () => reviewedAt,
    );
    return {
      db,
      owner,
      input: { reviewId: kept.id, reviewSha256: kept.reviewSha256 },
      dispose: () => sqlite.close(),
    };
  } catch (e) {
    sqlite.close();
    throw e;
  }
}
