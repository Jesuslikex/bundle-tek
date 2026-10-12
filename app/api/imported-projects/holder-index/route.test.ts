import { beforeEach, expect, it, vi } from 'vitest';
const { auth, first, observe, readRun, save } = vi.hoisted(() => ({
  auth: vi.fn(),
  first: vi.fn(),
  observe: vi.fn(),
  readRun: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: auth }));
vi.mock('@/db', () => ({
  getD1: () => ({
    prepare: (sql: string) => ({
      bind: () => ({
        first: sql.includes('holder_index_pages')
          ? () => null
          : sql.includes('COUNT(*)')
            ? () => ({ count: 0 })
            : first,
      }),
    }),
  }),
}));
vi.mock('@/lib/holder-index-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/holder-index-store')>()),
  holderRun: readRun,
  saveHolderRunPage: save,
}));
vi.mock('@/lib/holder-index-provider', () => ({
  observeHolderIndexPage: observe,
}));
import { POST } from './route';
const request = (
  body: unknown = {
    id: 'project-1',
    revision: 1,
    page: 1,
    runId: '00000000-0000-4000-8000-000000000001',
  },
  origin = 'http://localhost',
) =>
  new Request('http://localhost/api/imported-projects/holder-index', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
const project = { revision: 1, archived: 0, chain: 'Solana', address: 'mint' };
it('rejects unknown scan modes before provider access', async () => {
  expect(
    (
      await POST(
        request({
          id: 'project-1',
          revision: 1,
          page: 1,
          runId: '00000000-0000-4000-8000-000000000001',
          enumeration: 'unbounded',
        }),
      )
    ).status,
  ).toBe(400);
  expect(observe).not.toHaveBeenCalled();
});
it('forwards an explicitly selected parsed-account scan mode', async () => {
  expect(
    (
      await POST(
        request({
          id: 'project-1',
          revision: 1,
          page: 1,
          runId: '00000000-0000-4000-8000-000000000001',
          enumeration: 'program-accounts-v2',
        }),
      )
    ).status,
  ).toBe(200);
  expect(observe).toHaveBeenCalledWith(
    'mint',
    1,
    expect.any(AbortSignal),
    fetch,
    null,
    'program-accounts-v2',
  );
});
beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ userId: 'owner' });
  first.mockResolvedValue(project);
  readRun.mockResolvedValue(null);
  save.mockImplementation(
    async (_db, _owner, _project, _revision, runId, _run, page) => ({
      runId,
      page,
      status: 'partial',
    }),
  );
  observe.mockResolvedValue({ mint: 'mint', page: 1 });
});
it('requires a signed-in user and rejects cross-origin provider consumption', async () => {
  auth.mockResolvedValue(null);
  expect((await POST(request())).status).toBe(401);
  auth.mockResolvedValue({ userId: 'owner' });
  expect((await POST(request(undefined, 'https://other.test'))).status).toBe(
    403,
  );
  expect(observe).not.toHaveBeenCalled();
});
it('rejects archived, foreign-chain, changed and invalid page requests before reads', async () => {
  for (const row of [
    { ...project, archived: 1 },
    { ...project, chain: 'Ethereum' },
    { ...project, revision: 2 },
  ]) {
    first.mockResolvedValue(row);
    expect((await POST(request())).status).toBe(409);
  }
  expect(
    (await POST(request({ id: 'project-1', revision: 1, page: 0 }))).status,
  ).toBe(400);
  expect(observe).not.toHaveBeenCalled();
});
it('binds the mint to the saved project and revalidates it after the provider read', async () => {
  expect((await POST(request())).status).toBe(200);
  expect(observe).toHaveBeenCalledWith(
    'mint',
    1,
    expect.any(AbortSignal),
    fetch,
    null,
  );
  first
    .mockResolvedValueOnce(project)
    .mockResolvedValueOnce({ ...project, revision: 2 });
  expect((await POST(request())).status).toBe(409);
});
it('sanitizes provider errors instead of returning credential-bearing messages', async () => {
  observe.mockRejectedValue(
    new Error('https://secret.test/?api-key=credential'),
  );
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('credential');
});
