import { expect, it, vi } from 'vitest';
import { warmupSessionV2AttemptFixture } from '@/test/warmup-session-v2-attempt-fixture';
import { prepareWalletWarmupV2Attempt as prepare } from './wallet-warmup-session-v2-attempts';
import { WalletWarmupSessionProviderError } from './wallet-warmup-session-provider';
it.skipIf(process.env.BUNDLE_WARMUP_DB_CLOCK_QA !== '1')(
  'keeps the three-attempt cap after three real cooldowns and capture expiry, with no pending/finish/gate excuse',
  async () => {
    const f = await warmupSessionV2AttemptFixture();
    try {
      const callback = vi.fn(async () => {
          throw new WalletWarmupSessionProviderError('synthetic refusal');
        }),
        factory = () => callback;
      let lastId = '';
      for (let i = 1; i <= 3; i++) {
        const saved = await prepare(
          f.db,
          'owner',
          f.input(),
          true,
          new AbortController().signal,
          'synthetic-key',
          factory,
        );
        expect(saved.outcome?.kind).toBe('refused');
        expect(saved.lease.attempt_no).toBe(i);
        lastId = saved.lease.id;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(
              0,
              Date.parse(saved.lease.created_at) + 30100 - Date.now(),
            ),
          ),
        );
      }
      const clock = await f.db
        .prepare(
          "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at,CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS ms",
        )
        .first<{ at: string; ms: number }>();
      expect(
        Date.parse(clock!.at) - Date.parse(f.retainedReview.reviewedAt),
      ).toBeGreaterThan(90000);
      expect(clock!.at < f.consent.terms.sessionExpiresAt).toBe(true);
      expect(
        await f.db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_session_v2_attempt_context WHERE owner_id=? AND journal_id=?',
          )
          .bind('owner', f.journal.id)
          .first(),
      ).toEqual({ n: 1 });
      const gate = await f.db
        .prepare(
          'SELECT next_allowed_at AS at FROM wallet_balance_gates WHERE owner_id=?',
        )
        .bind('owner')
        .first<{ at: number }>();
      expect(gate!.at <= clock!.ms).toBe(true);
      await expect(
        f.db
          .prepare(`INSERT INTO wallet_warmup_session_v2_attempts
 SELECT owner_id,?,journal_id,action_id,4,4,?,version,head_sha256,terms_sha256,strftime('%Y-%m-%dT%H:%M:%fZ','now'),min(strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),finish_at)
 FROM wallet_warmup_session_v2_attempt_context WHERE owner_id=? AND journal_id=?`)
          .bind(crypto.randomUUID(), lastId, 'owner', f.journal.id)
          .run(),
      ).rejects.toThrow('attempt is unavailable');
      await expect(
        prepare(
          f.db,
          'owner',
          f.input(),
          true,
          new AbortController().signal,
          'synthetic-key',
          factory,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(callback).toHaveBeenCalledTimes(3);
      expect(await f.counts()).toEqual([3, 3, 1]);
    } finally {
      f.client.close();
    }
  },
  110000,
);
