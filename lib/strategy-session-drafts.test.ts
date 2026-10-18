import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTursoDatabase } from '../db/turso';
import {
  strategyContext,
  strategyInput,
  strategyProject,
  strategyWallet,
} from '../test/strategy-session-fixture';
import {
  saveStrategyDraft,
  listStrategyDrafts,
  archiveStrategyDraft,
} from './strategy-session-drafts';
let client: Client, db: D1Database;
const id = '00000000-0000-4000-8000-000000000010';
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
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
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
it('saves, reopens and retries immutable canonical terms without creating an executing session', async () => {
  const saved = await saveStrategyDraft(db, 'owner', id, strategyInput());
  expect(saved).toMatchObject({ id, revision: 1, archived: false });
  expect(await saveStrategyDraft(db, 'owner', id, strategyInput())).toEqual(
    saved,
  );
  const page = await listStrategyDrafts(db, 'owner', strategyProject);
  expect(page.drafts).toEqual([saved]);
  expect(page.next).toBeNull();
  expect(page.executionAllowed).toBe(false);
});
it('returns a retained retry after project and wallet revisions change, without refreshing its terms', async () => {
  const saved = await saveStrategyDraft(db, 'owner', id, strategyInput());
  await client.execute(
    'UPDATE imported_token_projects SET revision=2,archived=1',
  );
  await client.execute('UPDATE workspace_wallets SET revision=3,archived=1');
  expect(await saveStrategyDraft(db, 'owner', id, strategyInput())).toEqual(
    saved,
  );
});
it('rejects different terms reusing a saved ID', async () => {
  await saveStrategyDraft(db, 'owner', id, strategyInput());
  const input = strategyInput();
  input.name = 'Changed';
  await expect(saveStrategyDraft(db, 'owner', id, input)).rejects.toMatchObject(
    { status: 409 },
  );
});
it('does not disclose or modify another owner’s drafts', async () => {
  await saveStrategyDraft(db, 'owner', id, strategyInput());
  await expect(
    listStrategyDrafts(db, 'other', strategyProject),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    archiveStrategyDraft(db, 'other', strategyProject, id, 1, true),
  ).rejects.toMatchObject({ status: 404 });
});
it.each(['wallet', 'project', 'archived'] as const)(
  'refuses changed %s context',
  async (change) => {
    if (change === 'wallet')
      await client.execute('UPDATE workspace_wallets SET revision=2');
    if (change === 'project')
      await client.execute('UPDATE imported_token_projects SET revision=2');
    if (change === 'archived')
      await client.execute('UPDATE imported_token_projects SET archived=1');
    await expect(
      saveStrategyDraft(db, 'owner', id, strategyInput()),
    ).rejects.toThrow();
    expect(
      (
        await client.execute(
          'SELECT count(*) AS n FROM strategy_session_drafts',
        )
      ).rows[0].n,
    ).toBe(0);
  },
);
it('atomically refuses a wallet edit during asynchronous fingerprinting', async () => {
  const original = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
    await client.execute({
      sql: 'UPDATE workspace_wallets SET revision=3 WHERE address=?',
      args: [strategyWallet],
    });
    return original(...args);
  });
  await expect(
    saveStrategyDraft(db, 'owner', id, strategyInput()),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await client.execute('SELECT count(*) AS n FROM strategy_session_drafts'))
      .rows[0].n,
  ).toBe(0);
});
it('supports idempotent archive retries and explicit restore with revision checks', async () => {
  await saveStrategyDraft(db, 'owner', id, strategyInput());
  const archived = await archiveStrategyDraft(
    db,
    'owner',
    strategyProject,
    id,
    1,
    true,
  );
  expect(archived).toMatchObject({ archived: true, revision: 2 });
  expect(
    await archiveStrategyDraft(db, 'owner', strategyProject, id, 1, true),
  ).toEqual(archived);
  expect(
    (await listStrategyDrafts(db, 'owner', strategyProject)).drafts,
  ).toHaveLength(0);
  expect(
    (await listStrategyDrafts(db, 'owner', strategyProject, true)).drafts,
  ).toHaveLength(1);
  expect(
    await archiveStrategyDraft(db, 'owner', strategyProject, id, 2, false),
  ).toMatchObject({ archived: false, revision: 3 });
  await expect(
    archiveStrategyDraft(db, 'owner', strategyProject, id, 1, true),
  ).rejects.toMatchObject({ status: 409 });
});
it('paginates tied timestamps without skipping or repeating drafts', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));
  try {
    for (let n = 10; n < 33; n++)
      await saveStrategyDraft(
        db,
        'owner',
        `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        strategyInput(),
      );
  } finally {
    vi.useRealTimers();
  }
  const first = await listStrategyDrafts(db, 'owner', strategyProject),
    second = await listStrategyDrafts(
      db,
      'owner',
      strategyProject,
      false,
      first.next!,
    );
  expect(first.drafts).toHaveLength(20);
  expect(second.drafts).toHaveLength(3);
  expect(
    new Set([...first.drafts, ...second.drafts].map((d) => d.id)).size,
  ).toBe(23);
  expect(second.next).toBeNull();
});
it('database guards refuse document mutation, missing authority fields and deletion', async () => {
  await saveStrategyDraft(db, 'owner', id, strategyInput());
  await expect(
    client.execute(
      "UPDATE strategy_session_drafts SET document='{}',revision=2,archived=1",
    ),
  ).rejects.toThrow();
  await expect(
    client.execute('DELETE FROM strategy_session_drafts'),
  ).rejects.toThrow();
  const row = (await client.execute('SELECT * FROM strategy_session_drafts'))
    .rows[0];
  const document = JSON.parse(row.document as string);
  delete document.executionAllowed;
  await expect(
    client.execute({
      sql: 'INSERT INTO strategy_session_drafts SELECT ?,owner_id,project_id,project_revision,1,0,?,sha256,created_at FROM strategy_session_drafts',
      args: ['00000000-0000-4000-8000-000000000099', JSON.stringify(document)],
    }),
  ).rejects.toThrow();
});
it('uses a fresh atomic capacity check and archive frees active capacity', async () => {
  await saveStrategyDraft(db, 'owner', id, strategyInput());
  await client.execute(
    "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<99) INSERT INTO strategy_session_drafts SELECT printf('10000000-0000-4000-8000-%012d',n.v),s.owner_id,s.project_id,s.project_revision,1,0,s.document,s.sha256,s.created_at FROM n,strategy_session_drafts s WHERE s.id='00000000-0000-4000-8000-000000000010'",
  );
  const another = '00000000-0000-4000-8000-000000000099';
  await expect(
    saveStrategyDraft(db, 'owner', another, strategyInput()),
  ).rejects.toMatchObject({ status: 409 });
  await archiveStrategyDraft(db, 'owner', strategyProject, id, 1, true);
  await expect(
    saveStrategyDraft(db, 'owner', another, strategyInput()),
  ).resolves.toMatchObject({ id: another });
  await expect(
    archiveStrategyDraft(db, 'owner', strategyProject, id, 2, false),
  ).rejects.toMatchObject({ status: 409 });
});
it('rejects unknown or foreign project cursors while retaining anchors after archive', async () => {
  await saveStrategyDraft(db, 'owner', id, strategyInput());
  await archiveStrategyDraft(db, 'owner', strategyProject, id, 1, true);
  await expect(
    listStrategyDrafts(db, 'owner', strategyProject, false, id),
  ).resolves.toMatchObject({ drafts: [] });
  await expect(
    listStrategyDrafts(
      db,
      'owner',
      strategyProject,
      false,
      '00000000-0000-4000-8000-000000000099',
    ),
  ).rejects.toMatchObject({ status: 404 });
  const otherProject = '00000000-0000-4000-8000-000000000098',
    otherId = '00000000-0000-4000-8000-000000000099';
  await client.execute({
    sql: 'INSERT INTO imported_token_projects SELECT ?,owner_id,revision,archived,document FROM imported_token_projects',
    args: [otherProject],
  });
  await saveStrategyDraft(db, 'owner', otherId, {
    ...strategyInput(),
    projectId: otherProject,
  });
  await expect(
    listStrategyDrafts(db, 'owner', strategyProject, false, otherId),
  ).rejects.toMatchObject({ status: 404 });
});
it('stored fingerprint failure never yields a partially trusted history page', async () => {
  await saveStrategyDraft(db, 'owner', id, strategyInput());
  await client.execute('DROP TRIGGER strategy_session_drafts_immutable');
  await client.execute(
    "UPDATE strategy_session_drafts SET sha256='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
  );
  await expect(
    listStrategyDrafts(db, 'owner', strategyProject),
  ).rejects.toThrow('differs');
});
