import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const mocks = vi.hoisted(() => ({
  user: null as { userId: string; email: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';

const as = (userId: string | null) => {
  mocks.user = userId ? { userId, email: `${userId}@example.test` } : null;
};
const origin = 'http://localhost';
const post = (body: unknown, headers: Record<string, string> = { origin }) =>
  POST(
    new Request(`${origin}/api/referrals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
type Summary = {
  code: string | null;
  referredCount: number;
  referredBy: { code: string } | null;
};
const read = async (r: Response) => (await r.json()) as Summary;

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'referrals-test',
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
          env: { DB: { type: 'd1', id: 'referrals-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'referrals-test',
  )) as unknown as D1Database;
  for (const sql of readFileSync(
    new URL('../../../drizzle/0101_referrals.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
}, 30000);
beforeEach(async () => {
  await mocks.db.prepare('DELETE FROM referrals').run();
  await mocks.db.prepare('DELETE FROM referral_codes').run();
});
afterAll(async () => {
  await mf?.dispose();
});

it('creates one stable code and counts accounts that apply it', async () => {
  as('alice');
  const first = await read(await post({ action: 'create' }));
  expect(first.code).toMatch(/^[A-Z2-9]{8}$/);
  expect((await read(await post({ action: 'create' }))).code).toBe(first.code);
  as('bob');
  const applied = await read(
    await post({ action: 'apply', code: first.code!.toLowerCase() }),
  );
  expect(applied.referredBy?.code).toBe(first.code);
  // Applying the same code again is idempotent.
  expect((await post({ action: 'apply', code: first.code })).status).toBe(200);
  as('alice');
  expect((await read(await GET())).referredCount).toBe(1);
});

it('rejects own codes, second codes, loops, unknown codes and cross-origin calls', async () => {
  as('alice');
  const alice = (await read(await post({ action: 'create' }))).code!;
  expect((await post({ action: 'apply', code: alice })).status).toBe(409);
  as('bob');
  const bob = (await read(await post({ action: 'create' }))).code!;
  await post({ action: 'apply', code: alice });
  as('carol');
  const carol = (await read(await post({ action: 'create' }))).code!;
  as('bob');
  expect((await post({ action: 'apply', code: carol })).status).toBe(409);
  as('alice');
  expect((await post({ action: 'apply', code: bob })).status).toBe(409);
  expect((await post({ action: 'apply', code: 'ZZZZZZZZ' })).status).toBe(404);
  expect((await post({ action: 'apply', code: 'bad' })).status).toBe(400);
  expect(
    (await post({ action: 'create' }, { origin: 'https://evil.example' }))
      .status,
  ).toBe(403);
  as(null);
  expect((await GET()).status).toBe(401);
});
