import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from './route';
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'imported-preparation-activity-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'imported-preparation-activity-db' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'imported-preparation-activity-test',
  )) as unknown as D1Database;
  for (const statement of readFileSync(
    'drizzle/0041_imported_swap_preparations.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    await mocks.db.prepare(statement.trim()).run();
  const document = JSON.stringify({
    executionAllowed: false,
    instructionsVerified: false,
    side: 'Buy',
    simulation: { succeeded: false },
  });
  for (let i = 0; i < 23; i++)
    await mocks.db
      .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        'one',
        i % 2 ? 'archived-project' : 'active-project',
        2,
        'public-wallet',
        1,
        document,
        '2026-10-11T00:00:00.000Z',
      )
      .run();
});
afterAll(async () => {
  await mf?.dispose();
});
const read = (cursor?: string) =>
  GET(
    new Request(
      'http://localhost/api/imported-projects/preparation-activity' +
        (cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`),
    ),
  );
it('requires authentication and isolates all saved reviews by owner without requiring an active project', async () => {
  mocks.user = null;
  expect((await read()).status).toBe(401);
  mocks.user = { userId: 'two' };
  expect(await (await read()).json()).toMatchObject({
    executionAllowed: false,
    preparations: [],
    nextCursor: null,
  });
  mocks.user = { userId: 'one' };
  const first = (await (await read()).json()) as {
    preparations: Array<{ id: string; projectId: string }>;
    nextCursor: string;
  };
  expect(first.preparations).toHaveLength(20);
  expect(
    first.preparations.some((row) => row.projectId === 'archived-project'),
  ).toBe(true);
  const second = (await (await read(first.nextCursor)).json()) as typeof first;
  expect(second.preparations).toHaveLength(3);
  expect(
    new Set(
      [...first.preparations, ...second.preparations].map((row) => row.id),
    ).size,
  ).toBe(23);
  expect(second.nextCursor).toBeNull();
  mocks.user = { userId: 'two' };
  expect((await read(first.nextCursor)).status).toBe(400);
});
it('rejects malformed and fabricated cursors', async () => {
  mocks.user = { userId: 'one' };
  for (const raw of [
    'null',
    '{}',
    'bad',
    JSON.stringify({
      createdAt: '2026-10-11T00:00:00.000Z',
      id: '00000000-0000-4000-8000-999999999999',
    }),
    JSON.stringify({
      createdAt: 'bad',
      id: '00000000-0000-4000-8000-000000000000',
    }),
  ])
    expect((await read(raw)).status).toBe(400);
});
