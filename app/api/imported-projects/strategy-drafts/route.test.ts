import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { strategyDraftStorage } from '../../../../test/strategy-session-draft-storage';
import {
  strategyInput,
  strategyProject,
} from '../../../../test/strategy-session-fixture';
import { GET, POST } from './route';
const state = vi.hoisted(() => ({
  user: 'owner' as string | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (state.user ? { userId: state.user } : null),
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
let store: Awaited<ReturnType<typeof strategyDraftStorage>>;
beforeEach(async () => {
  store = await strategyDraftStorage();
  state.db = store.db;
  state.user = 'owner';
});
afterEach(() => store.client.close());
const id = '00000000-0000-4000-8000-000000000010';
const post = (body: unknown, origin = 'https://bundle.test') =>
  POST(
    new Request('https://bundle.test/api/imported-projects/strategy-drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    }),
  );
const get = (query = `projectId=${strategyProject}`) =>
  GET(
    new Request(
      `https://bundle.test/api/imported-projects/strategy-drafts?${query}`,
    ),
  );
it('requires sign-in before reading or saving any draft', async () => {
  state.user = null;
  const a = await get(),
    b = await post({ action: 'save', id, input: strategyInput() });
  expect(a.status).toBe(401);
  expect(b.status).toBe(401);
  expect(a.headers.get('cache-control')).toBe('no-store');
});
it('round-trips owned combined terms through the real production DB adapter', async () => {
  const response = await post({ action: 'save', id, input: strategyInput() });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { draft: unknown };
  expect(body).toMatchObject({
    planningOnly: true,
    executionAllowed: false,
    draft: { id, revision: 1 },
  });
  const page = await get();
  expect(page.status).toBe(200);
  expect(((await page.json()) as { drafts: unknown[] }).drafts).toEqual([
    body.draft,
  ]);
  expect(page.headers.get('cache-control')).toBe('no-store');
  const archive = await post({
    action: 'archive',
    projectId: strategyProject,
    id,
    revision: 1,
    archived: true,
  });
  expect(archive.status).toBe(200);
  expect((await get()).status).toBe(200);
  expect(
    (
      (await (await get(`projectId=${strategyProject}&archived=1`)).json()) as {
        drafts: unknown[];
      }
    ).drafts,
  ).toHaveLength(1);
});
it('keeps other owners private', async () => {
  await post({ action: 'save', id, input: strategyInput() });
  state.user = 'other';
  expect((await get()).status).toBe(404);
  expect(
    (
      await post({
        action: 'archive',
        projectId: strategyProject,
        id,
        revision: 1,
        archived: true,
      })
    ).status,
  ).toBe(404);
});
it.each([
  'projectId=bad',
  `projectId=${strategyProject}&archived=yes`,
  `projectId=${strategyProject}&projectId=${strategyProject}`,
  `projectId=${strategyProject}&action=run`,
])('refuses unsupported query %s', async (query) => {
  expect((await get(query)).status).toBe(400);
});
it.each(['execute', 'extra', 'foreign-origin', 'oversized'] as const)(
  'refuses %s requests without saving',
  async (kind) => {
    const body = { action: 'save', id, input: strategyInput() };
    if (kind === 'execute') body.action = 'submit';
    if (kind === 'extra') Object.assign(body, { executionAllowed: true });
    if (kind === 'oversized') body.input.name = 'x'.repeat(25000);
    expect(
      (
        await post(
          body,
          kind === 'foreign-origin'
            ? 'https://other.test'
            : 'https://bundle.test',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await store.client.execute(
          'SELECT count(*) AS n FROM strategy_session_drafts',
        )
      ).rows[0].n,
    ).toBe(0);
  },
);
it('sanitizes storage errors', async () => {
  await store.client.execute('DROP TRIGGER strategy_session_drafts_retained');
  await store.client.execute('DROP TABLE strategy_session_drafts');
  const response = await get();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('SQL');
});
