import { beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
const m = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: async () => m.user }));
vi.mock('@/db', () => ({ getD1: m.db }));
vi.mock('@/lib/marketplace-saved-evidence-server', async (original) => ({
  ...(await original<
    typeof import('@/lib/marketplace-saved-evidence-server')
  >()),
  readMarketplaceSavedEvidence: m.read,
}));
import { GET } from './route';
import { SavedEvidenceStoredError } from '@/lib/marketplace-saved-evidence-server';
import { savedHistoryCursor } from '@/lib/marketplace-saved-evidence';
const a = bs58.encode(new Uint8Array(32).fill(1));
const req = (query = 'view=wallets', signal?: AbortSignal) =>
  new Request('https://bundle.test/api/marketplace/saved-evidence?' + query, {
    signal,
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.user = { userId: 'alice' };
  m.db.mockReturnValue({ local: true });
  m.read.mockResolvedValue({ safe: true });
});
it('authenticates before parsing, database access or source selection', async () => {
  m.user = null;
  const r = await GET(req('view=unknown&owner=other'));
  expect(r.status).toBe(401);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(m.db).not.toHaveBeenCalled();
  expect(m.read).not.toHaveBeenCalled();
});
it.each([
  '',
  'view=wallets&owner=bob',
  'view=wallets&view=wallets',
  'view=history&address=bad&revision=1',
  'view=wallets&cursor=',
  'view=history&address=' + a + '&revision=01',
])('refuses invalid query before DB %s', async (query) => {
  expect((await GET(req(query))).status).toBe(400);
  expect(m.db).not.toHaveBeenCalled();
  expect(m.read).not.toHaveBeenCalled();
});
it('passes only authenticated owner and exact parsed request/signal to the reader', async () => {
  const request = req('view=history&address=' + a + '&revision=2');
  const r = await GET(request);
  expect(r.status).toBe(200);
  expect(m.read).toHaveBeenCalledWith(
    { local: true },
    'alice',
    { view: 'history', address: a, revision: 2, cursor: null },
    request.signal,
  );
  expect(r.headers.get('cache-control')).toBe('no-store');
});
it('rejects a cursor from another wallet or revision before DB', async () => {
  const cursor = savedHistoryCursor(
    { address: a, revision: 3 },
    '2026-10-24T00:00:00.000Z',
    'run-1',
  );
  expect(
    (
      await GET(
        req(
          'view=history&address=' +
            a +
            '&revision=2&cursor=' +
            encodeURIComponent(cursor),
        ),
      )
    ).status,
  ).toBe(400);
  expect(m.db).not.toHaveBeenCalled();
});
it.each([404, 409, 503])(
  'keeps stored refusal %s fixed/private and no-store',
  async (status) => {
    m.read.mockRejectedValue(new SavedEvidenceStoredError(status));
    const r = await GET(req());
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).not.toMatch(/SQL|SELECT|PRIVATE/);
  },
);
it('does not echo unexpected database/parser failures', async () => {
  m.read.mockRejectedValue(Error('PRIVATE endpoint SQL'));
  const r = await GET(req());
  expect(r.status).toBe(503);
  expect(await r.text()).toContain('No partial page is shown');
});
it('cancellation takes precedence over current-wallet conflicts', async () => {
  const c = new AbortController();
  m.read.mockImplementation(async () => {
    c.abort();
    throw new SavedEvidenceStoredError(409);
  });
  expect((await GET(req('view=wallets', c.signal))).status).toBe(408);
});
it('does not read a pre-cancelled request', async () => {
  const c = new AbortController();
  c.abort();
  expect((await GET(req('view=wallets', c.signal))).status).toBe(408);
  expect(m.db).not.toHaveBeenCalled();
});
