import { readFileSync } from 'node:fs';
import { warmupSessionV2JournalFixture } from './warmup-session-v2-journal-fixture';
export async function warmupSessionV2AttemptFixture() {
  const f = await warmupSessionV2JournalFixture();
  try {
    for (const table of ['warmup_buy_receipts', 'warmup_sell_receipts']) {
      await f.db
        .prepare(`ALTER TABLE ${table} ADD COLUMN preparation_id TEXT`)
        .run();
      await f.db
        .prepare(`ALTER TABLE ${table} ADD COLUMN created_at TEXT`)
        .run();
    }
    await f.db
      .prepare(
        'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL)',
      )
      .run();
    for (const statement of readFileSync(
      'drizzle/0134_wallet_warmup_session_v2_attempts.sql',
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await f.db.prepare(statement).run();
    await f.append('begin-review');
    return {
      ...f,
      input: () => ({
        id: crypto.randomUUID(),
        journalId: f.journal.id,
        version: f.journal.version,
        headSha256: f.journal.headSha256,
      }),
      counts: async () =>
        Promise.all(
          [
            'wallet_warmup_session_v2_attempts',
            'wallet_warmup_session_v2_attempt_outcomes',
            'wallet_balance_gates',
          ].map(
            async (t) =>
              (
                await f.db
                  .prepare(`SELECT count(*) AS n FROM ${t}`)
                  .first<{ n: number }>()
              )?.n,
          ),
        ),
    };
  } catch (error) {
    f.client.close();
    throw error;
  }
}
