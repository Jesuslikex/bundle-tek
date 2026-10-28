import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  db: vi.fn(),
  prepare: vi.fn(),
  approve: vi.fn(),
  parse: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: mocks.user }));
vi.mock('@/db', () => ({ getD1: mocks.db }));
vi.mock('@/lib/pair-order-first-service', () => ({
  pairOrderFirstRequest: mocks.parse,
  prepareOwnedPairOrderFirstReview: mocks.prepare,
  approveOwnedPairOrderFirstReview: mocks.approve,
}));
import { ImportedPairQuoteError } from '@/lib/imported-pair-quote-service';
import { PairOrderQuoteBoundsError } from '@/lib/pair-order-quote-bounds';
import { pairReviewDiagnostic } from '@/lib/pair-review-diagnostic';
import { POST } from './route';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ userId: 'alice' });
  mocks.db.mockReturnValue({});
  mocks.parse.mockImplementation((x) => x);
  mocks.prepare.mockResolvedValue({
    id: 'review',
    review: { signingAllowed: false },
  });
  mocks.approve.mockRejectedValue(
    new ImportedPairQuoteError('Stock signing is disabled.'),
  );
});
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://bundle.test/api/imported-projects/pair-order-reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
it('returns 401 before reads for anonymous requests', async () => {
  mocks.user.mockResolvedValue(null);
  const r = await POST(request({}));
  expect(r.status).toBe(401);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('passes only server-owned user identity and request signal to preparation', async () => {
  const r = await POST(
    request({ action: 'prepare', request: { id: 'project' } }),
  );
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(mocks.prepare).toHaveBeenCalledWith(
    {},
    'alice',
    { id: 'project' },
    expect.any(AbortSignal),
  );
});
it('keeps explicit consent separate and returns the disabled signing refusal', async () => {
  const consent = { approveExactOrder: true };
  const r = await POST(request({ action: 'approve', id: 'review', consent }));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: 'Stock signing is disabled.' });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.approve).toHaveBeenCalledWith(
    {},
    'alice',
    'review',
    consent,
    expect.any(Number),
    expect.any(AbortSignal),
  );
});
it.each([
  { action: 'prepare', request: {}, qualified: true },
  { action: 'approve', id: 'review', consent: {}, signingAllowed: true },
  { action: 'send' },
])('rejects extra fields and unsupported actions', async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('keeps a tagged minimum failure on approval generic, without implying a preparation outcome', async () => {
  mocks.approve.mockRejectedValue(
    pairReviewDiagnostic(
      new PairOrderQuoteBoundsError('SECRET_DO_NOT_EXPOSE'),
      'minimum-output',
    ),
  );
  const r = await POST(
    request({ action: 'approve', id: 'review', consent: {} }),
  );
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({
    error:
      'Order review unavailable or changed. Request a new review. No signature or submission was made.',
  });
});
it('rejects cross-origin, non-JSON, oversized and malformed bodies', async () => {
  expect(
    (await POST(request({}, { origin: 'https://other.test' }))).status,
  ).toBe(403);
  expect(
    (await POST(request({}, { 'content-type': 'text/plain' }))).status,
  ).toBe(415);
  expect((await POST(request({ padding: 'x'.repeat(4096) }))).status).toBe(413);
  const req = request({});
  Object.defineProperty(req, 'body', {
    value: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([0xff]));
        c.close();
      },
    }),
  });
  expect((await POST(req)).status).toBe(400);
});
it('preserves backoff without exposing provider errors', async () => {
  mocks.prepare.mockRejectedValue(new ImportedPairQuoteError('Wait.', 429));
  const r = await POST(request({ action: 'prepare', request: {} }));
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBe('15');
});
it.each(['strict', 'fresh-reference'])(
  'returns a fixed actionable refusal for a %s minimum failure without leaking diagnostics',
  async (mode) => {
    const error = pairReviewDiagnostic(
      new PairOrderQuoteBoundsError('SECRET_DO_NOT_EXPOSE'),
      'minimum-output',
      { mode, secret: 'SECRET_DO_NOT_EXPOSE' },
    );
    mocks.prepare.mockRejectedValue(error);
    const r = await POST(request({ action: 'prepare', request: {} }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      error:
        'The order minimum is below the required quote bound. Request a fresh quote; no signature or submission was made.',
    });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.approve).not.toHaveBeenCalled();
  },
);
it.each([
  new PairOrderQuoteBoundsError('SECRET_DO_NOT_EXPOSE'),
  pairReviewDiagnostic(
    new PairOrderQuoteBoundsError('SECRET_DO_NOT_EXPOSE'),
    'different-check',
  ),
])(
  'keeps other bounds failures generic without exposing their text',
  async (error) => {
    mocks.prepare.mockRejectedValue(error);
    const r = await POST(request({ action: 'prepare', request: {} }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      error:
        'Order review unavailable or changed. Request a new review. No signature or submission was made.',
    });
  },
);
it('reports the server signing flag only as a display hint on preparation', async () => {
  vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', 'true');
  const on = await POST(request({ action: 'prepare', request: { id: 'p' } }));
  expect(
    ((await on.json()) as { stockSigningEnabled: boolean }).stockSigningEnabled,
  ).toBe(true);
  vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', 'yes');
  const off = await POST(request({ action: 'prepare', request: { id: 'p' } }));
  expect(
    ((await off.json()) as { stockSigningEnabled: boolean })
      .stockSigningEnabled,
  ).toBe(false);
  vi.unstubAllEnvs();
});
it('routes signed registration, one-attempt submission and recovery only with exact keys', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const body of [
    { action: 'register', authorizationId: id },
    { action: 'register', authorizationId: id, signedPacket: 'x', extra: 1 },
    { action: 'submit', authorizationId: id },
    { action: 'recover', authorizationId: id, consent: {} },
    { action: 'send', authorizationId: id },
  ]) {
    const r = await POST(request(body));
    expect(r.status).toBe(400);
  }
  mocks.db.mockReturnValue({
    prepare: () => ({
      bind: () => ({ first: async () => null }),
    }),
  });
  vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', '');
  for (const body of [
    { action: 'register', authorizationId: id, signedPacket: 'x' },
    { action: 'submit', authorizationId: id, consent: {} },
  ]) {
    const r = await POST(request(body));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/disabled/);
  }
  const recovered = await POST(
    request({ action: 'recover', authorizationId: id }),
  );
  expect(recovered.status).toBe(404);
  vi.unstubAllEnvs();
});
