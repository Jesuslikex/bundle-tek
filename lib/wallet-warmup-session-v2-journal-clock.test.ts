import { expect, it } from 'vitest';
import { warmupSessionV2JournalFixture } from '@/test/warmup-session-v2-journal-fixture';
// Real native SQLite clock. No backdated insert, fake clock or removed guard.
it.skipIf(process.env.BUNDLE_WARMUP_DB_CLOCK_QA !== '1')(
  'begins the original v2 review after capture expiry without renewing finish',
  async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      const finish = f.consent.terms.sessionExpiresAt;
      await new Promise((resolve) => setTimeout(resolve, 61050));
      expect(Date.now() - Date.parse(f.v2Prepared.reviewedAt)).toBeGreaterThan(
        60000,
      );
      expect(Date.now()).toBeLessThan(Date.parse(finish));
      const { journal } = await f.append('begin-review');
      expect(journal.snapshot.phase).toBe('reviewing');
      expect(journal.snapshot.completedActions).toBe(0);
      expect(journal.consent.terms.sessionExpiresAt).toBe(finish);
      expect(journal.qualificationAvailable).toBe(false);
      expect((await f.append('stop')).journal.snapshot.phase).toBe('stopped');
    } finally {
      f.client.close();
    }
  },
  75000,
);
