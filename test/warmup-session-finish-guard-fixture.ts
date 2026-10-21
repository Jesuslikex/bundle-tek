import { readFileSync } from 'node:fs';
/** Minimal disposable fixtures install only guards for their existing tables. */
export async function installWarmupSessionFinishGuards(db: D1Database) {
  for (const sql of readFileSync(
    'drizzle/0131_wallet_warmup_session_finish_guards.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((v) => v.trim())
    .filter(Boolean)) {
    const parts = /CREATE TRIGGER (\w+) BEFORE INSERT ON (\w+)/.exec(sql);
    if (!parts) throw Error('Unrecognized finish guard');
    const table = await db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .bind(parts[2])
      .first();
    const trigger = await db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?")
      .bind(parts[1])
      .first();
    if (table && !trigger) await db.prepare(sql).run();
  }
}
