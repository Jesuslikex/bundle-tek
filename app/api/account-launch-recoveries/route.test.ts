import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  read: vi.fn(),
  db: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: async () => m.user }));
vi.mock('@/db', () => ({ getD1: m.db }));
vi.mock('@/lib/launch-recovery-discovery-server', () => ({
  readLaunchRecoveryPage: m.read,
}));
import { GET } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  m.user = { userId: 'alice' };
});
const request = (query = '') =>
  new Request('https://bundle.test/api/account-launch-recoveries' + query);
it('authenticates before querying or parsing', async () => {
  m.user = null;
  const r = await GET(request('?owner=bob'));
  expect(r.status).toBe(401);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(m.db).not.toHaveBeenCalled();
  expect(m.read).not.toHaveBeenCalled();
});
it.each(['?owner=bob', '?cursor=a&cursor=b', '?cursor=bad', '?limit=100'])(
  'rejects unsupported query %s before database access',
  async (q) => {
    expect((await GET(request(q))).status).toBe(400);
    expect(m.db).not.toHaveBeenCalled();
  },
);
it('passes only authenticated owner, cursor and request cancellation to the read-only reader', async () => {
  m.read.mockResolvedValue({ safe: true });
  const req = request();
  const r = await GET(req);
  expect(r.status).toBe(200);
  expect(m.read).toHaveBeenCalledWith(undefined, 'alice', null, req.signal);
  expect(r.headers.get('cache-control')).toBe('no-store');
});
it('fails closed without echoing database internals', async () => {
  m.read.mockRejectedValue(Error('SECRET_URL'));
  const r = await GET(request());
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain('SECRET');
});
