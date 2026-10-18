import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { createTursoDatabase } from '../db/turso';
import { layerUiFixture } from './launch-layer-ui-fixture';
export async function layerTestStorage(f = layerUiFixture()) {
  const client = createClient({ url: ':memory:' });
  const db = createTursoDatabase(client);
  await client.executeMultiple(`
    CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER,PRIMARY KEY(owner_id,id));
    CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,folder_id TEXT,folder_ids TEXT,label TEXT,role TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,PRIMARY KEY(owner_id,chain,address));
    CREATE TABLE wallet_folders(owner_id TEXT,id TEXT,chain TEXT,name TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,PRIMARY KEY(owner_id,id));
    CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,chain TEXT,address TEXT,document TEXT,revision INTEGER,archived INTEGER,PRIMARY KEY(owner_id,id));
  `);
  await client.executeMultiple(
    await readFile('drizzle/0109_launch_layer_plans.sql', 'utf8'),
  );
  await db
    .prepare('INSERT INTO workspace_projects VALUES(?,?,?,?,?)')
    .bind(
      'alice',
      f.selection.projectId,
      JSON.stringify(f.document),
      f.updatedAt,
      0,
    )
    .run();
  for (const w of f.context.workspace.wallets)
    await db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(
        'alice',
        'Solana',
        w.address,
        w.folderId,
        JSON.stringify(w.folderIds),
        w.label,
        w.role,
        w.revision,
        Number(w.archived),
        w.updatedAt,
      )
      .run();
  return { client, db };
}
