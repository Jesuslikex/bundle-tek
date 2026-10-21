import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
it('adds v2 journals and restrictive cross-version guards without changing old schema bodies', () => {
  const entries = (
    JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string }[];
    }
  ).entries;
  const end = entries.findIndex(
    (e) => e.tag === '0133_wallet_warmup_session_v2_journals',
  );
  expect(end).toBe(133);
  const db = new DatabaseSync(':memory:');
  try {
    const apply = (tag: string) => {
      for (const sql of readFileSync(`drizzle/${tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        db.exec(sql);
    };
    for (const entry of entries.slice(0, end)) apply(entry.tag);
    const schema = () =>
      db
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all();
    const before = schema();
    apply(entries[end].tag);
    const after = schema();
    for (const row of before)
      expect(
        after.find((n) => n.type === row.type && n.name === row.name),
      ).toEqual(row);
    expect(after.length - before.length).toBe(17);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});
