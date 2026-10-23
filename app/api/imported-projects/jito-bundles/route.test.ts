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
