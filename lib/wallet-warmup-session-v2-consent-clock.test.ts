import { expect, it } from 'vitest';
import { warmupSessionV2ConsentFixture } from '@/test/warmup-session-v2-consent-fixture';
import {
  retainWalletWarmupV2Consent,
  readWalletWarmupV2Consent,
} from './wallet-warmup-session-v2-consent';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';

// Explicit slow database-clock QA. No fake SQL clock, trigger removal or backdated
// insertion. Ordinary regression runs skip this; qualification runs opt in once.
it.skipIf(process.env.BUNDLE_WARMUP_DB_CLOCK_QA !== '1')(
  'keeps v2 recovery but refuses new consent after the real initial DB-clock window',
  async () => {
    const a = await warmupSessionV2ConsentFixture(),
      b = await warmupSessionV2ConsentFixture(),
      signal = new AbortController().signal;
    try {
      const saved = await retainWalletWarmupV2Consent(
        a.db,
        'owner',
        a.v2Input,
        true,
        signal,
      );
      const createdAt = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 61050));
      expect(
        Date.now() - Date.parse(b.v2Prepared.reviewedAt),
      ).toBeGreaterThanOrEqual(60000);
      expect(
        await readWalletWarmupV2Consent(a.db, 'owner', saved.id, signal),
      ).toEqual(saved);
      // The approved finish is still in the future, so this cannot be its guard.
      expect(Date.now()).toBeLessThan(Date.parse(b.selection.sessionExpiresAt));
      let refused: unknown;
      try {
        await b.db
          .prepare(
            'INSERT INTO wallet_warmup_session_consents_v2 VALUES(?,?,?,?,?,?)',
          )
          .bind(
            'owner',
            b.v2Input.id,
            b.selection.reviewId,
            b.v2Input.termsSha256,
            canonical(b.v2Prepared.terms),
            createdAt,
          )
          .run();
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(Error);
      const chain: string[] = [];
      let cause: unknown = refused;
      while (cause instanceof Error) {
        chain.push(cause.message);
        cause = cause.cause;
      }
      expect(chain.join('\n')).toMatch(
        /Invalid warmup session consent(?:[:\s]|$)/,
      );
      expect(chain.join('\n')).not.toContain(
        'Invalid warmup session consent deadline',
      );
      expect(
        await b.db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_session_consents_v2',
          )
          .first(),
      ).toEqual({ n: 0 });
    } finally {
      a.client.close();
      b.client.close();
    }
  },
  75000,
);
