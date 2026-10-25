import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import { DEFAULT_VENUE_OPTIONS, EMPTY_IDENTITY } from './workspace-project';
import {
  metadataEditReviewHash,
  type MetadataEditRequest,
} from './project-collaboration-metadata';
import {
  getMetadataEditSource,
  saveMetadataEdit,
  readMetadataEditReceipt,
} from './project-collaboration-metadata-storage';
const resources: DatabaseSync[] = [];
afterEach(() => {
  for (const db of resources.splice(0)) db.close();
});
const revision = '2026-10-25T00:00:00.000Z';
const shareId = '12345678-1234-4234-8234-123456789abc';
const mutationId = '87654321-1234-4234-8234-123456789abc';
const values = {
  tokenName: 'Updated name',
  ticker: 'NEW',
  description: 'Reviewed description',
};
function fixture(permission = 1, wallets = false) {
  const sql = new DatabaseSync(':memory:');
  resources.push(sql);
  const clock = new DatabaseSync(':memory:');
  resources.push(clock);
  let now = '2026-10-25T12:00:00.000Z';
  sql.function(
    'strftime',
    { varargs: true },
    (...args) =>
      clock
        .prepare(`SELECT strftime(${args.map(() => '?').join(',')}) AS value`)
        .get(...args.map((a) => (a === 'now' ? now : a)))!.value as
        | string
        | null,
  );
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries.filter((e) => !e.tag.startsWith('0151_')))
    sql.exec(readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'));
  sql.exec(
    readFileSync('drizzle/0151_project_collaboration_metadata.sql', 'utf8'),
  );
  const doc = {
    plan: structuredClone(DEFAULT_LAUNCH_PLAN),
    identity: { ...EMPTY_IDENTITY, website: 'https://private.example.test' },
    options: structuredClone(DEFAULT_VENUE_OPTIONS),
  };
  if (wallets) {
    Object.assign(doc.options, {
      wallets: {
        chain: 'Solana',
        recipients: [
          {
            address: '11111111111111111111111111111111',
            revision: 1,
            folderRevision: 0,
            root: true,
          },
        ],
      },
    });
    sql
      .prepare(
        `INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,folder_ids,label,role,updated_at) VALUES('alice','Solana','11111111111111111111111111111111','','[]','Owned','Recipient',?)`,
      )
      .run(revision);
  }
  sql
    .prepare(
      'INSERT INTO workspace_projects(owner_id,id,document,updated_at) VALUES(?,?,?,?)',
    )
    .run('alice', 'shared-project', JSON.stringify(doc), revision);
  sql
    .prepare(
      `INSERT INTO project_shares(id,owner_id,project_id,token_hash,member_id,created_at,accepted_at,expires_at,wallet_scope,metadata_edit) VALUES(?,'alice','shared-project',?,'bob',?,?,?, ?,?)`,
    )
    .run(
      shareId,
      'a'.repeat(64),
      now,
      now,
      '2026-10-26T12:00:00.000Z',
      JSON.stringify({
        format: 'project-share-wallet-scope-v1',
        projectRevision: revision,
        wallets: [],
      }),
      permission,
    );
  let beforeInsert: (() => void) | undefined;
  const db = {
    prepare(text: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          args = input;
          return statement;
        },
        async first() {
          return (
            sql.prepare(text).get(...(args as (string | number | null)[])) ??
            null
          );
        },
        async run() {
          if (
            text.includes('INSERT INTO project_collaboration_metadata_edits')
          ) {
            const effect = beforeInsert;
            beforeInsert = undefined;
            effect?.();
          }
          const result = sql
            .prepare(text)
            .run(...(args as (string | number | null)[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return {
    sql,
    db,
    doc,
    setNow(value: string) {
      now = value;
    },
    race(effect: () => void) {
      beforeInsert = effect;
    },
  };
}
async function request(db: D1Database): Promise<MetadataEditRequest> {
  const source = await getMetadataEditSource(db, 'bob', shareId);
  return {
    mutationId,
    shareId,
    projectId: 'shared-project',
    expectedUpdatedAt: revision,
    values,
    reviewHash: await metadataEditReviewHash(source, values),
    approved: true,
  };
}
const signal = () => new AbortController().signal;
it('applies the full committed migration chain plus0151 and saves exactly three fields atomically', async () => {
  const f = fixture();
  const body = await request(f.db);
  const source = await getMetadataEditSource(f.db, 'bob', shareId);
  expect(JSON.stringify(source)).not.toContain('private.example');
  const receipt = await saveMetadataEdit(f.db, 'bob', body, signal());
  const saved = f.sql
    .prepare('SELECT document,updated_at,mutation_id FROM workspace_projects')
    .get()!;
  const expected = structuredClone(f.doc);
  Object.assign(expected.plan, values);
  expect(JSON.parse(saved.document as string)).toEqual(expected);
  expect(saved.updated_at).toBe(receipt.updatedAt);
  expect(saved.mutation_id).toBe(mutationId);
  expect(receipt).toMatchObject({
    before: { tokenName: f.doc.plan.tokenName },
    after: values,
    metadataSaved: true,
    signingAllowed: false,
    publishingAllowed: false,
    walletActionsAllowed: false,
  });
  expect(JSON.stringify(receipt)).not.toMatch(
    /source_document|editor_id|owner_id|private.example/,
  );
  const event = f.sql.prepare('SELECT * FROM project_events').get()!;
  expect(event.type).toBe('project.saved');
  expect(JSON.parse(event.changes as string)).toEqual([
    'collaborator: name',
    'collaborator: symbol',
    'collaborator: description',
  ]);
  expect(await readMetadataEditReceipt(f.db, 'alice', mutationId)).toEqual(
    receipt,
  );
  expect(await readMetadataEditReceipt(f.db, 'mallory', mutationId)).toBeNull();
});
it('defaults old and read-only invites to no editing and forbids permission upgrades', async () => {
  const f = fixture(0);
  await expect(
    getMetadataEditSource(f.db, 'bob', shareId),
  ).rejects.toMatchObject({ status: 403 });
  expect(() => f.sql.exec('UPDATE project_shares SET metadata_edit=1')).toThrow(
    'immutable',
  );
  expect(() =>
    f.sql.exec('UPDATE project_shares SET metadata_edit=2'),
  ).toThrow();
});
it('only accepted active members can read an editable source', async () => {
  const f = fixture();
  await expect(
    getMetadataEditSource(f.db, 'alice', shareId),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    getMetadataEditSource(f.db, 'mallory', shareId),
  ).rejects.toMatchObject({ status: 403 });
  f.setNow('2026-10-26T12:00:00.000Z');
  await expect(
    getMetadataEditSource(f.db, 'bob', shareId),
  ).rejects.toMatchObject({ status: 403 });
});
it('recovers an exact lost response after revoke and arbitrary owner changes without replaying a write', async () => {
  const f = fixture();
  const body = await request(f.db);
  const receipt = await saveMetadataEdit(f.db, 'bob', body, signal());
  f.sql.exec(
    `UPDATE project_shares SET revoked_at='2026-10-25T12:01:00.000Z'; UPDATE workspace_projects SET document=json_set(document,'$.plan.tokenName','Owner later change'),updated_at='2026-10-25T12:02:00.000Z'`,
  );
  expect(await saveMetadataEdit(f.db, 'bob', body, signal())).toEqual(receipt);
  expect(
    f.sql.prepare('SELECT count(*) AS n FROM project_events').get()!.n,
  ).toBe(1);
  expect(await readMetadataEditReceipt(f.db, 'bob', mutationId)).toEqual(
    receipt,
  );
  await expect(
    saveMetadataEdit(
      f.db,
      'bob',
      { ...body, values: { ...values, ticker: 'OTHER' } },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it.each(['revoke', 'expiry', 'document', 'revision', 'archive'] as const)(
  'fails closed on a SQL-time %s race',
  async (kind) => {
    const f = fixture();
    const body = await request(f.db);
    f.race(() => {
      if (kind === 'revoke')
        f.sql.exec(
          `UPDATE project_shares SET revoked_at='2026-10-25T12:01:00.000Z'`,
        );
      if (kind === 'expiry') f.setNow('2026-10-26T12:00:00.000Z');
      if (kind === 'document')
        f.sql.exec(
          `UPDATE workspace_projects SET document=json_set(document,'$.identity.website','https://changed.example')`,
        );
      if (kind === 'revision')
        f.sql.exec(
          `UPDATE workspace_projects SET updated_at='2026-10-25T12:02:00.000Z'`,
        );
      if (kind === 'archive')
        f.sql.exec('UPDATE workspace_projects SET archived=1');
    });
    await expect(
      saveMetadataEdit(f.db, 'bob', body, signal()),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.sql
        .prepare('SELECT count(*) n FROM project_collaboration_metadata_edits')
        .get()!.n,
    ).toBe(0);
    expect(
      f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n,
    ).toBe(0);
  },
);
it.each(['revision', 'role', 'archive', 'owner', 'address', 'chain'] as const)(
  'retains owner wallet eligibility inside SQL for %s races',
  async (kind) => {
    const f = fixture(1, true);
    const body = await request(f.db);
    f.race(() => {
      const changes = {
        revision: 'revision=2',
        role: "role='Deployer'",
        archive: 'archived=1',
        owner: "owner_id='other'",
        address: "address='SysvarRent111111111111111111111111111111111'",
        chain: "chain='Base'",
        folder: 'folder_ids=\'["new-folder"]\'',
      };
      f.sql.exec(`UPDATE workspace_wallets SET ${changes[kind]}`);
    });
    await expect(
      saveMetadataEdit(f.db, 'bob', body, signal()),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.sql
        .prepare('SELECT count(*) n FROM project_collaboration_metadata_edits')
        .get()!.n,
    ).toBe(0);
  },
);
it('admits a current root recipient and skips an absent deployer exactly like owner saves', async () => {
  const f = fixture(1, true);
  expect(
    await saveMetadataEdit(f.db, 'bob', await request(f.db), signal()),
  ).toMatchObject({ metadataSaved: true });
});
it('rolls back project, audit and event together when the event insert fails', async () => {
  const f = fixture();
  const body = await request(f.db);
  f.sql.exec(
    `CREATE TRIGGER test_event_failure BEFORE INSERT ON project_events BEGIN SELECT RAISE(ABORT,'test event refusal'); END;`,
  );
  await expect(
    saveMetadataEdit(f.db, 'bob', body, signal()),
  ).rejects.toMatchObject({ status: 503 });
  expect(
    f.sql.prepare('SELECT document FROM workspace_projects').get()!.document,
  ).toBe(JSON.stringify(f.doc));
  expect(
    f.sql
      .prepare('SELECT count(*) n FROM project_collaboration_metadata_edits')
      .get()!.n,
  ).toBe(0);
  expect(await readMetadataEditReceipt(f.db, 'bob', mutationId)).toBeNull();
});
it.each(['approved', 'unknown', 'hash', 'revision', 'no-op'] as const)(
  'refuses invalid %s without writes',
  async (kind) => {
    const f = fixture();
    const body: Record<string, unknown> = { ...(await request(f.db)) };
    if (kind === 'approved') body.approved = false;
    if (kind === 'unknown') body.walletActionsAllowed = true;
    if (kind === 'hash') body.reviewHash = 'b'.repeat(64);
    if (kind === 'revision')
      body.expectedUpdatedAt = '2026-10-24T00:00:00.000Z';
    if (kind === 'no-op')
      body.values = {
        tokenName: f.doc.plan.tokenName,
        ticker: f.doc.plan.ticker,
        description: f.doc.plan.description,
      };
    await expect(
      saveMetadataEdit(f.db, 'bob', body, signal()),
    ).rejects.toThrow();
    expect(
      f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n,
    ).toBe(0);
  },
);
it('makes audit receipts immutable and prevents insert-or-replace collisions', async () => {
  const f = fixture();
  await saveMetadataEdit(f.db, 'bob', await request(f.db), signal());
  for (const sql of [
    'DELETE FROM project_collaboration_metadata_edits',
    "UPDATE project_collaboration_metadata_edits SET editor_id='mallory'",
    'INSERT OR REPLACE INTO project_collaboration_metadata_edits SELECT * FROM project_collaboration_metadata_edits',
  ])
    expect(() => f.sql.exec(sql)).toThrow();
});
it('independently rejects widened after JSON and a forged before snapshot in SQL', async () => {
  for (const kind of ['wide', 'before', 'revision']) {
    const f = fixture();
    const body = await request(f.db);
    f.race(() => {});
    const before = {
      tokenName: f.doc.plan.tokenName,
      ticker: f.doc.plan.ticker,
      description: f.doc.plan.description,
    };
    expect(() =>
      f.sql
        .prepare(
          `INSERT INTO project_collaboration_metadata_edits VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          mutationId,
          'alice',
          'bob',
          shareId,
          'shared-project',
          JSON.stringify(f.doc),
          revision,
          kind === 'revision' ? revision : '2026-10-25T12:00:00.001Z',
          JSON.stringify(
            kind === 'before' ? { ...before, ticker: 'FORGED' } : before,
          ),
          JSON.stringify(
            kind === 'wide' ? { ...values, holderCount: 200 } : values,
          ),
          body.reviewHash,
          '2026-10-25T12:00:00.000Z',
        ),
    ).toThrow();
    expect(
      f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n,
    ).toBe(0);
  }
});

it.each(['revision', 'archive', 'membership'] as const)(
  'checks folder-scoped selections at SQL insertion: %s',
  async (kind) => {
    const f = fixture(1, true);
    f.sql
      .prepare(
        `INSERT INTO wallet_folders(owner_id,id,name,chain,updated_at) VALUES('alice','selected-folder','Saved folder','Solana',?)`,
      )
      .run(revision);
    f.sql.exec(
      `UPDATE workspace_wallets SET folder_id='selected-folder',folder_ids='["selected-folder"]'`,
    );
    const doc = structuredClone(f.doc);
    Object.assign(doc.options, {
      wallets: {
        chain: 'Solana',
        recipients: [
          {
            address: '11111111111111111111111111111111',
            revision: 1,
            folderId: 'selected-folder',
            folderRevision: 1,
          },
        ],
      },
    });
    f.sql
      .prepare('UPDATE workspace_projects SET document=?')
      .run(JSON.stringify(doc));
    const body = await request(f.db);
    f.race(() => {
      if (kind === 'revision')
        f.sql.exec('UPDATE wallet_folders SET revision=2');
      if (kind === 'archive')
        f.sql.exec('UPDATE wallet_folders SET archived=1');
      if (kind === 'membership')
        f.sql.exec("UPDATE workspace_wallets SET folder_ids='[]'");
    });
    await expect(
      saveMetadataEdit(f.db, 'bob', body, signal()),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n,
    ).toBe(0);
  },
);
it('requires the captured Deployer role and revision as well as Recipient references', async () => {
  const f = fixture(1, true);
  const doc = structuredClone(f.doc);
  Object.assign(doc.options, {
    wallets: {
      chain: 'Solana',
      deployer: {
        address: '11111111111111111111111111111111',
        revision: 1,
        folderRevision: 0,
        root: true,
      },
      recipients: [],
    },
  });
  f.sql
    .prepare('UPDATE workspace_projects SET document=?')
    .run(JSON.stringify(doc));
  f.sql.exec("UPDATE workspace_wallets SET role='Deployer'");
  const body = await request(f.db);
  f.race(() => f.sql.exec("UPDATE workspace_wallets SET role='Recipient'"));
  await expect(
    saveMetadataEdit(f.db, 'bob', body, signal()),
  ).rejects.toMatchObject({ status: 409 });
});
it('rejects captured venue limits using the unchanged owner plan validators', async () => {
  const f = fixture();
  const body = await request(f.db);
  const source = await getMetadataEditSource(f.db, 'bob', shareId);
  const tooLong = { ...values, tokenName: 'a'.repeat(64) };
  await expect(
    saveMetadataEdit(
      f.db,
      'bob',
      {
        ...body,
        values: tooLong,
        reviewHash: await metadataEditReviewHash(source, tooLong),
      },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n).toBe(
    0,
  );
});
it('never retries a write after a cancelled request or an unknown receipt', async () => {
  const f = fixture();
  const body = await request(f.db);
  const controller = new AbortController();
  controller.abort();
  await expect(
    saveMetadataEdit(f.db, 'bob', body, controller.signal),
  ).rejects.toThrow();
  expect(await readMetadataEditReceipt(f.db, 'bob', mutationId)).toBeNull();
  expect(f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n).toBe(
    0,
  );
});
it('new invites and preexisting invites have default-off permission with no automatic upgrade', () => {
  const f = fixture();
  f.sql
    .prepare(
      `INSERT INTO project_shares(id,owner_id,project_id,token_hash,member_id,created_at,accepted_at,expires_at,wallet_scope) VALUES(?,'alice','shared-project',?,'new-member',?,?,?,?)`,
    )
    .run(
      '22345678-1234-4234-8234-123456789abc',
      'c'.repeat(64),
      '2026-10-25T12:00:00.000Z',
      '2026-10-25T12:00:00.000Z',
      '2026-10-26T12:00:00.000Z',
      JSON.stringify({
        format: 'project-share-wallet-scope-v1',
        projectRevision: revision,
        wallets: [],
      }),
    );
  expect(
    f.sql
      .prepare(
        "SELECT metadata_edit FROM project_shares WHERE member_id='new-member'",
      )
      .get()!.metadata_edit,
  ).toBe(0);
});
it('bounds immutable edit history at1000 rows per owner/project with no eviction', () => {
  const f = fixture();
  const insert = f.sql.prepare(
    'INSERT INTO project_collaboration_metadata_edits VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (let i = 0; i < 1000; i++) {
    const current = f.sql
      .prepare('SELECT document,updated_at FROM workspace_projects')
      .get()!;
    const doc = JSON.parse(current.document as string);
    const before = {
      tokenName: doc.plan.tokenName,
      ticker: doc.plan.ticker,
      description: doc.plan.description,
    };
    insert.run(
      `87654321-1234-4234-8234-${i.toString(16).padStart(12, '0')}`,
      'alice',
      'bob',
      shareId,
      'shared-project',
      current.document,
      current.updated_at,
      new Date(Date.parse('2026-10-25T12:00:00.000Z') + i + 1).toISOString(),
      JSON.stringify(before),
      JSON.stringify({
        ...before,
        tokenName: i % 2 ? 'Second name' : 'First name',
      }),
      'f'.repeat(64),
      '2026-10-25T12:00:00.000Z',
    );
  }
  const current = f.sql
    .prepare('SELECT document,updated_at FROM workspace_projects')
    .get()!;
  const doc = JSON.parse(current.document as string);
  const before = {
    tokenName: doc.plan.tokenName,
    ticker: doc.plan.ticker,
    description: doc.plan.description,
  };
  expect(() =>
    insert.run(
      '87654321-1234-4234-8234-ffffffffffff',
      'alice',
      'bob',
      shareId,
      'shared-project',
      current.document,
      current.updated_at,
      '2026-10-25T12:01:00.000Z',
      JSON.stringify(before),
      JSON.stringify({ ...before, tokenName: 'Capacity refusal' }),
      'f'.repeat(64),
      '2026-10-25T12:00:00.000Z',
    ),
  ).toThrow('capacity');
  expect(
    f.sql
      .prepare('SELECT count(*) n FROM project_collaboration_metadata_edits')
      .get()!.n,
  ).toBe(1000);
  expect(f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n).toBe(
    1000,
  );
});
it('recovers a committed insert whose response is lost without issuing another insert', async () => {
  const f = fixture();
  const body = await request(f.db);
  let writes = 0;
  const db = {
    prepare(sql: string) {
      const statement = f.db.prepare(sql);
      if (!sql.includes('INSERT INTO project_collaboration_metadata_edits'))
        return statement;
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          return {
            async run() {
              writes++;
              await bound.run();
              throw Error('lost response');
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const receipt = await saveMetadataEdit(db, 'bob', body, signal());
  expect(receipt.metadataSaved).toBe(true);
  expect(writes).toBe(1);
  expect(await saveMetadataEdit(db, 'bob', body, signal())).toEqual(receipt);
  expect(writes).toBe(1);
  expect(f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n).toBe(
    1,
  );
});
it('preserves a real legacy share row through the0151 migration without granting edit authority', () => {
  const sql = new DatabaseSync(':memory:');
  resources.push(sql);
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries.filter((e) => !e.tag.startsWith('0151_')))
    sql.exec(readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'));
  const now = new Date().toISOString(),
    expiry = new Date(Date.parse(now) + 86400000).toISOString();
  sql
    .prepare(
      'INSERT INTO workspace_projects(owner_id,id,document,updated_at) VALUES(?,?,?,?)',
    )
    .run(
      'alice',
      'legacy-project',
      JSON.stringify({
        plan: DEFAULT_LAUNCH_PLAN,
        identity: EMPTY_IDENTITY,
        options: DEFAULT_VENUE_OPTIONS,
      }),
      now,
    );
  sql
    .prepare(
      `INSERT INTO project_shares(id,owner_id,project_id,token_hash,member_id,created_at,accepted_at,expires_at,wallet_scope) VALUES(?,'alice','legacy-project',?,'bob',?,?,?,?)`,
    )
    .run(
      shareId,
      'e'.repeat(64),
      now,
      now,
      expiry,
      JSON.stringify({
        format: 'project-share-wallet-scope-v1',
        projectRevision: now,
        wallets: [],
      }),
    );
  const original = sql.prepare('SELECT * FROM project_shares').get()!;
  sql.exec(
    readFileSync('drizzle/0151_project_collaboration_metadata.sql', 'utf8'),
  );
  expect(sql.prepare('SELECT * FROM project_shares').get()).toEqual({
    ...original,
    metadata_edit: 0,
  });
});
it.each(['tokenName', 'ticker', 'description'] as const)(
  'refuses noncanonical raw source %s before normalizing it',
  async (field) => {
    const f = fixture();
    const doc = structuredClone(f.doc);
    doc.plan[field] =
      field === 'ticker'
        ? ' token '
        : field === 'description'
          ? ' padded description '
          : ' padded name ';
    f.sql
      .prepare('UPDATE workspace_projects SET document=?')
      .run(JSON.stringify(doc));
    await expect(getMetadataEditSource(f.db, 'bob', shareId)).rejects.toThrow(
      'canonical project name, symbol and description',
    );
    expect(
      f.sql.prepare('SELECT document FROM workspace_projects').get()!.document,
    ).toBe(JSON.stringify(doc));
  },
);
function paddedDocument(
  f: ReturnType<typeof fixture>,
  after: typeof values,
  target: number,
  suffix = '',
) {
  const raw = { ...f.doc, preservedExtra: '' };
  const envelope = {
    ...raw,
    plan: { ...raw.plan, ...after },
    id: 'shared-project',
    archived: false,
    expectedUpdatedAt: revision,
    mutationId,
  };
  raw.preservedExtra =
    'x'.repeat(target - JSON.stringify(envelope).length - suffix.length) +
    suffix;
  f.sql
    .prepare('UPDATE workspace_projects SET document=?')
    .run(JSON.stringify(raw));
  return raw;
}
it.each([24000, 24001])(
  'matches the complete owner save UTF16 budget at%s units',
  async (limit) => {
    const f = fixture();
    const raw = paddedDocument(f, values, limit, '😀');
    const body = await request(f.db);
    if (limit === 24000) {
      expect(await saveMetadataEdit(f.db, 'bob', body, signal())).toMatchObject(
        { metadataSaved: true },
      );
      const saved = JSON.parse(
        f.sql.prepare('SELECT document FROM workspace_projects').get()!
          .document as string,
      );
      expect(saved.preservedExtra).toBe(raw.preservedExtra);
    } else {
      await expect(
        saveMetadataEdit(f.db, 'bob', body, signal()),
      ).rejects.toThrow('24,000');
      expect(
        f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n,
      ).toBe(0);
    }
  },
);
function directEdit(f: ReturnType<typeof fixture>, after: typeof values) {
  const row = f.sql.prepare('SELECT document FROM workspace_projects').get()!;
  const doc = JSON.parse(row.document as string);
  const before = {
    tokenName: doc.plan.tokenName,
    ticker: doc.plan.ticker,
    description: doc.plan.description,
  };
  return () =>
    f.sql
      .prepare(
        'INSERT INTO project_collaboration_metadata_edits VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        mutationId,
        'alice',
        'bob',
        shareId,
        'shared-project',
        row.document,
        revision,
        '2026-10-25T12:00:00.001Z',
        JSON.stringify(before),
        JSON.stringify(after),
        'f'.repeat(64),
        '2026-10-25T12:00:00.000Z',
      );
}
it.each([24000, 24001])(
  'independently enforces the owner envelope budget in SQL at%s UTF16 units',
  (limit) => {
    const f = fixture();
    paddedDocument(f, values, limit, '😀');
    const insert = directEdit(f, values);
    if (limit === 24000) expect(insert).not.toThrow();
    else expect(insert).toThrow('owner document limit');
  },
);
it('counts an emoji name as two units and preserves a280-unit supplementary description', async () => {
  const f = fixture();
  const source = await getMetadataEditSource(f.db, 'bob', shareId);
  const after = {
    tokenName: '😀',
    ticker: 'NEW',
    description: '😀'.repeat(140),
  };
  const body = {
    ...(await request(f.db)),
    values: after,
    reviewHash: await metadataEditReviewHash(source, after),
  };
  expect(await saveMetadataEdit(f.db, 'bob', body, signal())).toMatchObject({
    after,
  });
});
it.each([
  { tokenName: '😀'.repeat(32), description: '😀'.repeat(140), allowed: true },
  { tokenName: '😀'.repeat(33), description: '', allowed: false },
  { tokenName: 'Valid name', description: '😀'.repeat(141), allowed: false },
])(
  'uses UTF16 rather than codepoints in SQL text validation %#',
  ({ tokenName, description, allowed }) => {
    const f = fixture();
    const insert = directEdit(f, { tokenName, ticker: 'NEW', description });
    if (allowed) expect(insert).not.toThrow();
    else expect(insert).toThrow('UTF16');
  },
);
it.each(['tokenName', 'description'] as const)(
  'rejects directly inserted lone surrogate escapes in%s before serializing project JSON',
  (field) => {
    for (const code of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
      const f = fixture();
      const original = f.sql
        .prepare('SELECT document FROM workspace_projects')
        .get()!.document;
      const after = {
        ...values,
        [field]: 'Valid ' + String.fromCharCode(code),
      };
      expect(() => directEdit(f, after)()).toThrow('UTF16');
      expect(
        f.sql.prepare('SELECT document FROM workspace_projects').get()!
          .document,
      ).toBe(original);
      expect(
        f.sql.prepare('SELECT count(*) n FROM project_events').get()!.n,
      ).toBe(0);
      expect(
        f.sql
          .prepare(
            'SELECT count(*) n FROM project_collaboration_metadata_edits',
          )
          .get()!.n,
      ).toBe(0);
    }
  },
);
it('reports a foreign mutation-ID collision as a conflict rather than full history', async () => {
  const f = fixture();
  await saveMetadataEdit(f.db, 'bob', await request(f.db), signal());
  const current = f.sql
    .prepare('SELECT updated_at FROM workspace_projects')
    .get()!.updated_at as string;
  const second = '22345678-1234-4234-8234-123456789abc';
  f.sql
    .prepare(
      `INSERT INTO project_shares(id,owner_id,project_id,token_hash,member_id,created_at,accepted_at,expires_at,wallet_scope,metadata_edit) VALUES(?,'alice','shared-project',?,'carol',?,?,?, ?,1)`,
    )
    .run(
      second,
      'c'.repeat(64),
      '2026-10-25T12:00:00.000Z',
      '2026-10-25T12:00:00.000Z',
      '2026-10-26T12:00:00.000Z',
      JSON.stringify({
        format: 'project-share-wallet-scope-v1',
        projectRevision: current,
        wallets: [],
      }),
    );
  const source = await getMetadataEditSource(f.db, 'carol', second),
    after = { ...values, tokenName: 'Another name' };
  const body = {
    mutationId,
    shareId: second,
    projectId: 'shared-project',
    expectedUpdatedAt: current,
    values: after,
    reviewHash: await metadataEditReviewHash(source, after),
    approved: true,
  };
  await expect(
    saveMetadataEdit(f.db, 'carol', body, signal()),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    saveMetadataEdit(f.db, 'carol', body, signal()),
  ).rejects.not.toThrow(/full|capacity/i);
  expect(
    f.sql
      .prepare('SELECT count(*) n FROM project_collaboration_metadata_edits')
      .get()!.n,
  ).toBe(1);
});
it.each(['literal', 'paired'] as const)(
  'preserves valid%s JSON escape sequences in direct SQL',
  (kind) => {
    const f = fixture();
    const after = {
      ...values,
      description:
        kind === 'literal' ? 'Literal \\ud800 and \\udc00 text' : 'Emoji 😀',
    };
    expect(() => directEdit(f, after)()).not.toThrow();
    const saved = JSON.parse(
      f.sql.prepare('SELECT document FROM workspace_projects').get()!
        .document as string,
    );
    expect(saved.plan.description).toBe(after.description);
  },
);
it('refuses alternate surrogate escape spellings before project serialization', () => {
  const f = fixture();
  const before = {
    tokenName: f.doc.plan.tokenName,
    ticker: f.doc.plan.ticker,
    description: f.doc.plan.description,
  };
  const insert = f.sql.prepare(
    'INSERT INTO project_collaboration_metadata_edits VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const perform = (raw: string) =>
    insert.run(
      mutationId,
      'alice',
      'bob',
      shareId,
      'shared-project',
      JSON.stringify(f.doc),
      revision,
      '2026-10-25T12:00:00.001Z',
      JSON.stringify(before),
      raw,
      'f'.repeat(64),
      '2026-10-25T12:00:00.000Z',
    );
  expect(() =>
    perform(
      '{"tokenName":"Valid","ticker":"NEW","description":"\\\\ud800\\udc00"}',
    ),
  ).toThrow('canonical');
  expect(() =>
    perform(
      '{"tokenName":"Valid","ticker":"NEW","description":"\\ud83d\\ude00"}',
    ),
  ).toThrow('canonical');
  const saved = JSON.parse(
    f.sql.prepare('SELECT document FROM workspace_projects').get()!
      .document as string,
  );
  expect(saved).toEqual(f.doc);
});
it.each([
  'Quote " and slash / and backslash \\',
  'Embedded\nnewline\tand tab',
  'Controls \b\f\r end',
  'Unicode é 中 😀',
])('preserves canonical ordinary text spelling: %j', (description) => {
  const f = fixture();
  const after = { ...values, description };
  expect(() => directEdit(f, after)()).not.toThrow();
  const saved = JSON.parse(
    f.sql.prepare('SELECT document FROM workspace_projects').get()!
      .document as string,
  );
  expect(saved.plan.description).toBe(description);
});
