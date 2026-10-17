import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';

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
