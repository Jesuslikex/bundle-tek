import { readFileSync } from 'node:fs';
import { warmupSessionConsentFixture } from './warmup-session-consent-fixture';
import { reviewWalletWarmupV2Consent } from '@/lib/wallet-warmup-session-v2-consent';
export async function warmupSessionV2ConsentFixture() {
  const f = await warmupSessionConsentFixture();
  try {
    const legacy = await f.db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all<{ name: string; sql: string }>();
    for (const sql of readFileSync(
      'drizzle/0132_wallet_warmup_session_v2_consents.sql',
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await f.db.prepare(sql).run();
    const selection = {
      reviewId: f.input.reviewId,
      reviewSha256: f.input.reviewSha256,
      sessionExpiresAt: f.input.sessionExpiresAt,
    };
    const prepared = await reviewWalletWarmupV2Consent(
      f.db,
      'owner',
      selection,
      new AbortController().signal,
    );
    return {
      ...f,
      legacy: legacy.results,
      selection,
      v2Prepared: prepared,
      v2Input: {
        ...selection,
        id: crypto.randomUUID(),
        termsSha256: prepared.termsSha256,
      },
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
