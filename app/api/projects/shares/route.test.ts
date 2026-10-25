import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import { EMPTY_IDENTITY, DEFAULT_VENUE_OPTIONS } from '@/lib/workspace-project';

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
import { POST as saveProject } from '../route';
import { GET, POST } from './route';

const as = (userId: string) => {
  mocks.user = { userId, email: `${userId}@example.test` };
};
const origin = 'http://localhost';
const post = (body: unknown, headers: Record<string, string> = { origin }) =>
  POST(
    new Request(`${origin}/api/projects/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const get = (query = '') =>
  GET(new Request(`${origin}/api/projects/shares${query}`));

const selectedAddress = 'SysvarRent111111111111111111111111111111111';
const hiddenAddress = 'SysvarC1ock11111111111111111111111111111111';
const deployerAddress = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
async function assignmentDocument() {
  const document = {
    plan: structuredClone(DEFAULT_LAUNCH_PLAN),
    identity: {
      ...EMPTY_IDENTITY,
      website: 'https://hidden.example.test/private-social',
    },
    options: {
      ...structuredClone(DEFAULT_VENUE_OPTIONS),
      wallets: {
        chain: 'Solana',
        deployer: {
          address: deployerAddress,
          revision: 1,
          folderRevision: 1,
          folderId: 'private-folder',
        },
        recipients: [selectedAddress, hiddenAddress].map((address) => ({
          address,
          revision: 1,
          folderRevision: 1,
          folderId: 'private-folder',
        })),
      },
    },
  };
  document.options.settings.pumpfun.feeSharing = true;
  document.options.settings.pumpfun.feeShares = [
    { address: hiddenAddress, shareBps: 10000 },
  ];
  await mocks.db
    .prepare(
      'UPDATE workspace_projects SET document=?,updated_at=? WHERE owner_id=? AND id=?',
    )
    .bind(
      JSON.stringify(document),
      '2026-10-25T00:00:00.000Z',
      'alice',
      'shared-project',
    )
    .run();
  return document;
}
async function assignmentSource() {
  const response = await get('?projectId=shared-project');
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      source: {
        projectId: string;
        projectRevision: string;
        candidates: {
          chain: string;
          address: string;
          revision: number;
          role: string;
        }[];
      };
    }
  ).source;
}
async function scopedInvite(
  wallets: unknown[],
  projectRevision = '2026-10-25T00:00:00.000Z',
) {
  return post({
    action: 'invite',
    projectId: 'shared-project',
    walletScope: {
      format: 'project-share-wallet-scope-v1',
      projectRevision,
      wallets,
    },
  });
}

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'shares-test',
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
          env: { DB: { type: 'd1', id: 'shares-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'shares-test',
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
    '0005_special_marten_broadcloak.sql',
    '0010_magical_ender_wiggin.sql',
    '0100_project_shares.sql',
    '0148_project_share_expiry.sql',
    '0150_project_share_scope.sql',
    '0151_project_collaboration_metadata.sql',
  ])
    for (const sql of readFileSync(
      new URL('../../../../drizzle/' + file, import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await mocks.db.prepare(sql).run();
}, 30000);
beforeEach(async () => {
  await mocks.db.prepare('DELETE FROM project_shares').run();
  await mocks.db.prepare('DELETE FROM workspace_projects').run();
  as('alice');
  const saved = await saveProject(
    new Request(`${origin}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'shared-project',
        plan: DEFAULT_LAUNCH_PLAN,
        archived: false,
        expectedUpdatedAt: null,
      }),
    }),
  );
  expect(saved.status).toBe(200);
});
afterAll(async () => {
  await mf?.dispose();
});

it('lets an owner invite a collaborator who can then read the project', async () => {
  const invite = await post({ action: 'invite', projectId: 'shared-project' });
  expect(invite.status).toBe(201);
  const { share } = (await invite.json()) as {
    share: { id: string; token: string };
  };
  as('bob');
  expect((await get()).status).toBe(200);
  expect(((await (await get()).json()) as { projects: [] }).projects).toEqual(
    [],
  );
  expect((await post({ action: 'accept', token: share.token })).status).toBe(
    200,
  );
  const { projects } = (await (await get()).json()) as {
    projects: { id: string; readOnly: boolean }[];
  };
  expect(projects).toMatchObject([{ id: 'shared-project', readOnly: true }]);
  // Accepting again is idempotent; a third user cannot reuse the invite.
  expect((await post({ action: 'accept', token: share.token })).status).toBe(
    200,
  );
  as('carol');
  expect((await post({ action: 'accept', token: share.token })).status).toBe(
    409,
  );
  // Owner sees the accepted share and can revoke it.
  as('alice');
  const list = (await (await get('?projectId=shared-project')).json()) as {
    shares: { id: string; accepted: boolean }[];
  };
  expect(list.shares).toMatchObject([{ id: share.id, accepted: true }]);
  expect((await post({ action: 'revoke', id: share.id })).status).toBe(200);
  as('bob');
  expect(
    ((await (await get()).json()) as { projects: [] }).projects,
  ).toHaveLength(0);
});

it('rejects foreign projects, own invites, revokes by others and cross-origin calls', async () => {
  as('mallory');
  expect(
    (await post({ action: 'invite', projectId: 'shared-project' })).status,
  ).toBe(404);
  as('alice');
  const { share } = (await (
    await post({ action: 'invite', projectId: 'shared-project' })
  ).json()) as { share: { id: string; token: string } };
  expect((await post({ action: 'accept', token: share.token })).status).toBe(
    409,
  );
  as('mallory');
  expect((await post({ action: 'revoke', id: share.id })).status).toBe(404);
  expect(
    (
      await post(
        { action: 'invite', projectId: 'shared-project' },
        { origin: 'https://evil.example' },
      )
    ).status,
  ).toBe(403);
  expect((await post({ action: 'accept', token: 'x' })).status).toBe(400);
});

it('caps active shares per project and lets a collaborator leave', async () => {
  for (let i = 0; i < 10; i++)
    expect(
      (await post({ action: 'invite', projectId: 'shared-project' })).status,
    ).toBe(201);
  expect(
    (await post({ action: 'invite', projectId: 'shared-project' })).status,
  ).toBe(409);
  await mocks.db.prepare('DELETE FROM project_shares').run();
  const { share } = (await (
    await post({ action: 'invite', projectId: 'shared-project' })
  ).json()) as { share: { id: string; token: string } };
  as('bob');
  await post({ action: 'accept', token: share.token });
  expect((await post({ action: 'leave', id: share.id })).status).toBe(200);
  expect(
    ((await (await get()).json()) as { projects: [] }).projects,
  ).toHaveLength(0);
});

const expirySql = readFileSync(
  new URL('../../../../drizzle/0148_project_share_expiry.sql', import.meta.url),
  'utf8',
)
  .split('--> statement-breakpoint')
  .filter((s) => s.trim());
// Model an already-aged or legacy row in this disposable database only. Restore
// the exact committed guard before any route or acceptance assertion runs.
async function historicalExpiry(id: string, expiry: string | null) {
  await mocks.db.prepare('DROP TRIGGER project_shares_expiry_immutable').run();
  try {
    await mocks.db
      .prepare('UPDATE project_shares SET expires_at=? WHERE id=?')
      .bind(expiry, id)
      .run();
  } finally {
    await mocks.db.prepare(expirySql[2]).run();
  }
}
async function invite(duration?: unknown) {
  const response = await post({
    action: 'invite',
    projectId: 'shared-project',
    ...(duration === undefined ? {} : { expiresInSeconds: duration }),
  });
  expect(response.status).toBe(201);
  return (
    (await response.json()) as {
      share: { id: string; token: string; expiresAt: string };
    }
  ).share;
}
it.each([3600, 86400, 604800])(
  'saves the exact %s-second duration and exposes it in both views',
  async (duration) => {
    const share = await invite(duration);
    const row = await mocks.db
      .prepare(
        'SELECT created_at AS createdAt, expires_at AS expiresAt FROM project_shares WHERE id=?',
      )
      .bind(share.id)
      .first<{ createdAt: string; expiresAt: string }>();
    expect(Date.parse(row!.expiresAt) - Date.parse(row!.createdAt)).toBe(
      duration * 1000,
    );
    expect(share.expiresAt).toBe(row!.expiresAt);
    expect(await (await get('?projectId=shared-project')).json()).toMatchObject(
      { shares: [{ expiresAt: share.expiresAt, expired: false }] },
    );
    as('bob');
    await post({ action: 'accept', token: share.token });
    expect(await (await get()).json()).toMatchObject({
      projects: [{ expiresAt: share.expiresAt, readOnly: true }],
    });
  },
);
it.each([null, 0, 60, 3601, '3600', {}, [], 604801])(
  'refuses unsupported duration %j without creating a share',
  async (duration) => {
    expect(
      (
        await post({
          action: 'invite',
          projectId: 'shared-project',
          expiresInSeconds: duration,
        })
      ).status,
    ).toBe(400);
    expect(await (await get('?projectId=shared-project')).json()).toMatchObject(
      {
        shares: [],
        source: { projectId: 'shared-project', candidates: [] },
      },
    );
  },
);
it('filters expired members and refuses accepting an expired or exact-boundary invite', async () => {
  const first = await invite();
  as('bob');
  await post({ action: 'accept', token: first.token });
  as('alice');
  const second = await invite();
  const now = await mocks.db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS timestamp")
    .first<{ timestamp: string }>();
  await historicalExpiry(first.id, '2000-01-01T00:00:00.000Z');
  await historicalExpiry(second.id, now!.timestamp);
  expect(await (await get('?projectId=shared-project')).json()).toMatchObject({
    shares: expect.arrayContaining([
      {
        id: first.id,
        accepted: true,
        createdAt: expect.any(String),
        acceptedAt: expect.any(String),
        expiresAt: '2000-01-01T00:00:00.000Z',
        expired: true,
        walletScope: expect.objectContaining({ count: 0 }),
        permissions: { editMetadata: false },
      },
    ]),
  });
  as('bob');
  expect(await (await get()).json()).toEqual({ projects: [] });
  expect((await post({ action: 'accept', token: first.token })).status).toBe(
    404,
  );
  as('carol');
  expect((await post({ action: 'accept', token: second.token })).status).toBe(
    404,
  );
  await expect(
    mocks.db
      .prepare('UPDATE project_shares SET member_id=?,accepted_at=? WHERE id=?')
      .bind('carol', new Date().toISOString(), second.id)
      .run(),
  ).rejects.toThrow('Share expired');
  as('alice');
  expect((await post({ action: 'revoke', id: second.id })).status).toBe(200);
  as('bob');
  expect((await post({ action: 'leave', id: first.id })).status).toBe(200);
});
it('keeps legacy no-expiry shares readable and revocable but forbids adding or renewing expiry', async () => {
  const share = await invite();
  await historicalExpiry(share.id, null);
  as('bob');
  expect((await post({ action: 'accept', token: share.token })).status).toBe(
    200,
  );
  expect(await (await get()).json()).toMatchObject({
    projects: [{ expiresAt: null }],
  });
  await expect(
    mocks.db
      .prepare('UPDATE project_shares SET expires_at=? WHERE id=?')
      .bind(share.expiresAt, share.id)
      .run(),
  ).rejects.toThrow('Share expiry is immutable');
  as('alice');
  expect((await post({ action: 'revoke', id: share.id })).status).toBe(200);
  const fresh = await invite();
  await expect(
    mocks.db
      .prepare('UPDATE project_shares SET expires_at=NULL WHERE id=?')
      .bind(fresh.id)
      .run(),
  ).rejects.toThrow('Share expiry is immutable');
  await expect(
    mocks.db
      .prepare('UPDATE project_shares SET expires_at=? WHERE id=?')
      .bind(
        new Date(Date.parse(fresh.expiresAt) + 86400000).toISOString(),
        fresh.id,
      )
      .run(),
  ).rejects.toThrow('Share expiry is immutable');
});

it('explains an expired membership conflict and permits a new invite only after explicit owner revocation', async () => {
  const first = await invite();
  as('bob');
  await post({ action: 'accept', token: first.token });
  as('alice');
  await historicalExpiry(first.id, '2000-01-01T00:00:00.000Z');
  const next = await invite();
  as('bob');
  const conflict = await post({ action: 'accept', token: next.token });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    error:
      'Ask the owner to revoke your expired share before accepting a new invite.',
  });
  expect(
    (await mocks.db
      .prepare('SELECT revoked_at AS revoked FROM project_shares WHERE id=?')
      .bind(first.id)
      .first<{ revoked: string | null }>())!.revoked,
  ).toBeNull();
  as('alice');
  expect((await post({ action: 'revoke', id: first.id })).status).toBe(200);
  as('bob');
  expect((await post({ action: 'accept', token: next.token })).status).toBe(
    200,
  );
  expect(await (await get()).json()).toMatchObject({
    projects: [{ shareId: next.id }],
  });
});
it('requires a valid future expiry on new SQL inserts and keeps expired rows in the existing cap until revoked', async () => {
  for (const expiry of [
    null,
    'invalid',
    '2000-01-01T00:00:00.000Z',
    new Date(Date.now() + 120000).toISOString(),
  ]) {
    await expect(
      mocks.db
        .prepare(
          'INSERT INTO project_shares(id,owner_id,project_id,token_hash,created_at,expires_at,wallet_scope) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(
          crypto.randomUUID(),
          'alice',
          'shared-project',
          crypto.randomUUID(),
          new Date().toISOString(),
          expiry,
          JSON.stringify({
            format: 'project-share-wallet-scope-v1',
            projectRevision: (await mocks.db
              .prepare(
                'SELECT updated_at AS t FROM workspace_projects WHERE owner_id=? AND id=?',
              )
              .bind('alice', 'shared-project')
              .first<{ t: string }>())!.t,
            wallets: [],
          }),
        )
        .run(),
    ).rejects.toThrow('Share expiry invalid');
  }
  let first = '';
  for (let i = 0; i < 10; i++) {
    const share = await invite();
    first ||= share.id;
    await historicalExpiry(share.id, '2000-01-01T00:00:00.000Z');
  }
  expect(
    (await post({ action: 'invite', projectId: 'shared-project' })).status,
  ).toBe(409);
  expect((await post({ action: 'revoke', id: first })).status).toBe(200);
  await invite();
});

it('defaults new shares to no assignments and never transports hidden structured wallet or identity fields', async () => {
  await assignmentDocument();
  const share = await invite();
  as('bob');
  await post({ action: 'accept', token: share.token });
  const value = (await (await get()).json()) as {
    projects: Record<string, unknown>[];
  };
  const text = JSON.stringify(value);
  expect(value.projects[0]).toMatchObject({
    format: 'shared-project-scoped-v2',
    readOnly: true,
    walletScope: { mode: 'none', wallets: [], unavailableCount: 0 },
  });
  for (const hidden of [
    selectedAddress,
    hiddenAddress,
    deployerAddress,
    'private-folder',
    'hidden.example.test',
    'feeShares',
    'identity',
    'options',
  ])
    expect(text).not.toContain(hidden);
});

it('discloses only exact selected public assignment references, excluding later additions, roles and revisions', async () => {
  const document = await assignmentDocument();
  const source = await assignmentSource();
  expect(source.projectId).toBe('shared-project');
  expect(source.candidates).toHaveLength(3);
  expect(JSON.stringify(source)).not.toContain('private-folder');
  const selected = source.candidates.find(
    (w) => w.address === selectedAddress,
  )!;
  const response = await scopedInvite([selected], source.projectRevision);
  expect(response.status).toBe(201);
  const { share } = (await response.json()) as {
    share: { token: string; id: string };
  };
  as('bob');
  await post({ action: 'accept', token: share.token });
  let value = await (await get()).json();
  expect(value).toMatchObject({
    projects: [
      {
        walletScope: {
          mode: 'selected',
          wallets: [selected],
          unavailableCount: 0,
        },
      },
    ],
  });
  for (const hidden of [
    hiddenAddress,
    deployerAddress,
    'private-folder',
    'hidden.example.test',
  ])
    expect(JSON.stringify(value)).not.toContain(hidden);
  document.options.wallets.recipients[0].revision = 2;
  await mocks.db
    .prepare(
      'UPDATE workspace_projects SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(JSON.stringify(document), 'alice', 'shared-project')
    .run();
  value = await (await get()).json();
  expect(value).toMatchObject({
    projects: [
      { walletScope: { mode: 'selected', wallets: [], unavailableCount: 1 } },
    ],
  });
  expect(JSON.stringify(value)).not.toContain(selectedAddress);
  as('alice');
  await expect(
    mocks.db
      .prepare('UPDATE project_shares SET wallet_scope=? WHERE id=?')
      .bind(
        JSON.stringify({
          format: 'project-share-wallet-scope-v1',
          projectRevision: source.projectRevision,
          wallets: [],
        }),
        share.id,
      )
      .run(),
  ).rejects.toThrow('Share wallet scope is immutable');
});

it('rejects foreign, stale, duplicate and malformed assignment grants before saving an invite', async () => {
  await assignmentDocument();
  const source = await assignmentSource(),
    selected = source.candidates[1];
  expect(
    (await scopedInvite([selected], '2026-10-24T00:00:00.000Z')).status,
  ).toBe(409);
  expect(
    (
      await scopedInvite([
        { ...selected, address: 'So11111111111111111111111111111111111111112' },
      ])
    ).status,
  ).toBe(409);
  expect((await scopedInvite([selected, selected])).status).toBe(400);
  expect(
    (await scopedInvite([{ ...selected, signingAllowed: true }])).status,
  ).toBe(400);
  as('mallory');
  expect((await scopedInvite([selected])).status).toBe(404);
  as('alice');
  expect((await assignmentSource()).candidates).toHaveLength(3);
  expect(await (await get('?projectId=shared-project')).json()).toMatchObject({
    shares: [],
  });
});

it('SQL independently refuses stale source revisions and widened or missing scopes', async () => {
  await assignmentDocument();
  const source = await assignmentSource();
  for (const scope of [
    null,
    {
      format: 'project-share-wallet-scope-v1',
      projectRevision: '2026-10-24T00:00:00.000Z',
      wallets: [],
    },
    {
      format: 'project-share-wallet-scope-v1',
      projectRevision: source.projectRevision,
      wallets: [{ ...source.candidates[1], revision: 2 }],
    },
  ]) {
    const now = new Date().toISOString();
    await expect(
      mocks.db
        .prepare(
          'INSERT INTO project_shares(id,owner_id,project_id,token_hash,created_at,expires_at,wallet_scope) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(
          crypto.randomUUID(),
          'alice',
          'shared-project',
          crypto.randomUUID(),
          now,
          new Date(Date.parse(now) + 3600000).toISOString(),
          scope === null ? null : JSON.stringify(scope),
        )
        .run(),
    ).rejects.toThrow(/scope invalid|source changed/i);
  }
});

it('retains migrated legacy scope explicitly and fails closed on a corrupt persisted scope', async () => {
  await assignmentDocument();
  const share = await invite();
  const trigger = await mocks.db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='project_shares_scope_immutable'",
    )
    .first<{ sql: string }>();
  await mocks.db.prepare('DROP TRIGGER project_shares_scope_immutable').run();
  await mocks.db
    .prepare('UPDATE project_shares SET wallet_scope=NULL WHERE id=?')
    .bind(share.id)
    .run();
  await mocks.db.prepare(trigger!.sql).run();
  as('bob');
  await post({ action: 'accept', token: share.token });
  expect(await (await get()).json()).toMatchObject({
    projects: [{ walletScope: { mode: 'legacy', wallets: expect.any(Array) } }],
  });
  as('alice');
  expect(await (await get('?projectId=shared-project')).json()).toMatchObject({
    shares: [{ walletScope: { mode: 'legacy', count: null } }],
  });
  await mocks.db.prepare('DROP TRIGGER project_shares_scope_immutable').run();
  await mocks.db
    .prepare('UPDATE project_shares SET wallet_scope=? WHERE id=?')
    .bind('{"signingAllowed":true}', share.id)
    .run();
  await mocks.db.prepare(trigger!.sql).run();
  as('bob');
  expect((await get()).status).toBe(503);
  as('alice');
  expect(await (await get('?projectId=shared-project')).json()).toMatchObject({
    shares: [
      { id: share.id, walletScope: { mode: 'unavailable', count: null } },
    ],
  });
  expect((await post({ action: 'revoke', id: share.id })).status).toBe(200);
});

it('treats old-chain saved assignments as unavailable while keeping owner revoke and member reads usable', async () => {
  const document = await assignmentDocument();
  const source = await assignmentSource();
  const response = await scopedInvite([source.candidates[1]]);
  const { share } = (await response.json()) as {
    share: { id: string; token: string };
  };
  as('bob');
  await post({ action: 'accept', token: share.token });
  document.plan = {
    ...DEFAULT_LAUNCH_PLAN,
    chain: 'Base',
    launchpad: 'Clanker',
    currency: 'ETH',
  };
  document.options.settings.pumpfun = {
    holderRewards: false,
    offchainCreation: false,
    feeSharing: false,
    feeShares: [],
  };
  await mocks.db
    .prepare(
      'UPDATE workspace_projects SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(JSON.stringify(document), 'alice', 'shared-project')
    .run();
  expect(await (await get()).json()).toMatchObject({
    projects: [
      {
        walletSelectionMatchesPlan: false,
        walletScope: { mode: 'selected', wallets: [], unavailableCount: 1 },
      },
    ],
  });
  as('alice');
  expect((await assignmentSource()).candidates).toEqual([]);
  expect((await post({ action: 'revoke', id: share.id })).status).toBe(200);
  const none = await invite();
  as('bob');
  await post({ action: 'accept', token: none.token });
  expect(await (await get()).json()).toMatchObject({
    projects: [{ walletScope: { mode: 'none', wallets: [] } }],
  });
  as('alice');
  expect((await scopedInvite([source.candidates[1]])).status).toBe(409);
});

it('admits exactly stored checksummed EVM references without changing their address case', async () => {
  const document = await assignmentDocument();
  const evm = '0x52908400098527886E0F7030069857D2E4169EE7';
  const options = {
    ...document.options,
    settings: structuredClone(DEFAULT_VENUE_OPTIONS.settings),
    wallets: {
      chain: 'Base',
      recipients: [
        { address: evm, revision: 1, folderRevision: 0, root: true },
      ],
    },
  };
  const plan = {
    ...DEFAULT_LAUNCH_PLAN,
    chain: 'Base',
    launchpad: 'Clanker',
    currency: 'ETH',
  };
  await mocks.db
    .prepare(
      'UPDATE workspace_projects SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(
      JSON.stringify({ ...document, plan, options }),
      'alice',
      'shared-project',
    )
    .run();
  const source = await assignmentSource();
  expect(source.candidates[0].address).toBe(evm);
  const response = await scopedInvite(
    source.candidates,
    source.projectRevision,
  );
  expect(response.status).toBe(201);
  const { share } = (await response.json()) as { share: { token: string } };
  as('bob');
  await post({ action: 'accept', token: share.token });
  expect(await (await get()).json()).toMatchObject({
    projects: [
      {
        walletScope: {
          wallets: [
            { chain: 'Base', address: evm, revision: 1, role: 'Recipient' },
          ],
        },
      },
    ],
  });
});

it.each([false, true])(
  'retains an exact owner-selected saved-text permission (%s)',
  async (editMetadata) => {
    const response = await post({
      action: 'invite',
      projectId: 'shared-project',
      permissions: { editMetadata },
    });
    expect(response.status).toBe(201);
    const { share } = (await response.json()) as {
      share: {
        id: string;
        token: string;
        permissions: { editMetadata: boolean };
      };
    };
    expect(share.permissions).toEqual({ editMetadata });
    expect(await (await get('?projectId=shared-project')).json()).toMatchObject(
      { shares: [{ id: share.id, permissions: { editMetadata } }] },
    );
    as('bob');
    expect((await post({ action: 'accept', token: share.token })).status).toBe(
      200,
    );
    expect(await (await get()).json()).toMatchObject({
      projects: [
        {
          format: 'shared-project-scoped-v2',
          permissions: { editMetadata },
          readOnly: true,
        },
      ],
    });
    await expect(
      mocks.db
        .prepare('UPDATE project_shares SET metadata_edit=? WHERE id=?')
        .bind(editMetadata ? 0 : 1, share.id)
        .run(),
    ).rejects.toThrow('permission is immutable');
  },
);
it.each([
  null,
  [],
  {},
  { editMetadata: 1 },
  { editMetadata: 'true' },
  { editMetadata: true, signing: true },
])('rejects malformed or broader edit grants %j', async (permissions) => {
  expect(
    (await post({ action: 'invite', projectId: 'shared-project', permissions }))
      .status,
  ).toBe(400);
  expect(await (await get('?projectId=shared-project')).json()).toMatchObject({
    shares: [],
  });
});
it('keeps legacy omitted permissions off and rejects a foreign owner grant', async () => {
  const response = await post({
    action: 'invite',
    projectId: 'shared-project',
  });
  expect(await response.json()).toMatchObject({
    share: { permissions: { editMetadata: false } },
  });
  as('bob');
  expect(
    (
      await post({
        action: 'invite',
        projectId: 'shared-project',
        permissions: { editMetadata: true },
      })
    ).status,
  ).toBe(404);
});
