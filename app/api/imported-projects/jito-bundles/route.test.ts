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
  begin: vi.fn(),
  readAttempt: vi.fn(),
  listAttempts: vi.fn(),
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
  observeJitoBundleWithObservation: mocks.recover,
}));
vi.mock('@/lib/jito-sign-attempt-server', () => ({
  beginJitoSignAttempt: mocks.begin,
  readJitoSignAttempt: mocks.readAttempt,
  listJitoSignAttempts: mocks.listAttempts,
  registerJitoSignAttempt: mocks.register,
}));
vi.mock('@/lib/jito-sequential-check-server', () => ({
  checkJitoBundleSequential: mocks.sequentialCheck,
}));
vi.mock('@/lib/jito-bundle-preparation', () => ({
  prepareJitoBundle: mocks.prepare,
}));
vi.mock('../signing/route', () => ({ POST: mocks.approvalRecover }));
import { GET, POST } from './route';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
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
it('loads an exact bundle only within the verified owner, project and session', async () => {
  const scope = await jitoOwnerScope('owner');
  const bound: unknown[][] = [];
  let bundleOwned = true;
  mocks.database.mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      bound.push(args);
      return {
        first: async () =>
          sql.includes('FROM jito_bundle_protocol')
            ? null
            : sql.includes('FROM imported_trade_sessions')
              ? { id }
              : bundleOwned
                ? { id }
                : null,
      };
    },
  }));
  mocks.read.mockResolvedValue({ record: { manifest: { id } } });
  const url = `http://localhost/api/imported-projects/jito-bundles?projectId=${id}&sessionId=${id}&bundleId=${id}`;
  const result = await GET(
    new Request(url, { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } }),
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    projectId: id,
    sessionId: id,
    bundle: { manifest: { id } },
  });
  expect(bound).toEqual([
    ['owner', id, id],
    ['owner', id, id, id],
    ['owner', id],
  ]);
  expect(mocks.read).toHaveBeenCalledOnce();
  mocks.read.mockClear();
  bundleOwned = false;
  expect(
    (
      await GET(
        new Request(url, { headers: { [JITO_OWNER_SCOPE_HEADER]: scope } }),
      )
    ).status,
  ).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(
    (
      await GET(
        new Request(url, {
          headers: { [JITO_OWNER_SCOPE_HEADER]: await jitoOwnerScope('other') },
        }),
      )
    ).status,
  ).toBe(409);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(
    (
      await GET(
        new Request(url.replace(`bundleId=${id}`, 'bundleId=bad'), {
          headers: { [JITO_OWNER_SCOPE_HEADER]: scope },
        }),
      )
    ).status,
  ).toBe(400);
});
it('marks a legacy bundle read-only for the owned v2 client', async () => {
  const scope = await jitoOwnerScope('owner');
  mocks.database.mockImplementation((sql: string) => ({
    bind: () => ({
      first: async () => (sql.includes('jito_bundle_protocol') ? null : { id }),
    }),
  }));
  mocks.read.mockResolvedValue({ record: { manifest: { id } } });
  mocks.listAttempts.mockResolvedValue([]);
  const response = await GET(
    new Request(
      `http://localhost/api/imported-projects/jito-bundles?projectId=${id}&sessionId=${id}&bundleId=${id}`,
      { headers: { [JITO_OWNER_SCOPE_HEADER]: scope, 'x-jito-protocol': '2' } },
    ),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    legacyReadOnly: true,
    attempts: [],
  });
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
it('requires v2, the current account scope and separate approval for a signing reservation', async () => {
  const scope = await jitoOwnerScope('owner');
  const body = {
    action: 'begin-signing',
    id,
    sha256: 'ab'.repeat(32),
    packet: 0,
    attemptId: id,
    approved: true,
  };
  expect((await POST(request(body, { 'x-jito-protocol': '2' }))).status).toBe(
    400,
  );
  expect(
    (await POST(request(body, { [JITO_OWNER_SCOPE_HEADER]: scope }))).status,
  ).toBe(409);
  expect(
    (
      await POST(
        request(
          { ...body, approved: false },
          { [JITO_OWNER_SCOPE_HEADER]: scope, 'x-jito-protocol': '2' },
        ),
      )
    ).status,
  ).toBe(400);
  expect(mocks.begin).not.toHaveBeenCalled();
  mocks.begin.mockResolvedValue({
    attempt: { state: 'unknown' },
    mayInvokeSigner: true,
  });
  const response = await POST(
    request(body, { [JITO_OWNER_SCOPE_HEADER]: scope, 'x-jito-protocol': '2' }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    attempt: { state: 'unknown' },
    mayInvokeSigner: true,
  });
  expect(mocks.begin.mock.calls[0][1]).toBe('owner');
});
it('refuses an old client registration before the signer result reaches the writer', async () => {
  const scope = await jitoOwnerScope('owner');
  const response = await POST(
    request(
      {
        action: 'register',
        id,
        sha256: 'ab'.repeat(32),
        packet: 0,
        transaction: 'fixture',
        approved: true,
      },
      { [JITO_OWNER_SCOPE_HEADER]: scope },
    ),
  );
  expect(response.status).toBe(400);
  expect(mocks.register).not.toHaveBeenCalled();
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
  const scope = await jitoOwnerScope('owner');
  expect(
    (
      await POST(
        request(
          {
            action: 'register',
            id,
            sha256: 'ab'.repeat(32),
            approved: true,
            packet: 0,
            transaction: 'fixture',
            attemptId: id,
          },
          { [JITO_OWNER_SCOPE_HEADER]: scope, 'x-jito-protocol': '2' },
        ),
      )
    ).status,
  ).toBe(200);
  expect(mocks.register.mock.calls[0][1]).toBe('owner');
});
it('returns only the verified account scope header on authenticated responses', async () => {
  const scope = await jitoOwnerScope('owner');
  const invalid = await GET(
    new Request('http://localhost/api/imported-projects/jito-bundles'),
  );
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get(JITO_OWNER_SCOPE_HEADER)).toBe(scope);
  expect(invalid.headers.get(JITO_OWNER_SCOPE_HEADER)).not.toContain('owner');
  mocks.register.mockResolvedValue({ state: 'reviewed' });
  const response = await POST(
    request(
      {
        action: 'register',
        id,
        sha256: 'ab'.repeat(32),
        approved: true,
        packet: 0,
        transaction: 'fixture',
        attemptId: id,
      },
      { [JITO_OWNER_SCOPE_HEADER]: scope, 'x-jito-protocol': '2' },
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get(JITO_OWNER_SCOPE_HEADER)).toBe(scope);
  expect(await response.json()).toEqual({ bundle: { state: 'reviewed' } });
  expect(mocks.register).toHaveBeenCalledOnce();
});
it('rejects another owner scope before history, action or rate-gate database access', async () => {
  const originalScope = await jitoOwnerScope('owner');
  mocks.user = { userId: 'another-owner' };
  const otherScope = await jitoOwnerScope('another-owner');
  const headers = { [JITO_OWNER_SCOPE_HEADER]: originalScope };
  const history = await GET(
    new Request(
      `http://localhost/api/imported-projects/jito-bundles?projectId=${id}&sessionId=${id}`,
      { headers },
    ),
  );
  expect(history.status).toBe(409);
  expect(history.headers.get(JITO_OWNER_SCOPE_HEADER)).toBe(otherScope);
  for (const action of [
    'prepare',
    'create',
    'register',
    'submit',
    'recover',
    'cancel',
    'check-sequential',
  ]) {
    const response = await POST(
      request(
        {
          action,
          id,
          projectId: id,
          sessionId: id,
          sessionRevision: 1,
          sha256: 'ab'.repeat(32),
          approved: true,
        },
        headers,
      ),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get(JITO_OWNER_SCOPE_HEADER)).toBe(otherScope);
  }
  expect(mocks.database).not.toHaveBeenCalled();
  for (const handler of [
    mocks.prepare,
    mocks.create,
    mocks.register,
    mocks.submit,
    mocks.recover,
    mocks.cancel,
    mocks.sequentialCheck,
  ])
    expect(handler).not.toHaveBeenCalled();
});
it.each(['', 'x', 'A'.repeat(64), '0'.repeat(64) + ', ' + '0'.repeat(64)])(
  'rejects a malformed requested scope %j before provider or database work',
  async (scope) => {
    const response = await POST(
      request({ action: 'submit', id }, { [JITO_OWNER_SCOPE_HEADER]: scope }),
    );
    expect(response.status).toBe(409);
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  },
);
it('does not return an account scope when signed out', async () => {
  mocks.user = null;
  const response = await GET(
    new Request('http://localhost/api/imported-projects/jito-bundles'),
  );
  expect(response.status).toBe(401);
  expect(response.headers.has(JITO_OWNER_SCOPE_HEADER)).toBe(false);
});
it('fails closed for invalid authenticated identity without touching the database', async () => {
  mocks.user = { userId: '\ud800' };
  const response = await GET(
    new Request('http://localhost/api/imported-projects/jito-bundles'),
  );
  expect(response.status).toBe(503);
  expect(response.headers.has(JITO_OWNER_SCOPE_HEADER)).toBe(false);
  expect(mocks.database).not.toHaveBeenCalled();
});
it('rate-limits provider work and leaves retained recovery state intact on failures', async () => {
  mocks.database.mockImplementation(() => ({
    bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }),
  }));
  expect(
    (
      await POST(
        request(
          {
            action: 'submit',
            id,
            sha256: 'ab'.repeat(32),
            approved: true,
          },
          { 'x-jito-protocol': '2' },
        ),
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
      return { record: { state: 'submitted' }, observation: null };
    },
  );
  expect((await POST(request({ action: 'recover', id }))).status).toBe(200);
  const recoveryRequest = mocks.approvalRecover.mock.calls[0][0] as Request;
  expect(await recoveryRequest.json()).toEqual({ action: 'recover', id });
});

it('returns a provider observation only on the explicitly requested recovery response', async () => {
  const observation = { format: 'jito-chain-observation-v1', packets: [] };
  mocks.recover.mockResolvedValue({
    record: { state: 'submitting' },
    observation,
  });
  const response = await POST(request({ action: 'recover', id }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    bundle: { state: 'submitting' },
    chainObservation: observation,
  });
  expect(mocks.recover).toHaveBeenCalledOnce();
  expect(mocks.submit).not.toHaveBeenCalled();
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
