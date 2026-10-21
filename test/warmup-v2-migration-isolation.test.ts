import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
it('adds v2 consent without changing any existing trigger body or schema object', () => {
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  const end = journal.entries.findIndex(
    (e) => e.tag === '0132_wallet_warmup_session_v2_consents',
  );
  expect(end).toBe(132);
  const db = new DatabaseSync(':memory:');
  try {
    const apply = (tag: string) => {
      for (const sql of readFileSync(`drizzle/${tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        db.exec(sql);
    };
    for (const entry of journal.entries.slice(0, end)) apply(entry.tag);
    const before = db
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    apply(journal.entries[end].tag);
    const after = db
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    for (const row of before)
      expect(
        after.find((n) => n.type === row.type && n.name === row.name),
      ).toEqual(row);
    expect(after.length - before.length).toBe(7);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});
