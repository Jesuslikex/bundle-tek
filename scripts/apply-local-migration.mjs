// One-off: apply 0160 to the local dev database (migrate-turso.mjs only takes a
// fresh file). Safe to re-run: it drops and recreates the trigger.
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const db = createClient({ url: 'file:' + resolve('dev.db') });
const parts = readFileSync(
  'drizzle/0160_marketplace_operator_draft_review_window.sql',
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
for (const part of parts) await db.execute(part);
const row = await db.execute(
  "SELECT sql FROM sqlite_master WHERE name='marketplace_operator_drafts_insert'",
);
const body = String(row.rows[0]?.sql ?? '');
console.log('has 180:', body.includes('86400-180'));
console.log('has 60:', body.includes('86400-60'));
