// One-off: apply 0160 to the local dev database (migrate-turso.mjs only takes a
// fresh file). Safe to re-run: it drops and recreates the trigger.
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const db = createClient({ url: 'file:' + resolve('dev.db') });
const file = process.argv[2] ?? 'drizzle/0160_marketplace_operator_draft_review_window.sql';
const parts = readFileSync(file, 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
for (const part of parts) await db.execute(part);
console.log('applied', file);
