import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  read: vi.fn(),
  inspect: vi.fn(),
  db: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: async () => m.user }));
vi.mock('@/db', () => ({ getD1: m.db }));
vi.mock('@/lib/launch-recovery-discovery-server', () => ({
  readLaunchRecoveryPage: m.read,
}));
vi.mock('@/lib/launch-recovery-inspection-server', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/launch-recovery-inspection-server')
  >()),
  readLaunchRecoveryInspection: m.inspect,
}));
import { launchRecoveryInspectionUrl } from '@/lib/launch-recovery-inspection';
import { LaunchInspectionStoredError } from '@/lib/launch-recovery-inspection-server';
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

const inspectionReference = {
  source: 'pump' as const,
  reviewKind: 'create' as const,
  id: 'review-id',
  projectId: 'project-id',
  mint: '11111111111111111111111111111111',
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-10-01T00:01:00.000Z',
};
it('dispatches exact inspection only with the authenticated owner and original immutable reference', async () => {
  m.inspect.mockResolvedValue({ inspection: true });
  const req = new Request(
    'https://bundle.test' + launchRecoveryInspectionUrl(inspectionReference),
  );
  const r = await GET(req);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(m.inspect).toHaveBeenCalledWith(
    undefined,
    'alice',
    inspectionReference,
    req.signal,
  );
  expect(m.read).not.toHaveBeenCalled();
});
it('authenticates inspection before parsing or database access', async () => {
  m.user = null;
  const r = await GET(request('?view=inspection&owner=bob'));
  expect(r.status).toBe(401);
  expect(m.db).not.toHaveBeenCalled();
  expect(m.inspect).not.toHaveBeenCalled();
});
it.each(['&id=other', '&owner=bob', '&cursor=bad', '&view=inspection'])(
  'rejects additional/duplicate inspection query %s before DBaccess',
  async (suffix) => {
    const req = new Request(
      'https://bundle.test' +
        launchRecoveryInspectionUrl(inspectionReference) +
        suffix,
    );
    expect((await GET(req)).status).toBe(400);
    expect(m.db).not.toHaveBeenCalled();
    expect(m.inspect).not.toHaveBeenCalled();
    expect(m.read).not.toHaveBeenCalled();
  },
);
it.each([404, 409, 503])(
  'uses fixed no-store inspection refusal %s',
  async (status) => {
    m.inspect.mockRejectedValue(new LaunchInspectionStoredError(status));
    const r = await GET(
      new Request(
        'https://bundle.test' +
          launchRecoveryInspectionUrl(inspectionReference),
      ),
    );
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).not.toContain('SELECT');
  },
);

it('keeps unexpected inspection failures generic and specific to inspection', async () => {
  m.inspect.mockRejectedValue(Error('SECRET_SQL'));
  const r = await GET(
    new Request(
      'https://bundle.test' + launchRecoveryInspectionUrl(inspectionReference),
    ),
  );
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({
    error:
      'Saved launch inspection is unavailable. Keep the original reference and try again manually.',
  });
});
