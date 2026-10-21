import { expect, it, vi } from 'vitest';
import { warmupV2AttemptProviderFixture } from '@/test/warmup-session-v2-attempt-provider-fixture';
import {
  prepareWalletWarmupV2Attempt as prepare,
  readWalletWarmupV2Attempt as read,
} from './wallet-warmup-session-v2-attempts';
import { createWalletWarmupV2Provider } from './wallet-warmup-session-v2-provider';
// Actual elapsed SQLite time. Never backdate a lease or remove a clock guard.
it.skipIf(process.env.BUNDLE_WARMUP_DB_CLOCK_QA !== '1')(
  'expires an unknown lease, refuses its late outcome and performs fresh real-parser reads after the original capture expires',
  async () => {
    const f = await warmupV2AttemptProviderFixture();
    try {
      const finish = f.v2Journal.consent.terms.sessionExpiresAt,
        controller = new AbortController(),
        { previewRequested: _approved, ...input } = f.input();
      const first = await prepare(
        f.db,
        'owner',
        input,
        true,
        controller.signal,
        'synthetic-key',
        () => async () => {
          controller.abort();
          throw Error('synthetic cancellation');
        },
      );
      expect(first.outcome).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 61050));
      const sqlClock = await f.db
        .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at")
        .first<{ at: string }>();
      expect(sqlClock?.at).toBeTruthy();
      expect(Date.parse(sqlClock!.at)).toBeGreaterThan(
        Date.parse(first.lease.expires_at),
      );
      expect(
        Date.now() -
          Date.parse(
            f.v2Journal.consent.terms.reviewDocument
              ? JSON.parse(f.v2Journal.consent.terms.reviewDocument).reviewedAt
              : '',
          ),
      ).toBeGreaterThan(60000);
      const at = new Date().toISOString();
      await expect(
        f.db
          .prepare(`INSERT OR REPLACE INTO wallet_warmup_session_v2_attempts
 SELECT owner_id,?,journal_id,action_id,2,2,?,version,head_sha256,terms_sha256,strftime('%Y-%m-%dT%H:%M:%fZ','now'),min(strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),finish_at)
 FROM wallet_warmup_session_v2_attempt_context WHERE owner_id=? AND journal_id=?`)
          .bind(input.id, input.id, 'owner', input.journalId)
          .run(),
      ).rejects.toThrow('attempt is unavailable');
      expect(
        (await read(f.db, 'owner', input.id, new AbortController().signal))
          ?.lease,
      ).toEqual(first.lease);
      await expect(
        f.db
          .prepare(
            'INSERT INTO wallet_warmup_session_v2_attempt_outcomes(owner_id,attempt_id,kind,summary_document,unsigned_transaction,packet_sha256,refusal_code,created_at,expires_at,record_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            'owner',
            input.id,
            'refused',
            null,
            null,
            null,
            'provider-refused',
            at,
            at,
            '0'.repeat(64),
          )
          .run(),
      ).rejects.toThrow('expired or changed');
      const fetcher = vi.fn(async (url: RequestInfo | URL) => {
        const parsed = new URL(url instanceof Request ? url.url : url);
        expect(parsed.origin + parsed.pathname).toBe(
          'https://api.jup.ag/swap/v2/order',
        );
        return Response.json(f.quote(parsed));
      });
      vi.stubGlobal('fetch', fetcher);
      const { previewRequested: _nextApproved, ...nextInput } = f.input();
      const saved = await prepare(
        f.db,
        'owner',
        nextInput,
        true,
        new AbortController().signal,
        'synthetic-key',
        (db, owner, key, lease) =>
          createWalletWarmupV2Provider(db, owner, key, lease, {
            simulate: async (order) => f.simulation(order),
          }),
      );
      expect(saved.outcome?.kind).toBe('prepared');
      expect(saved.lease.attempt_no).toBe(2);
      expect(saved.lease.previous_id).toBe(input.id);
      expect(saved.lease.expires_at).toBe(finish);
      expect(saved.journal.consent.terms.sessionExpiresAt).toBe(finish);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(
        (await read(f.db, 'owner', input.id, new AbortController().signal))
          ?.lease,
      ).toEqual(first.lease);
    } finally {
      vi.unstubAllGlobals();
      f.client.close();
    }
  },
  75000,
);
