import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { createTursoDatabase } from '../db/turso';
import { launchLayerFixture } from '../test/launch-layer-fixture';
import { quoteCatalog } from './quote-catalog';
import {
  readLaunchLayerContext,
  listOwnedLaunchLayerPlans,
  readOwnedLaunchLayerPlan,
  saveOwnedLaunchLayerPlan,
} from './launch-layer-service';
let client: Client, db: D1Database, f: ReturnType<typeof launchLayerFixture>;
const save = () => saveOwnedLaunchLayerPlan(db, 'alice', f.input, f.now);
it('retains original artwork and fee choices after the current project changes', async () => {
  f.document.identity.artworkUrl = '/api/artwork/' + '1'.repeat(64);
  f.document.options.settings.pumpfun.feeSharing = true;
  f.document.options.settings.pumpfun.feeShares = [
    { address: f.address(1), shareBps: 10000 },
  ];
  await db
    .prepare(
      'UPDATE workspace_projects SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(JSON.stringify(f.document), 'alice', f.selection.projectId)
    .run();
  const original = await save();
  expect(original.setup.identity.artworkUrl).toBe(
    f.document.identity.artworkUrl,
  );
  expect(original.setup.snapshotSha256).toBe(original.sha256);
  f.document.identity.artworkUrl = '/api/artwork/' + '2'.repeat(64);
  f.document.options.settings.pumpfun.feeSharing = false;
  f.document.options.settings.pumpfun.feeShares = [];
  await db
    .prepare(
      'UPDATE workspace_projects SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(JSON.stringify(f.document), 'alice', f.selection.projectId)
    .run();
  const historical = await readOwnedLaunchLayerPlan(
    db,
    'alice',
    f.selection.projectId,
    original.id,
  );
  expect(historical!.current).toBe(false);
  expect(historical!.setup).toEqual(original.setup);
  await expect(
    readOwnedLaunchLayerPlan(db, 'bob', f.selection.projectId, original.id),
  ).rejects.toMatchObject({ status: 404 });
});
it('lists all owned snapshot metadata in stable order, including archived source history', async () => {
  expect(
    (await listOwnedLaunchLayerPlans(db, 'alice', f.selection.projectId)).items,
  ).toEqual([]);
  const first = await save();
  f.layers.delays.fundingDelaySeconds++;
  const second = await save();
  await db
    .prepare(
      'UPDATE workspace_projects SET archived=1 WHERE owner_id=? AND id=?',
    )
    .bind('alice', f.selection.projectId)
    .run();
  const history = await listOwnedLaunchLayerPlans(
    db,
    'alice',
    f.selection.projectId,
  );
  expect(history).toMatchObject({
    complete: true,
    planningOnly: true,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(history.items.map((item) => item.id)).toEqual(
    [first.id, second.id].sort().reverse(),
  );
  expect(
    history.items.every((item) => item.target.mint === f.selection.target.mint),
  ).toBe(true);
  expect(
    history.items.every(
      (item) => !('envelope' in item) && !('sourceDocument' in item),
    ),
  ).toBe(true);
  expect(
    (
      await readOwnedLaunchLayerPlan(
        db,
        'alice',
        f.selection.projectId,
        first.id,
      )
    )?.current,
  ).toBe(false);
  await expect(
    listOwnedLaunchLayerPlans(db, 'bob', f.selection.projectId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    listOwnedLaunchLayerPlans(db, 'alice', 'missing-project'),
  ).rejects.toMatchObject({ status: 404 });
});
it('expands every ordered role without dropping a missing funder', async () => {
  const migration = await readFile(
    'drizzle/0109_launch_layer_plans.sql',
    'utf8',
  );
  const start = migration.indexOf('WITH refs(');
  const end = migration.indexOf('SELECT length(NEW.id)', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const query =
    'WITH input(document) AS (SELECT ?),' +
    migration
      .slice(start + 5, end)
      .replaceAll('NEW.document', '(SELECT document FROM input)') +
    'SELECT role,pos,member FROM refs ORDER BY role,pos';
  const member = (address: string) => ({ address, revision: 1 });
  const cases = [
    {
      funder: member('funder'),
      developer: member('developer'),
      front: [member('front1'), member('front2')],
      back: [member('back')],
      temporary: [member('temporary')],
      holders: [member('holder1'), member('holder2')],
    },
    {
      funder: member('funder'),
      front: [member('front')],
      back: [],
      temporary: [],
      holders: [member('holder')],
    },
    { front: [], back: [], temporary: [], holders: [] },
  ];
  for (const roles of cases) {
    const expected: [string, number, string | null][] = [];
    for (const role of [
      'funder',
      'developer',
      'front',
      'back',
      'temporary',
      'holders',
    ]) {
      const value = (roles as Record<string, unknown>)[role];
      if (role === 'developer' && !value) continue;
      const members = ['funder', 'developer'].includes(role) ? [value] : value;
      (members as unknown[]).forEach((entry, pos) =>
        expected.push([role, pos, entry ? JSON.stringify(entry) : null]),
      );
    }
    expected.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
    const result = await client.execute({
      sql: query,
      args: [JSON.stringify({ envelope: { terms: { roles } } })],
    });
    expect(result.rows.map((row) => [row.role, row.pos, row.member])).toEqual(
      expected,
    );
  }
});
async function updateSource() {
  await db
    .prepare(
      'UPDATE workspace_projects SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(JSON.stringify(f.document), 'alice', f.selection.projectId)
    .run();
}
beforeEach(async () => {
  f = launchLayerFixture();
  client = createClient({ url: ':memory:' });
  db = createTursoDatabase(client);
  await client.executeMultiple(`CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER,PRIMARY KEY(owner_id,id));
  CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,folder_id TEXT,folder_ids TEXT,label TEXT,role TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,PRIMARY KEY(owner_id,chain,address));
  CREATE TABLE wallet_folders(owner_id TEXT,id TEXT,chain TEXT,name TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,PRIMARY KEY(owner_id,id));
  CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,chain TEXT,address TEXT,document TEXT,revision INTEGER,archived INTEGER,PRIMARY KEY(owner_id,id));`);
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
  for (let n = 1; n <= 8; n++)
    await db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(
        'alice',
        'Solana',
        f.address(n),
        '',
        null,
        'Synthetic public wallet',
        'Recipient',
        2,
        0,
        f.updatedAt,
      )
      .run();
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
it('captures and reopens an exact owned plan idempotently with no funding or signing authority', async () => {
  const context = await readLaunchLayerContext(db, 'alice', f.selection);
  expect(context.workspace.wallets).toHaveLength(8);
  const plan = await save();
  expect(plan).toMatchObject({
    projectId: f.selection.projectId,
    current: true,
    planningOnly: true,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(plan.envelope.terms.totals.maximumNativeBudgetLamports).toBe(
    '14736400',
  );
  expect((await save()).id).toBe(plan.id);
  expect(
    await readOwnedLaunchLayerPlan(db, 'alice', f.selection.projectId),
  ).toEqual(plan);
  const row = await db
    .prepare('SELECT document FROM launch_layer_plans')
    .first<{ document: string }>();
  const snap = JSON.parse(row!.document);
  expect(snap.context.workspace.wallets).toHaveLength(7);
  expect(
    snap.context.workspace.wallets.every(
      (w: { label: string }) => w.label === '',
    ),
  ).toBe(true);
});
it('keeps selected-role ordering and exact saved developer/holder selection', async () => {
  f.layers.roles.holders.reverse();
  await expect(save()).rejects.toMatchObject({ status: 409 });
  f.layers.roles.holders.reverse();
  const dev = f.layers.roles.developer!.wallet;
  f.layers.roles.developer!.wallet = f.layers.roles.front[0].wallet;
  f.layers.roles.front[0].wallet = dev;
  await expect(save()).rejects.toMatchObject({ status: 409 });
  expect(
    await db.prepare('SELECT * FROM launch_layer_plans').first(),
  ).toBeNull();
});
it('does not accept caller ownership/workspace overrides or a foreign project', async () => {
  await expect(
    saveOwnedLaunchLayerPlan(db, 'bob', f.input, f.now),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    saveOwnedLaunchLayerPlan(
      db,
      'alice',
      { ...f.input, ownerId: 'bob' },
      f.now,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    saveOwnedLaunchLayerPlan(db, 'alice', { ...f.input, workspace: {} }, f.now),
  ).rejects.toMatchObject({ status: 400 });
  f.layers.roles.front[0].wallet.address = f.address(88);
  await expect(save()).rejects.toMatchObject({ status: 409 });
});
it.each([
  'project revision',
  'project archive',
  'selected wallet revision',
  'selected wallet archive',
])(
  'retains historical data but marks it non-current after %s changes',
  async (kind) => {
    const saved = await save();
    if (kind === 'project revision')
      await db
        .prepare(
          "UPDATE workspace_projects SET updated_at='2026-10-18T04:00:00.000Z'",
        )
        .run();
    if (kind === 'project archive')
      await db.prepare('UPDATE workspace_projects SET archived=1').run();
    if (kind === 'selected wallet revision')
      await db
        .prepare(
          'UPDATE workspace_wallets SET revision=revision+1 WHERE address=?',
        )
        .bind(f.address(3))
        .run();
    if (kind === 'selected wallet archive')
      await db
        .prepare('UPDATE workspace_wallets SET archived=1 WHERE address=?')
        .bind(f.address(3))
        .run();
    const reopened = await readOwnedLaunchLayerPlan(
      db,
      'alice',
      f.selection.projectId,
      saved.id,
    );
    expect(reopened).toEqual({ ...saved, current: false });
    await expect(save()).rejects.toMatchObject({ status: 409 });
  },
);
it('does not invalidate selected layers for an unrelated wallet revision change', async () => {
  const saved = await save();
  await db
    .prepare('UPDATE workspace_wallets SET revision=revision+1 WHERE address=?')
    .bind(f.address(8))
    .run();
  expect(
    await readOwnedLaunchLayerPlan(db, 'alice', f.selection.projectId),
  ).toEqual(saved);
  expect((await save()).id).toBe(saved.id);
});
it('binds explicit folder revisions independently from wallet revisions', async () => {
  await db
    .prepare('INSERT INTO wallet_folders VALUES(?,?,?,?,?,?,?)')
    .bind('alice', 'buyers', 'Solana', 'Buyers', 4, 0, f.updatedAt)
    .run();
  await db
    .prepare(
      'UPDATE workspace_wallets SET folder_id=?,folder_ids=? WHERE address=?',
    )
    .bind('buyers', '["buyers"]', f.address(3))
    .run();
  f.layers.roles.front[0].wallet = {
    address: f.address(3),
    revision: 2,
    folderRevision: 4,
    folderId: 'buyers',
  };
  const saved = await save();
  await db.prepare('UPDATE wallet_folders SET revision=5').run();
  expect(
    (
      await readOwnedLaunchLayerPlan(
        db,
        'alice',
        f.selection.projectId,
        saved.id,
      )
    )?.current,
  ).toBe(false);
  await expect(save()).rejects.toMatchObject({ status: 409 });
});
it('accepts legacy unfoldered references while retaining exact current roster ownership', async () => {
  for (const m of [
    f.layers.roles.funder,
    ...f.layers.roles.front,
    ...f.layers.roles.back,
    ...f.layers.roles.temporary,
  ])
    delete m.wallet.root;
  expect((await save()).current).toBe(true);
});
async function importedInput() {
  f.document.plan.scheduled = true;
  await updateSource();
  const document = JSON.stringify({
    format: 'imported-token-project-v1',
    executionAllowed: false,
    token: {
      chain: 'Solana',
      address: f.address(90),
      name: 'Synthetic import',
    },
  });
  await db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?,?)')
    .bind('alice', 'imported-target', 'Solana', f.address(90), document, 3, 0)
    .run();
  const layers = structuredClone(f.layers);
  delete layers.roles.developer;
  return {
    ...f.input,
    target: {
      kind: 'imported' as const,
      projectId: 'imported-target',
      revision: 3,
    },
    layers,
  };
}
it('binds an owned scheduled imported target and preserves it after its current revision changes', async () => {
  const input = await importedInput(),
    saved = await saveOwnedLaunchLayerPlan(db, 'alice', input, f.now);
  expect(saved.envelope.terms.binding.target).toEqual({
    kind: 'imported',
    mint: f.address(90),
  });
  expect(saved.envelope.terms.roles.developer).toBeUndefined();
  await db.prepare('UPDATE imported_token_projects SET revision=4').run();
  expect(
    (
      await readOwnedLaunchLayerPlan(
        db,
        'alice',
        f.selection.projectId,
        saved.id,
      )
    )?.current,
  ).toBe(false);
  await expect(
    saveOwnedLaunchLayerPlan(db, 'alice', input, f.now),
  ).rejects.toMatchObject({ status: 409 });
});
it('refuses foreign, unscheduled or caller-invented imported targets', async () => {
  const input = await importedInput();
  await expect(
    saveOwnedLaunchLayerPlan(
      db,
      'alice',
      { ...input, target: { ...input.target, projectId: 'foreign' } },
      f.now,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    saveOwnedLaunchLayerPlan(
      db,
      'alice',
      { ...input, target: { ...input.target, mint: f.address(90) } },
      f.now,
    ),
  ).rejects.toMatchObject({ status: 400 });
  f.document.plan.scheduled = false;
  await updateSource();
  await expect(
    saveOwnedLaunchLayerPlan(db, 'alice', input, f.now),
  ).rejects.toMatchObject({ status: 409 });
});
it('atomically refuses a project revision changed during hashing', async () => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
    async (algorithm, data) => {
      await db
        .prepare(
          "UPDATE workspace_projects SET updated_at='2026-10-18T04:00:00.000Z'",
        )
        .run();
      return digest(algorithm, data);
    },
  );
  await expect(save()).rejects.toMatchObject({ status: 409 });
  expect(
    await db.prepare('SELECT * FROM launch_layer_plans').first(),
  ).toBeNull();
});
it('keeps immutable snapshots and does not disclose another owner history', async () => {
  const saved = await save();
  await expect(
    db.prepare('UPDATE launch_layer_plans SET document=document').run(),
  ).rejects.toThrow(/immutable/);
  await expect(
    db.prepare('DELETE FROM launch_layer_plans').run(),
  ).rejects.toThrow(/Retain/);
  await expect(
    readOwnedLaunchLayerPlan(db, 'bob', f.selection.projectId, saved.id),
  ).rejects.toMatchObject({ status: 404 });
});
it('database guards reject altered owner, source, flags, missing flags, time and current-wallet races', async () => {
  await save();
  const original = await db
    .prepare('SELECT * FROM launch_layer_plans')
    .first<Record<string, string>>();
  const insert = (row: Record<string, string>) =>
    db
      .prepare('INSERT INTO launch_layer_plans VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        ...[
          'id',
          'owner_id',
          'project_id',
          'project_revision',
          'source_document',
          'document',
          'sha256',
          'created_at',
        ].map((k) => row[k]),
      )
      .run();
  const replacements: Record<string, string>[] = [
    { owner_id: 'bob' },
    { project_revision: '2026-10-18T04:00:00.000Z' },
    { source_document: '{}' },
    { created_at: 'not-a-time' },
  ];
  for (const patch of replacements)
    await expect(
      insert({ ...original!, id: crypto.randomUUID(), ...patch }),
    ).rejects.toThrow();
  for (const key of ['fundingAllowed', 'signingAllowed', 'executionAllowed']) {
    const doc = JSON.parse(original!.document);
    doc.envelope.terms[key] = true;
    await expect(
      insert({
        ...original!,
        id: crypto.randomUUID(),
        document: JSON.stringify(doc),
      }),
    ).rejects.toThrow();
    delete doc.envelope.terms[key];
    await expect(
      insert({
        ...original!,
        id: crypto.randomUUID(),
        document: JSON.stringify(doc),
      }),
    ).rejects.toThrow();
  }
  await db
    .prepare('UPDATE workspace_wallets SET revision=3 WHERE address=?')
    .bind(f.address(3))
    .run();
  await expect(
    insert({ ...original!, id: crypto.randomUUID() }),
  ).rejects.toThrow(/current owned/);
});
it('stops before persistence when the caller cancelled', async () => {
  const c = new AbortController();
  c.abort();
  await expect(
    saveOwnedLaunchLayerPlan(db, 'alice', f.input, f.now, c.signal),
  ).rejects.toThrow();
  expect(
    await db.prepare('SELECT * FROM launch_layer_plans').first(),
  ).toBeNull();
});
it('keeps StonkFun Front-only stock quote ceilings separate from native SOL budgets', async () => {
  const stock = quoteCatalog('Solana', 'StonkFun').assets.find(
    (a) => a.symbol === 'TSLAX',
  )!;
  f.document.plan.launchpad = 'StonkFun';
  f.document.plan.currency = 'TSLAX';
  f.document.plan.quoteAddress = stock.address;
  f.layers.roles.back = [];
  f.layers.roles.temporary = [];
  f.layers.delays.frontToBackDelayMs = 0;
  f.layers.delays.backToTemporaryDelayMs = 0;
  f.layers.roles.front[0].maximumBuyQuoteRaw = '9007199254740993';
  await updateSource();
  const saved = await save();
  expect(saved.envelope.terms.quote).toMatchObject({
    kind: 'token',
    symbol: 'TSLAX',
    evidence: 'saved-catalog-units-only',
  });
  expect(saved.setup.pumpfun).toBeNull();
  expect(saved.envelope.terms.totals.maximumBuyQuoteRaw).toBe(
    '9007199254741093',
  );
  expect(saved.envelope.terms.totals.maximumNativeBudgetLamports).toBe(
    '10525000',
  );
  f.layers.roles.back = [structuredClone(f.layers.roles.front[0])];
  await expect(save()).rejects.toMatchObject({ status: 409 });
});
it('reports missing planning storage accurately without altering launch settings', async () => {
  await client.execute('DROP TABLE launch_layer_plans');
  await expect(save()).rejects.toMatchObject({
    status: 503,
    message:
      'Launch layer storage is unavailable. Complete the storage setup before saving.',
  });
  expect(
    (
      await db
        .prepare('SELECT document FROM workspace_projects')
        .first<{ document: string }>()
    )?.document,
  ).toBe(JSON.stringify(f.document));
});
it('bounds retained plans while allowing an exact idempotent replay at capacity', async () => {
  const first = await save();
  for (let i = 1; i < 100; i++) {
    f.layers.roles.front[0].maximumBuyQuoteRaw = String(1000 + i);
    await save();
  }
  f.layers.roles.front[0].maximumBuyQuoteRaw = '1100';
  await expect(save()).rejects.toMatchObject({
    status: 409,
    message:
      'This project already has 100 retained layer plans. Existing plans remain readable.',
  });
  f.layers.roles.front[0].maximumBuyQuoteRaw = '1000';
  expect((await save()).id).toBe(first.id);
  expect(
    (
      await db
        .prepare('SELECT count(*) AS n FROM launch_layer_plans')
        .first<{ n: number }>()
    )?.n,
  ).toBe(100);
});
