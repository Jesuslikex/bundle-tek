import { quoteCatalog } from '@/lib/quote-catalog';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import type { WorkspaceProject } from '@/lib/workspace-project';

const mocks = vi.hoisted(() => ({
  user: null as { userId: string; email: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  getD1: () => mocks.db,
  ensurePulseSchema: async () => mocks.db,
}));
import { GET, POST } from './route';
import { GET as legacyGet, POST as legacyPost } from '../launch/plans/route';
import { GET as projectHistory } from './events/route';

let mf: Miniflare;
const payload = (overrides = {}) => ({
  id: 'test-project',
  plan: DEFAULT_LAUNCH_PLAN,
  archived: false,
  expectedUpdatedAt: null,
  ...overrides,
});
const post = (body: unknown, headers = {}) =>
  POST(
    new Request('http://localhost/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const read = async (response: Response) =>
  (await response.json()) as {
    project: WorkspaceProject;
    projects: WorkspaceProject[];
  };

beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'workspace-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'workspace-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'workspace-test',
  )) as unknown as D1Database;
  for (const file of [
    '0002_absent_wasp.sql',
    '0003_conscious_edwin_jarvis.sql',
    '0014_fancy_vertigo.sql',
    '0016_short_hedge_knight.sql',
    '0017_loving_mesmero.sql',
    '0018_real_joshua_kane.sql',
    '0011_huge_donald_blake.sql',
    '0019_wallet_folder_memberships.sql',
    '0020_wallet_folder_colors.sql',
  ]) {
    for (const sql of readFileSync(
      new URL('../../../drizzle/' + file, import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await mocks.db.prepare(sql).run();
  }
  const migration = readFileSync(
    new URL(
      '../../../drizzle/0005_special_marten_broadcloak.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const statement of migration
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(statement).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0010_magical_ender_wiggin.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
}, 30000);
beforeEach(async () => {
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  await mocks.db.prepare('DELETE FROM workspace_projects').run();
  await mocks.db.prepare('DELETE FROM project_events').run();
  await mocks.db.prepare('DELETE FROM launch_plans').run();
  await mocks.db.prepare('DELETE FROM workspace_wallets').run();
  await mocks.db.prepare('DELETE FROM wallet_folders').run();
});
afterAll(async () => {
  await mf?.dispose();
});

describe('owner-scoped project API on actual local D1', () => {
  it('retains chosen linked metadata and its source across reload and archive, rejecting invalid provenance', async () => {
    const uri =
      'https://raw.githubusercontent.com/owner/repository/main/token.json';
    const identity = {
      artworkUrl: 'https://image.example/token.png',
      website: 'https://token.example/',
      twitter: 'https://x.com/token',
      telegram: '',
      clonedFrom: {
        chain: 'Solana',
        address: 'So11111111111111111111111111111111111111112',
      },
      clonedMetadata: {
        uri,
        sourceUrl: uri,
        sha256: 'a'.repeat(64),
        observedAt: '2026-10-10T12:00:00.000Z',
      },
    };
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: 'Metadata QA',
      ticker: 'META',
      description: 'Chosen description',
    };
    const created = await post(payload({ plan, identity }));
    expect(created.status).toBe(200);
    const saved = (await read(await GET())).projects[0];
    expect(saved.identity).toEqual(identity);
    expect(saved.plan.description).toBe(plan.description);
    const invalid = await post({
      ...saved,
      expectedUpdatedAt: saved.updatedAt,
      identity: {
        ...identity,
        clonedMetadata: {
          ...identity.clonedMetadata,
          sourceUrl: 'http://localhost/private',
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect((await read(await GET())).projects[0].identity).toEqual(identity);
    const archived = await post({
      ...saved,
      archived: true,
      expectedUpdatedAt: saved.updatedAt,
    });
    expect(archived.status).toBe(200);
    expect((await read(await GET())).projects[0]).toMatchObject({
      archived: true,
      identity,
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await read(await GET())).projects).toEqual([]);
  });
  it('persists 64-character pons identity and rejects newly invalid venue limits', async () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Robinhood',
      launchpad: 'pons.family',
      currency: 'ETH',
      tokenName: 'A'.repeat(64),
      ticker: 'B'.repeat(16),
    };
    expect((await post(payload({ plan }))).status).toBe(200);
    const saved = (await read(await GET())).projects[0];
    expect(saved.plan.tokenName).toHaveLength(64);
    expect(saved.plan.ticker).toHaveLength(16);
    const response = await post(
      payload({
        id: 'flap-invalid',
        plan: {
          ...DEFAULT_LAUNCH_PLAN,
          chain: 'BNB',
          launchpad: 'Flap',
          currency: 'BNB',
          tokenName: 'A'.repeat(25),
        },
      }),
    );
    expect(response.status).toBe(400);
    expect((await read(await GET())).projects).toHaveLength(1);
    expect(
      (
        await post(
          payload({
            id: 'pump-invalid',
            plan: {
              ...DEFAULT_LAUNCH_PLAN,
              tokenName: 'A'.repeat(30),
              ticker: 'B'.repeat(13),
            },
          }),
        )
      ).status,
    ).toBe(400);
  });
  it('keeps legacy out-of-profile drafts readable and archivable without silently shortening them', async () => {
    const initial = (await read(await post(payload()))).project;
    const document = {
      plan: {
        ...initial.plan,
        chain: 'BNB',
        launchpad: 'Flap',
        currency: 'BNB',
        tokenName: 'A'.repeat(32),
      },
      identity: initial.identity,
      options: initial.options,
    };
    await mocks.db
      .prepare('UPDATE workspace_projects SET document=? WHERE id=?')
      .bind(JSON.stringify(document), initial.id)
      .run();
    let saved = (await read(await GET())).projects[0];
    expect(saved.plan.tokenName).toHaveLength(32);
    const archived = await post({
      ...saved,
      archived: true,
      expectedUpdatedAt: saved.updatedAt,
    });
    expect(archived.status).toBe(200);
    saved = (await read(archived)).project;
    expect(saved.plan.tokenName).toHaveLength(32);
    expect(
      (
        await post({
          ...saved,
          plan: { ...saved.plan, holderCount: 11 },
          expectedUpdatedAt: saved.updatedAt,
        })
      ).status,
    ).toBe(400);
    const corrected = await post({
      ...saved,
      plan: { ...saved.plan, tokenName: 'Corrected name' },
      expectedUpdatedAt: saved.updatedAt,
    });
    expect(corrected.status).toBe(200);
    expect((await read(corrected)).project.plan.tokenName).toBe(
      'Corrected name',
    );
  });
  it('records immutable creation, edit, archive and restore events and lists only the current owner', async () => {
    const history = async (cursor = '') =>
      (await (
        await projectHistory(
          new Request('http://localhost/api/projects/events' + cursor),
        )
      ).json()) as {
        events: Array<{
          id: number;
          type: string;
          changes: string[];
          name: string;
        }>;
        nextCursor: string | null;
      };
    let saved = (await read(await post(payload()))).project;
    saved = (
      await read(
        await post(
          payload({
            ...saved,
            plan: { ...saved.plan, tokenName: 'Updated project' },
            expectedUpdatedAt: saved.updatedAt,
          }),
        ),
      )
    ).project;
    for (const archived of [true, false])
      saved = (
        await read(
          await post(
            payload({ ...saved, archived, expectedUpdatedAt: saved.updatedAt }),
          ),
        )
      ).project;
    const events = (await history()).events;
    expect(events.map((e) => e.type)).toEqual([
      'project.restored',
      'project.archived',
      'project.saved',
      'project.created',
    ]);
    expect(events[2].changes).toEqual(['name']);
    expect(events[3].name).toBe(DEFAULT_LAUNCH_PLAN.tokenName);
    expect((await history(`?cursor=${events[1].id}`)).events).toHaveLength(2);
    expect(
      (
        await projectHistory(
          new Request('http://localhost/api/projects/events?cursor=no'),
        )
      ).status,
    ).toBe(400);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await history()).events).toEqual([]);
    mocks.user = null;
    expect(
      (
        await projectHistory(
          new Request('http://localhost/api/projects/events'),
        )
      ).status,
    ).toBe(401);
    mocks.user = { userId: 'alice', email: 'alice@example.test' };
    await mocks.db
      .prepare(`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<52)
      INSERT INTO project_events(owner_id,project_id,name,chain,launchpad,type,changes,revision,created_at)
      SELECT 'alice','test-project','Pagination','Solana','PumpFun','project.saved','[]','2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z' FROM entries`)
      .run();
    const first = await history();
    expect(first.events).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await history(`?cursor=${first.nextCursor}`);
    expect(second.events).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.events, ...second.events].map((e) => e.id)).size,
    ).toBe(56);
  });
  it('rolls back saves when event insertion fails and never emits an event for a frozen-time revision conflict', async () => {
    const saved = (await read(await post(payload()))).project;
    await mocks.db
      .prepare(
        "CREATE TRIGGER fail_project_event BEFORE INSERT ON project_events BEGIN SELECT RAISE(ABORT,'test failure'); END",
      )
      .run();
    try {
      expect(
        (
          await post(
            payload({
              ...saved,
              plan: { ...saved.plan, tokenName: 'Rejected change' },
              expectedUpdatedAt: saved.updatedAt,
            }),
          )
        ).status,
      ).toBe(503);
      expect((await read(await GET())).projects[0].plan.tokenName).toBe(
        saved.plan.tokenName,
      );
    } finally {
      await mocks.db.prepare('DROP TRIGGER fail_project_event').run();
    }
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(saved.updatedAt));
    try {
      const body = payload({ ...saved, expectedUpdatedAt: saved.updatedAt });
      const responses = await Promise.all([post(body), post(body)]);
      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect(
        (
          await mocks.db
            .prepare('SELECT COUNT(*) AS n FROM project_events')
            .first<{ n: number }>()
        )?.n,
      ).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('persists venue configuration and rejects conflicting options without changing the draft', async () => {
    const settings = {
      pumpfun: {
        holderRewards: false,
        offchainCreation: false,
        feeSharing: true,
        feeShares: [
          {
            address: 'So11111111111111111111111111111111111111112',
            shareBps: 10000,
          },
        ],
      },
      flap: { buyTaxPercent: 1, sellTaxPercent: 1 },
    };
    const response = await post(payload({ options: { settings } }));
    expect(response.status).toBe(200);
    const saved = (await read(response)).project;
    expect((await read(await GET())).projects[0].options.settings).toEqual(
      settings,
    );
    const invalid = await post({
      ...saved,
      expectedUpdatedAt: saved.updatedAt,
      options: {
        ...saved.options,
        settings: {
          ...settings,
          pumpfun: { ...settings.pumpfun, holderRewards: true },
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      saved.updatedAt,
    );
  });
  it('requires authentication and returns uncached responses', async () => {
    mocks.user = null;
    expect((await GET()).status).toBe(401);
    const response = await post(payload());
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('creates, lists, updates, archives and restores a complete document', async () => {
    const created = await post(
      payload({ identity: { website: 'https://example.com' } }),
    );
    expect(created.status).toBe(200);
    let { project } = await read(created);
    expect(project.identity.website).toBe('https://example.com');
    expect((await read(await GET())).projects).toHaveLength(1);
    for (const archived of [true, false]) {
      const response = await post({
        ...project,
        archived,
        expectedUpdatedAt: project.updatedAt,
      });
      expect(response.status).toBe(200);
      const next = (await read(response)).project;
      expect(next.archived).toBe(archived);
      expect(next.updatedAt > project.updatedAt).toBe(true);
      project = next;
    }
  });
  it('isolates owners even with matching project IDs and rejects cross-owner updates', async () => {
    const { project } = await read(await post(payload()));
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await read(await GET())).projects).toHaveLength(0);
    expect(
      (await post(payload({ expectedUpdatedAt: project.updatedAt }))).status,
    ).toBe(409);
    expect((await post(payload())).status).toBe(200);
    expect((await read(await GET())).projects).toHaveLength(1);
  });
  it('rejects duplicate creates and allows exactly one concurrent revision update', async () => {
    const { project } = await read(await post(payload()));
    expect((await post(payload())).status).toBe(409);
    const responses = await Promise.all(
      [1, 2].map(() => post(payload({ expectedUpdatedAt: project.updatedAt }))),
    );
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
  });
  it('advances save revisions when the clock has not advanced', async () => {
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-08T00:00:00.000Z'));
    try {
      const { project } = await read(await post(payload()));
      const next = await read(
        await post(payload({ expectedUpdatedAt: project.updatedAt })),
      );
      expect(next.project.updatedAt).toBe('2026-09-08T00:00:00.001Z');
      expect(
        (await post(payload({ expectedUpdatedAt: project.updatedAt }))).status,
      ).toBe(409);
    } finally {
      clock.mockRestore();
    }
  });
  it('round-trips quote identity through the legacy plan API without leaking another owner', async () => {
    const address = quoteCatalog('Solana', 'StonkFun').assets.filter(
      (a) => a.symbol === 'OPENAI',
    )[1].address;
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'StonkFun',
      currency: 'OPENAI',
      quoteAddress: address,
    };
    const response = await legacyPost(
      new Request('http://localhost/api/launch/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plan),
      }),
    );
    expect(response.status).toBe(200);
    expect((await legacyGet()).status).toBe(200);
    expect(await (await legacyGet()).json()).toMatchObject({
      plan: { quoteAddress: address, currency: 'OPENAI' },
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect(await (await legacyGet()).json()).toEqual({ plan: null });
  });
  it('persists exact duplicate-symbol quote identity and refuses invalid replacements', async () => {
    const assets = quoteCatalog('Solana', 'StonkFun').assets.filter(
      (a) => a.symbol === 'OPENAI',
    );
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'StonkFun',
      currency: 'OPENAI',
      quoteAddress: assets[0].address,
    };
    const saved = (await read(await post(payload({ plan })))).project;
    expect((await read(await GET())).projects[0].plan.quoteAddress).toBe(
      assets[0].address,
    );
    expect(
      (
        await post(
          payload({
            plan: { ...plan, quoteAddress: undefined },
            expectedUpdatedAt: saved.updatedAt,
          }),
        )
      ).status,
    ).toBe(400);
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      saved.updatedAt,
    );
    const replacement = (
      await read(
        await post(
          payload({
            plan: { ...plan, quoteAddress: assets[1].address },
            expectedUpdatedAt: saved.updatedAt,
          }),
        ),
      )
    ).project;
    expect(replacement.plan.quoteAddress).toBe(assets[1].address);
    const events = await mocks.db
      .prepare('SELECT changes FROM project_events WHERE type = ?')
      .bind('project.saved')
      .all<{ changes: string }>();
    expect(events.results.some((e) => e.changes.includes('quote token'))).toBe(
      true,
    );
  });
  it('archives old unsupported quotes unchanged and requires correction for a plan edit', async () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'Printr',
      currency: 'USDC',
    };
    await mocks.db
      .prepare(
        'INSERT INTO workspace_projects(id,owner_id,document,archived,updated_at) VALUES (?,?,?,?,?)',
      )
      .bind(
        'test-project',
        'alice',
        JSON.stringify({ plan }),
        0,
        '2026-10-09T00:00:00.000Z',
      )
      .run();
    const old = (await read(await GET())).projects[0];
    expect(old.plan.currency).toBe('USDC');
    const archived = await post(
      payload({ plan, archived: true, expectedUpdatedAt: old.updatedAt }),
    );
    expect(archived.status).toBe(200);
    const saved = (await read(archived)).project;
    expect(
      (
        await post(
          payload({
            plan: { ...plan, tokenName: 'Changed' },
            archived: true,
            expectedUpdatedAt: saved.updatedAt,
          }),
        )
      ).status,
    ).toBe(400);
  });
  it('persists supported launch methods and rejects mismatches without overwriting', async () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Base',
      launchpad: 'Clanker',
      currency: 'ETH',
      mode: 'Quick',
    };
    const response = await post(payload({ plan }));
    expect(response.status).toBe(200);
    const saved = (await read(response)).project;
    expect((await read(await GET())).projects[0].plan.mode).toBe('Quick');
    expect(
      (
        await post(
          payload({
            plan: { ...plan, mode: 'Block-0' },
            expectedUpdatedAt: saved.updatedAt,
          }),
        )
      ).status,
    ).toBe(400);
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      saved.updatedAt,
    );
    const legacyRequest = (mode: string) =>
      new Request('http://localhost/api/launch/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...plan, mode }),
      });
    expect((await legacyPost(legacyRequest('Stagger'))).status).toBe(200);
    expect((await legacyGet()).status).toBe(200);
    await expect((await legacyGet()).json()).resolves.toMatchObject({
      plan: { mode: 'Stagger' },
    });
    expect((await legacyPost(legacyRequest('Block-0'))).status).toBe(400);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await read(await GET())).projects).toHaveLength(0);
  });
  it('retains and archives a historical Organic draft but requires correction for edits', async () => {
    const plan = { ...DEFAULT_LAUNCH_PLAN, mode: 'Organic' };
    await mocks.db
      .prepare(
        'INSERT INTO workspace_projects(id,owner_id,document,archived,updated_at) VALUES (?,?,?,?,?)',
      )
      .bind(
        'test-project',
        'alice',
        JSON.stringify({ plan }),
        0,
        '2026-10-09T00:00:00.000Z',
      )
      .run();
    const old = (await read(await GET())).projects[0];
    expect(old.plan.mode).toBe('Organic');
    const archivedResponse = await post(
      payload({ plan, archived: true, expectedUpdatedAt: old.updatedAt }),
    );
    expect(archivedResponse.status).toBe(200);
    const archived = (await read(archivedResponse)).project;
    expect(
      (
        await post(
          payload({
            plan: { ...plan, tokenName: 'Changed' },
            archived: true,
            expectedUpdatedAt: archived.updatedAt,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          payload({
            plan: { ...plan, mode: 'Stagger' },
            archived: true,
            expectedUpdatedAt: archived.updatedAt,
          }),
        )
      ).status,
    ).toBe(200);
  });
  it('retains exact pacing in project and legacy APIs and rejects unsupported timing', async () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      chain: 'Base',
      launchpad: 'Clanker',
      currency: 'ETH',
      mode: 'Stagger',
      timing: { buyDelayMs: 1543, initialBuyDelayMs: 12345 },
    };
    const response = await post(payload({ plan }));
    expect(response.status).toBe(200);
    const saved = (await read(response)).project;
    expect((await read(await GET())).projects[0].plan.timing).toEqual(
      plan.timing,
    );
    const invalid = await post(
      payload({
        plan: { ...plan, mode: 'Quick' },
        expectedUpdatedAt: saved.updatedAt,
      }),
    );
    expect(invalid.status).toBe(400);
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      saved.updatedAt,
    );
    const legacyRequest = (value: unknown) =>
      new Request('http://localhost/api/launch/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    expect((await legacyPost(legacyRequest(plan))).status).toBe(200);
    await expect((await legacyGet()).json()).resolves.toMatchObject({
      plan: { timing: plan.timing },
    });
    expect(
      (await legacyPost(legacyRequest({ ...plan, mode: 'Manual' }))).status,
    ).toBe(400);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    await expect((await legacyGet()).json()).resolves.toEqual({ plan: null });
  });
  it('saves an unassigned launch recipient and rejects a changed launch after it gains membership', async () => {
    const address = '11111111111111111111111111111111';
    await mocks.db
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,folder_ids,label,role,revision,updated_at) VALUES ('alice','Solana',?,'','[]','','Recipient',1,'now')",
      )
      .bind(address)
      .run();
    const wallets = {
      chain: 'Solana',
      recipients: [{ address, revision: 1, folderRevision: 0 }],
    };
    const response = await post(payload({ options: { wallets } }));
    expect(response.status).toBe(200);
    const saved = (await read(response)).project;
    await mocks.db
      .prepare(
        "UPDATE workspace_wallets SET folder_id='a',folder_ids='[\"a\"]' WHERE owner_id='alice'",
      )
      .run();
    expect(
      (
        await post(
          payload({
            plan: { ...DEFAULT_LAUNCH_PLAN, tokenName: 'Changed' },
            options: { wallets },
            expectedUpdatedAt: saved.updatedAt,
          }),
        )
      ).status,
    ).toBe(409);
  });
  it('saves a parent launch wallet through an archived folder and rejects wallet archive', async () => {
    const address = '11111111111111111111111111111111';
    await mocks.db
      .prepare(
        "INSERT INTO wallet_folders(owner_id,id,name,chain,archived,revision,updated_at) VALUES ('alice','a','Archived','Solana',1,2,'now')",
      )
      .run();
    await mocks.db
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,folder_ids,label,role,revision,updated_at) VALUES ('alice','Solana',?,'a','[\"a\"]','','Recipient',1,'now')",
      )
      .bind(address)
      .run();
    const wallets = {
      chain: 'Solana',
      recipients: [{ address, revision: 1, folderRevision: 0, root: true }],
    };
    const response = await post(payload({ options: { wallets } }));
    expect(response.status).toBe(200);
    const saved = (await read(response)).project;
    await mocks.db
      .prepare("UPDATE workspace_wallets SET archived=1 WHERE owner_id='alice'")
      .run();
    expect(
      (
        await post(
          payload({
            plan: { ...DEFAULT_LAUNCH_PLAN, tokenName: 'Changed parent' },
            options: { wallets },
            expectedUpdatedAt: saved.updatedAt,
          }),
        )
      ).status,
    ).toBe(409);
  });
  it('binds a saved launch reference to its secondary membership and rejects removal even while the primary remains active', async () => {
    const address = '11111111111111111111111111111111';
    await mocks.db
      .prepare(
        "INSERT INTO wallet_folders(owner_id,id,name,chain,revision,updated_at) VALUES ('alice','a','A','Solana',1,'now'),('alice','b','B','Solana',1,'now')",
      )
      .run();
    await mocks.db
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,folder_ids,label,role,revision,updated_at) VALUES ('alice','Solana',?,'a',?,'','Recipient',1,'now')",
      )
      .bind(address, JSON.stringify(['a', 'b']))
      .run();
    const wallets = {
      chain: 'Solana',
      recipients: [{ address, revision: 1, folderRevision: 1, folderId: 'b' }],
    };
    const response = await post(payload({ options: { wallets } }));
    expect(response.status).toBe(200);
    const saved = (await read(response)).project;
    expect(saved.options.wallets).toEqual(wallets);
    await mocks.db
      .prepare(
        "UPDATE workspace_wallets SET folder_ids='[\"a\"]' WHERE owner_id='alice'",
      )
      .run();
    expect(
      (
        await post(
          payload({
            plan: { ...DEFAULT_LAUNCH_PLAN, tokenName: 'Changed launch' },
            options: { wallets },
            expectedUpdatedAt: saved.updatedAt,
          }),
        )
      ).status,
    ).toBe(409);
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      saved.updatedAt,
    );
  });
  it('persists owned launch references, rejects stale revisions and preserves historical archive', async () => {
    const deployer = '11111111111111111111111111111111',
      recipient = 'So11111111111111111111111111111111111111112';
    await mocks.db
      .prepare(
        "INSERT INTO wallet_folders(owner_id,id,name,chain,revision,updated_at) VALUES ('alice','launch','Launch','Solana',1,'now')",
      )
      .run();
    for (const [address, role] of [
      [deployer, 'Deployer'],
      [recipient, 'Recipient'],
    ])
      await mocks.db
        .prepare(
          "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,revision,updated_at) VALUES ('alice','Solana',?,'launch','',?,1,'now')",
        )
        .bind(address, role)
        .run();
    const wallets = {
      chain: 'Solana',
      deployer: { address: deployer, revision: 1, folderRevision: 1 },
      recipients: [{ address: recipient, revision: 1, folderRevision: 1 }],
    };
    const response = await post(payload({ options: { wallets } }));
    expect(response.status).toBe(200);
    const saved = (await read(response)).project;
    expect((await read(await GET())).projects[0].options.wallets).toEqual(
      wallets,
    );
    await mocks.db
      .prepare(
        "UPDATE workspace_wallets SET revision=2 WHERE owner_id='alice' AND address=?",
      )
      .bind(recipient)
      .run();
    expect(
      (
        await post(
          payload({
            plan: { ...DEFAULT_LAUNCH_PLAN, tokenName: 'Changed' },
            options: { wallets },
            expectedUpdatedAt: saved.updatedAt,
          }),
        )
      ).status,
    ).toBe(409);
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      saved.updatedAt,
    );
    expect(
      (
        await post(
          payload({
            options: { wallets },
            archived: true,
            expectedUpdatedAt: saved.updatedAt,
          }),
        )
      ).status,
    ).toBe(200);
    const latest = (await read(await GET())).projects[0];
    expect(latest.options.wallets).toEqual(wallets);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await post(payload({ options: { wallets } }))).status).toBe(409);
    expect((await read(await GET())).projects).toHaveLength(0);
  });
  it('rejects wrong roles and an archive race in the same mutation with no history event', async () => {
    const address = '11111111111111111111111111111111';
    await mocks.db
      .prepare(
        "INSERT INTO wallet_folders(owner_id,id,name,chain,revision,updated_at) VALUES ('alice','launch','Launch','Solana',1,'now')",
      )
      .run();
    await mocks.db
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,revision,updated_at) VALUES ('alice','Solana',?,'launch','','Funder',1,'now')",
      )
      .bind(address)
      .run();
    const wallets = {
      chain: 'Solana',
      recipients: [{ address, revision: 1, folderRevision: 1 }],
    };
    expect((await post(payload({ options: { wallets } }))).status).toBe(409);
    await mocks.db
      .prepare(
        "UPDATE workspace_wallets SET role='Recipient' WHERE owner_id='alice'",
      )
      .run();
    const real = mocks.db;
    mocks.db = {
      prepare: real.prepare.bind(real),
      batch: async (statements: D1PreparedStatement[]) => {
        await real
          .prepare(
            "UPDATE wallet_folders SET archived=1,revision=2 WHERE owner_id='alice'",
          )
          .run();
        return real.batch(statements);
      },
    } as unknown as D1Database;
    try {
      expect((await post(payload({ options: { wallets } }))).status).toBe(409);
    } finally {
      mocks.db = real;
    }
    expect((await read(await GET())).projects).toHaveLength(0);
    expect(
      (
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM project_events')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it('retains Printr parameters and rejects invalid replacements without adding history', async () => {
    const settings = {
      pumpfun: {
        holderRewards: false,
        offchainCreation: false,
        feeSharing: false,
        feeShares: [],
      },
      flap: { buyTaxPercent: 1, sellTaxPercent: 1 },
      printr: {
        feeDestination: 'buyback',
        maxSupply: '100_million',
        initialMarketCapUsd: '6500.25',
        beforeMigrationFeePercent: '1.25',
        afterMigrationFeePercent: '0.5',
      },
    };
    const response = await post(
      payload({
        plan: { ...DEFAULT_LAUNCH_PLAN, launchpad: 'Printr' },
        options: { settings },
      }),
    );
    expect(response.status).toBe(200);
    const initial = (await read(response)).project;
    expect(
      (await read(await GET())).projects[0].options.settings.printr,
    ).toEqual(settings.printr);
    for (const change of [
      { initialMarketCapUsd: '4999' },
      { afterMigrationFeePercent: '1.41' },
      { feeDestination: 'unknown' },
    ]) {
      expect(
        (
          await post({
            ...initial,
            options: {
              ...initial.options,
              settings: {
                ...settings,
                printr: { ...settings.printr, ...change },
              },
            },
            expectedUpdatedAt: initial.updatedAt,
          })
        ).status,
      ).toBe(400);
    }
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      initial.updatedAt,
    );
    expect(
      (
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM project_events')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it('retains a custom creator fee and rejects incompatible replacement without history', async () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      currency: 'INTC',
      quoteAddress: 'iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF',
    };
    const settings = {
      pumpfun: {
        holderRewards: false,
        offchainCreation: false,
        feeSharing: false,
        feeShares: [],
        creatorFeePercent: '1.25',
      },
      flap: { buyTaxPercent: 1, sellTaxPercent: 1 },
    };
    const response = await post(payload({ plan, options: { settings } }));
    expect(response.status).toBe(200);
    const initial = (await read(response)).project;
    expect(
      (await read(await GET())).projects[0].options.settings.pumpfun
        .creatorFeePercent,
    ).toBe('1.25');
    expect(
      (
        await post({
          ...initial,
          plan: DEFAULT_LAUNCH_PLAN,
          expectedUpdatedAt: initial.updatedAt,
        })
      ).status,
    ).toBe(400);
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      initial.updatedAt,
    );
    expect(
      (
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM project_events')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it('persists holder distribution settings in both APIs with owner isolation and no write on invalid replacement', async () => {
    const holdersDistribution = {
      kind: 'custom',
      weights: ['1', '3'],
      deviationPercent: 150,
      seed: '1234567890abcdef1234567890abcdef',
    };
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      mode: 'Stagger' as const,
      holderCount: 2,
      holdersBuyQuote: '0.020000001',
      holdersDistribution,
    };
    const response = await post(payload({ plan }));
    expect(response.status).toBe(200);
    const initial = (await read(response)).project;
    expect(
      (await read(await GET())).projects[0].plan.holdersDistribution,
    ).toEqual(holdersDistribution);
    expect(
      (
        await post({
          ...initial,
          plan: {
            ...plan,
            holdersDistribution: { ...holdersDistribution, seed: 'bad' },
          },
          expectedUpdatedAt: initial.updatedAt,
        })
      ).status,
    ).toBe(400);
    for (const weights of [['0', '0'], ['1'], ['-1', '3']]) {
      expect(
        (
          await post({
            ...initial,
            plan: {
              ...plan,
              holdersDistribution: { ...holdersDistribution, weights },
            },
            expectedUpdatedAt: initial.updatedAt,
          })
        ).status,
      ).toBe(400);
    }
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      initial.updatedAt,
    );
    expect(
      (
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM project_events')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    const legacyRequest = (value: unknown) =>
      new Request('http://localhost/api/launch/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    expect((await legacyPost(legacyRequest(plan))).status).toBe(200);
    await expect((await legacyGet()).json()).resolves.toMatchObject({
      plan: { holdersDistribution },
    });
    expect(
      (
        await legacyPost(
          legacyRequest({
            ...plan,
            holdersDistribution: {
              ...holdersDistribution,
              deviationPercent: -1,
            },
          }),
        )
      ).status,
    ).toBe(400);
    await expect((await legacyGet()).json()).resolves.toMatchObject({
      plan: { holdersDistribution },
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await read(await GET())).projects).toHaveLength(0);
    await expect((await legacyGet()).json()).resolves.toEqual({ plan: null });
  });
  it('retains exact quote amounts in both APIs and rejects over-precision without replacing saved plans or events', async () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      mode: 'Stagger' as const,
      currency: 'USDC',
      holdersBuyQuote: '120.123456',
    };
    const response = await post(payload({ plan }));
    expect(response.status).toBe(200);
    const initial = (await read(response)).project;
    expect((await read(await GET())).projects[0].plan.holdersBuyQuote).toBe(
      '120.123456',
    );
    const invalid = { ...plan, holdersBuyQuote: '120.1234567' };
    expect(
      (
        await post({
          ...initial,
          plan: invalid,
          expectedUpdatedAt: initial.updatedAt,
        })
      ).status,
    ).toBe(400);
    expect((await read(await GET())).projects[0].updatedAt).toBe(
      initial.updatedAt,
    );
    expect(
      (
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM project_events')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    const legacyRequest = (value: unknown) =>
      new Request('http://localhost/api/launch/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    expect((await legacyPost(legacyRequest(plan))).status).toBe(200);
    await expect((await legacyGet()).json()).resolves.toMatchObject({
      plan: { holdersBuyQuote: '120.123456' },
    });
    expect((await legacyPost(legacyRequest(invalid))).status).toBe(400);
    await expect((await legacyGet()).json()).resolves.toMatchObject({
      plan: { holdersBuyQuote: '120.123456' },
    });
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    await expect((await legacyGet()).json()).resolves.toEqual({ plan: null });
    expect((await read(await GET())).projects).toHaveLength(0);
  });
  it('enforces supply limits on both save APIs while retaining historical allocations and atomic events', async () => {
    const plan = {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'StonkFun',
      developerBuy: 50,
      holdersBuy: 29,
    };
    const initial = (await read(await post(payload({ plan })))).project;
    const invalid = { ...plan, holdersBuy: 30 };
    expect(
      (
        await post({
          ...initial,
          plan: invalid,
          expectedUpdatedAt: initial.updatedAt,
        })
      ).status,
    ).toBe(400);
    expect((await read(await GET())).projects[0].plan.holdersBuy).toBe(29);
    expect(
      (
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM project_events')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    const legacyRequest = (value: unknown) =>
      new Request('http://localhost/api/launch/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    expect((await legacyPost(legacyRequest(plan))).status).toBe(200);
    expect((await legacyPost(legacyRequest(invalid))).status).toBe(400);
    await expect((await legacyGet()).json()).resolves.toMatchObject({
      plan: { holdersBuy: 29 },
    });
    const historical = {
      plan: invalid,
      identity: initial.identity,
      options: initial.options,
    };
    await mocks.db
      .prepare('UPDATE workspace_projects SET document=? WHERE id=?')
      .bind(JSON.stringify(historical), initial.id)
      .run();
    const old = (await read(await GET())).projects[0];
    expect(old.plan.holdersBuy).toBe(30);
    expect(
      (await post({ ...old, archived: true, expectedUpdatedAt: old.updatedAt }))
        .status,
    ).toBe(200);
    const archived = (await read(await GET())).projects[0];
    expect(
      (
        await post({
          ...archived,
          plan: { ...archived.plan, holderCount: 11 },
          expectedUpdatedAt: archived.updatedAt,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM project_events')
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it('does not expose storage exceptions', async () => {
    const database = mocks.db;
    mocks.db = {
      prepare: () => {
        throw new Error('internal secret storage failure');
      },
    } as unknown as D1Database;
    try {
      for (const response of [await GET(), await post(payload())]) {
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('internal secret');
      }
    } finally {
      mocks.db = database;
    }
  });
  it.each(['Solana', 'Robinhood', 'BNB', 'Arc', 'Ethereum', 'Base'])(
    'persists %s clone provenance and rejects invalid source references without overwriting the draft',
    async (chain) => {
      const clonedFrom = {
        chain,
        address:
          chain === 'Solana'
            ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
            : '0x1111111111111111111111111111111111111111',
      };
      const response = await post(payload({ identity: { clonedFrom } }));
      expect(response.status).toBe(200);
      const saved = (await read(response)).project;
      expect((await read(await GET())).projects[0].identity.clonedFrom).toEqual(
        clonedFrom,
      );
      expect(
        (
          await post(
            payload({
              identity: {
                clonedFrom: { ...clonedFrom, address: 'not-a-mint' },
              },
              expectedUpdatedAt: saved.updatedAt,
            }),
          )
        ).status,
      ).toBe(400);
      expect((await read(await GET())).projects[0].updatedAt).toBe(
        saved.updatedAt,
      );
    },
  );
  it('rejects invalid documents, cross-origin and non-JSON writes', async () => {
    expect(
      (await post(payload({ identity: { artworkUrl: 'javascript:alert(1)' } })))
        .status,
    ).toBe(400);
    expect(
      (await post(payload(), { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect(
      (await post(payload(), { 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect((await post(payload({ padding: 'x'.repeat(25000) }))).status).toBe(
      413,
    );
    expect(
      (await post(payload({ expectedUpdatedAt: 'not-a-revision' }))).status,
    ).toBe(400);
    expect((await read(await GET())).projects).toHaveLength(0);
  });
  it('enforces the per-owner project cap atomically without affecting other owners', async () => {
    await mocks.db
      .prepare(`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<99)
      INSERT INTO workspace_projects(id,owner_id,document,archived,updated_at)
      SELECT 'fixture-'||n,'alice',?,0,'2026-10-09T00:00:00.000Z' FROM entries`)
      .bind(JSON.stringify({ plan: DEFAULT_LAUNCH_PLAN }))
      .run();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        post(payload({ id: `project-${i}` })),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await read(await GET())).projects).toHaveLength(100);
    expect(
      (
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM project_events')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await post(payload())).status).toBe(200);
  }, 15000);
});
