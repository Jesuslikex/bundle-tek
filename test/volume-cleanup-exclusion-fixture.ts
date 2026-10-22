import { volumeProgramFixture } from './volume-program-fixture';
import {
  solanaFamilyExclusionFixture,
  familyExclusionD1,
} from './solana-family-exclusion-fixture';
import {
  createVolumeBundleSession,
  reserveVolumeBundleRound,
} from '../lib/volume-bundle-reservations';

/** Full journal + actual disabled runtime validator with controlled RPC/code fixtures.
 * Not live provider, signing or funded proof. No guard is dropped or flag forged. */
export async function volumeCleanupExclusionFixture(
  maxMigration = Number.MAX_SAFE_INTEGER,
) {
  const sqlite = solanaFamilyExclusionFixture(maxMigration);
  try {
    const f = await volumeProgramFixture();
    const owner = 'storage-owner',
      db = familyExclusionD1(sqlite);
    const now = new Date().toISOString();
    sqlite
      .prepare(`INSERT INTO imported_token_projects(owner_id,id,chain,address,document,mutation_id,updated_at)
      VALUES(?,?,'Solana',?,?,?,?)`)
      .run(
        owner,
        f.input.projectId,
        f.input.mint,
        JSON.stringify({
          token: {
            chain: 'Solana',
            address: f.input.mint,
            decimals: 6,
            symbol: 'SYNTHETIC',
          },
        }),
        crypto.randomUUID(),
        now,
      );
    sqlite
      .prepare(`INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at)
      VALUES(?,'Solana',?,'','Synthetic','trading',?)`)
      .run(owner, f.review.wallet, now);
    sqlite
      .prepare(`INSERT INTO wallet_ownership_proofs(owner_id,chain,address,verified_at,challenge_id)
      VALUES(?,'Solana',?,?,?)`)
      .run(owner, f.review.wallet, now, crypto.randomUUID());
    const sessionInput = {
      id: f.input.sessionId,
      projectId: f.input.projectId,
      projectRevision: 1,
      mint: f.input.mint,
      plan: f.input.plan,
      wallets: [{ address: f.review.wallet, revision: 1 }],
    };
    const saved = await createVolumeBundleSession(db, owner, sessionInput);
    const request = {
      id: crypto.randomUUID(),
      sessionId: saved.id,
      sessionRevision: 1,
      walletRevision: 1,
      construction: f.review,
      route: f.route,
    };
    const deps = {
      rpc: f.rpc,
      policy: f.policy,
      minimumSlot: 1000,
      now: () => f.nowMs,
    };
    return {
      ...f,
      sqlite,
      db,
      owner,
      saved,
      request,
      deps,
      reserve: () =>
        reserveVolumeBundleRound(
          db,
          owner,
          request,
          deps,
          new AbortController().signal,
        ),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
