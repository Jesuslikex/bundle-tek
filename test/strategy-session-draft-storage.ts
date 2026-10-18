import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '../db/turso';
import { strategyContext, strategyProject } from './strategy-session-fixture';
export async function strategyDraftStorage() {
  const client = createClient({ url: 'file::memory:' }),
    db = createTursoDatabase(client);
  await client.execute(
    'CREATE TABLE imported_token_projects(id TEXT,owner_id TEXT,revision INTEGER,archived INTEGER,document TEXT)',
  );
  await client.execute(
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
  );
  for (const sql of readFileSync(
    'drizzle/0108_strategy_session_drafts.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await client.execute(sql);
  await client.execute({
    sql: 'INSERT INTO imported_token_projects VALUES(?,?,1,0,?)',
    args: [
      strategyProject,
      'owner',
      JSON.stringify({ token: strategyContext().token }),
    ],
  });
  for (const wallet of strategyContext().wallets)
    await client.execute({
      sql: 'INSERT INTO workspace_wallets VALUES(?,?,?,?,0)',
      args: ['owner', wallet.chain, wallet.address, wallet.revision],
    });
  return { client, db };
}
