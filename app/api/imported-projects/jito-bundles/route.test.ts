import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  prepare: vi.fn(),
  create: vi.fn(),
  register: vi.fn(),
  submit: vi.fn(),
  recover: vi.fn(),
  cancel: vi.fn(),
  read: vi.fn(),
  database: vi.fn(),
  approvalRecover: vi.fn(),
  sequentialCheck: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => ({ prepare: mocks.database }) }));
vi.mock('@/lib/jito-bundle-server', () => ({
  createJitoBundle: mocks.create,
  readJitoBundle: mocks.read,
  registerJitoPacket: mocks.register,
  submitJitoBundle: mocks.submit,
  cancelJitoBundle: mocks.cancel,
  observeJitoBundle: mocks.recover,
}));
vi.mock('@/lib/jito-sequential-check-server', () => ({
  checkJitoBundleSequential: mocks.sequentialCheck,
}));
vi.mock('@/lib/jito-bundle-preparation', () => ({
  prepareJitoBundle: mocks.prepare,
}));
vi.mock('../signing/route', () => ({ POST: mocks.approvalRecover }));
import { GET, POST } from './route';
const id = '11111111-1111-4111-8111-111111111111';
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/imported-projects/jito-bundles', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { userId: 'owner' };
  mocks.database.mockImplementation(() => ({
    bind: () => ({
      first: async () => null,
      run: async () => ({ meta: { changes: 1 } }),
    }),
  }));
});
it('requires authentication, JSON, origin and explicit action-time approval before signing registration or submission', async () => {
  mocks.user = null;
  expect((await POST(request({ action: 'submit', id }))).status).toBe(401);
  expect(
    (
      await GET(
        new Request(
          `http://localhost/api/imported-projects/jito-bundles?projectId=${id}&sessionId=${id}`,
        ),
      )
    ).status,
  ).toBe(401);
  mocks.user = { userId: 'owner' };
  expect(
    (await POST(request({}, { origin: 'https://unrelated.test' }))).status,
  ).toBe(403);
  expect(
    (await POST(request({}, { 'content-type': 'text/plain' }))).status,
  ).toBe(415);
  for (const action of ['register', 'submit']) {
    expect(
      (await POST(request({ action, id, sha256: 'ab'.repeat(32) }))).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({ action, id, sha256: 'ab'.repeat(32), approved: 'true' }),
        )
      ).status,
    ).toBe(400);
  }
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
});
it('bounds payloads and does not expose a raw arbitrary relay method', async () => {
  expect((await POST(request({ action: 'sendTransaction', id }))).status).toBe(
    400,
  );
  expect(
    (
      await POST(
        request({ action: 'submit', id, transaction: 'x'.repeat(5000) }),
      )
    ).status,
  ).toBe(413);
  expect(mocks.submit).not.toHaveBeenCalled();
});
it('counts UTF-8 request bytes and stops a stream at the limit before database access', async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++;
        c.enqueue(new TextEncoder().encode('"' + '€'.repeat(1400)));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const result = await POST(
    new Request('http://localhost/api/imported-projects/jito-bundles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit),
  );
  expect(result.status).toBe(413);
  expect(pulls).toBe(1);
  expect(cancel).toHaveBeenCalledOnce();
  expect(mocks.database).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
});
it('cancels a stalled request body without provider or database work', async () => {
  const controller = new AbortController(),
    cancel = vi.fn();
  const pending = POST(
    new Request('http://localhost/api/imported-projects/jito-bundles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({ cancel }),
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit),
  );
  await Promise.resolve();
  controller.abort();
  expect((await pending).status).toBe(408);
  expect(cancel).toHaveBeenCalledOnce();
  expect(mocks.database).not.toHaveBeenCalled();
});
it('scopes history and mutations to the signed-in owner and saved session', async () => {
  expect(
    (
      await GET(
        new Request(
          `http://localhost/api/imported-projects/jito-bundles?projectId=${id}&sessionId=${id}`,
        ),
      )
    ).status,
  ).toBe(404);
  mocks.register.mockResolvedValue({ state: 'reviewed' });
  expect(
    (
      await POST(
        request({
          action: 'register',
          id,
          sha256: 'ab'.repeat(32),
          approved: true,
          packet: 0,
          transaction: 'fixture',
        }),
      )
    ).status,
  ).toBe(200);
  expect(mocks.register.mock.calls[0][1]).toBe('owner');
});
it('rate-limits provider work and leaves retained recovery state intact on failures', async () => {
  mocks.database.mockImplementation(() => ({
    bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }),
  }));
  expect(
    (
      await POST(
        request({
          action: 'submit',
          id,
          sha256: 'ab'.repeat(32),
          approved: true,
        }),
      )
    ).status,
  ).toBe(429);
  expect(mocks.submit).not.toHaveBeenCalled();
});
it('forwards finalized receipt evidence to bundle recovery instead of reducing it to a boolean', async () => {
  const receipt = {
    projectId: id,
    preparationId: id,
    document: { slot: 300, signature: 'public-signature' },
  };
  mocks.approvalRecover
    .mockResolvedValueOnce(Response.json({ state: 'finalized', receipt }))
    .mockResolvedValueOnce(Response.json({ state: 'failed', receipt }))
    .mockResolvedValueOnce(
      Response.json({ state: 'finalized', receipt }, { status: 503 }),
    );
  mocks.recover.mockImplementation(
    async (
      _db: unknown,
      _owner: string,
      _id: string,
      _signal: AbortSignal,
      callback: (id: string) => Promise<unknown>,
    ) => {
      expect(await callback(id)).toEqual(receipt);
      expect(await callback(id)).toBeNull();
      expect(await callback(id)).toBeNull();
      return { state: 'submitted' };
    },
  );
  expect((await POST(request({ action: 'recover', id }))).status).toBe(200);
  const recoveryRequest = mocks.approvalRecover.mock.calls[0][0] as Request;
  expect(await recoveryRequest.json()).toEqual({ action: 'recover', id });
});

it('exposes an explicit owner-scoped sequential read without signing or submission approval', async () => {
  const result = {
    format: 'jito-sequential-check-v1',
    signingAllowed: false,
    executionAllowed: false,
  };
  mocks.sequentialCheck.mockResolvedValue(result);
  const response = await POST(
    request({
      action: 'check-sequential',
      id,
      sha256: 'ab'.repeat(32),
      owner: 'other',
      transaction: 'never-forward',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sequentialCheck: result });
  expect(mocks.sequentialCheck).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ prepare: mocks.database }),
    'owner',
    { id, sha256: 'ab'.repeat(32) },
    expect.any(AbortSignal),
  );
  for (const fn of [
    mocks.prepare,
    mocks.create,
    mocks.register,
    mocks.submit,
    mocks.recover,
    mocks.approvalRecover,
  ])
    expect(fn).not.toHaveBeenCalled();
});
it('requires auth, same origin and JSON for a sequential diagnostic', async () => {
  const body = { action: 'check-sequential', id, sha256: 'ab'.repeat(32) };
  mocks.user = null;
  expect((await POST(request(body))).status).toBe(401);
  mocks.user = { userId: 'owner' };
  expect(
    (await POST(request(body, { origin: 'https://other.invalid' }))).status,
  ).toBe(403);
  expect(
    (await POST(request(body, { 'content-type': 'text/plain' }))).status,
  ).toBe(415);
  expect(mocks.sequentialCheck).not.toHaveBeenCalled();
});
it.each([undefined, ['ab'.repeat(32)], 'AB'.repeat(32), 'x'])(
  'rejects a noncanonical sequential-check digest %j before provider work',
  async (sha256) => {
    expect(
      (await POST(request({ action: 'check-sequential', id, sha256 }))).status,
    ).toBe(400);
    expect(mocks.sequentialCheck).not.toHaveBeenCalled();
  },
);
it('applies the existing 15-second owner rate gate to sequential reads', async () => {
  mocks.database.mockImplementation(() => ({
    bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }),
  }));
  const response = await POST(
    request({ action: 'check-sequential', id, sha256: 'ab'.repeat(32) }),
  );
  expect(response.status).toBe(429);
  expect(mocks.sequentialCheck).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
});
it('returns fixed context errors and hides raw provider failures for sequential reads', async () => {
  mocks.sequentialCheck.mockRejectedValueOnce(
    Error('Sequential check context changed or unavailable.'),
  );
  let response = await POST(
    request({ action: 'check-sequential', id, sha256: 'ab'.repeat(32) }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'Sequential check context changed or unavailable.',
  });
  mocks.sequentialCheck.mockRejectedValueOnce(
    Error('https://private.invalid/?key=FAKE_SEQUENCE_SECRET'),
  );
  response = await POST(
    request({ action: 'check-sequential', id, sha256: 'ab'.repeat(32) }),
  );
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).not.toContain(
    'FAKE_SEQUENCE_SECRET',
  );
  expect(mocks.submit).not.toHaveBeenCalled();
});
