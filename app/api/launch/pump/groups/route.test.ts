import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { generateKeyPairSigner } from '@solana/kit';
import type { PumpLaunchRpc } from '@/lib/pump-launch-simulation';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  endpoint: 'https://rpc.example.test',
  prepare: vi.fn(async (..._args: unknown[]) => ({
    state: 'review',
    signingAllowed: false,
  })),
  approve: vi.fn(async (..._args: unknown[]) => ({ state: 'approved' })),
  register: vi.fn(async (..._args: unknown[]) => ({ state: 'signed' })),
  cancel: vi.fn(async (..._args: unknown[]) => ({ state: 'cancelled' })),
  refresh: vi.fn(async (..._args: unknown[]) => ({ sourceRevalidated: true })),
  runtime: vi.fn(async (..._args: unknown[]) => ({ signingAllowed: false })),
  authorize: vi.fn(async (..._args: unknown[]) => ({
    signingAllowed: true,
    submissionAllowed: false,
  })),
  recover: vi.fn(async (..._args: unknown[]) => ({ released: false })),
  observe: vi.fn(async (..._args: unknown[]) => ({ state: 'partial' })),
  list: vi.fn(async (..._args: unknown[]) => ({
    launches: [],
    nextCursor: null,
  })),
  read: vi.fn(async (..._args: unknown[]) => ({ state: 'review' })),
  observations: vi.fn(async (..._args: unknown[]) => ({
    observations: [],
    nextPosition: null,
  })),
  rpc: vi.fn(async (..._args: unknown[]) => ({})),
  broadcastRead: vi.fn(async (..._args: unknown[]) => null),
  broadcastPrepare: vi.fn(async (..._args: unknown[]) => ({
    attempted: false,
  })),
  broadcastTip: vi.fn(async (..._args: unknown[]) => ({ tip: {} })),
  broadcastSubmit: vi.fn(async (..._args: unknown[]) => ({ attempted: true })),
  broadcastRecover: vi.fn(async (..._args: unknown[]) => ({
    group: {},
    broadcast: {},
  })),
}));
vi.mock('@/lib/pump-group-broadcast-service', () => ({
  readOwnedPumpGroupBroadcast: mocks.broadcastRead,
  prepareOwnedPumpGroupBroadcast: mocks.broadcastPrepare,
  registerOwnedPumpGroupTip: mocks.broadcastTip,
  submitOwnedPumpGroupBroadcast: mocks.broadcastSubmit,
}));
vi.mock('@/lib/pump-group-broadcast-recovery', () => ({
  recoverOwnedPumpGroupBroadcast: mocks.broadcastRecover,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pump-launch-group-review-service', () => ({
  preparePumpLaunchGroupReview: mocks.prepare,
  approvePumpLaunchGroupReview: mocks.approve,
  registerPumpLaunchGroupSignatures: mocks.register,
  cancelUnsignedPumpLaunchGroupReview: mocks.cancel,
  refreshPumpLaunchGroupReview: mocks.refresh,
  listPumpLaunchGroupPage: mocks.list,
  readPumpLaunchGroupReview: mocks.read,
}));
vi.mock('@/lib/pump-launch-group-observation-service', () => ({
  collectOwnedPumpGroupObservation: mocks.observe,
  listOwnedPumpGroupObservations: mocks.observations,
}));
vi.mock('@/lib/pump-group-runtime-service', () => ({
  previewOwnedPumpGroupRuntime: mocks.runtime,
  authorizeOwnedPumpGroupSigning: mocks.authorize,
}));
vi.mock('@/lib/pump-launch-group-terminal-service', () => ({
  recoverOwnedPumpLaunchGroup: mocks.recover,
}));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: () => mocks.endpoint,
}));
vi.mock('@/lib/wallet-balances', () => ({ balanceRpc: mocks.rpc }));
import { GET, POST } from './route';
let client: Client, wallets: string[];
const origin = 'https://bundle.test',
  id = '11111111-1111-4111-8111-111111111111';
const consent = {
  approved: true,
  reviewId: id,
  manifestSha256: 'a'.repeat(64),
  contextSha256: 'b'.repeat(64),
  simulationSha256: 'c'.repeat(64),
  approvedScope: 'complete-create-developer-holder-packet-group',
  acknowledgeSimulationLimits: true,
};
const prepare = () => ({
  action: 'prepare',
  projectId: 'p1',
  updatedAt: '2026-10-15T00:00:00.000Z',
  releaseId: 'a'.repeat(64),
  payer: wallets[0],
  mint: wallets[1],
  payerRevision: 1,
  feeAndRentLimitRaw: '10000000',
  holderLimits: [{ address: wallets[2], feeAndRentLimitRaw: '0' }],
});
const send = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(origin + '/api/launch/pump/groups', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
beforeAll(async () => {
  wallets = await Promise.all(
    Array.from(
      { length: 3 },
      async () => (await generateKeyPairSigner()).address,
    ),
  );
  client = createClient({ url: 'file::memory:' });
  mocks.db = createTursoDatabase(client);
  for (const sql of [
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,archived INTEGER)',
    'CREATE TABLE pump_launch_reviews(owner_id TEXT,id TEXT,project_id TEXT,review TEXT)',
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  ])
    await client.execute(sql);
  await client.execute(
    "INSERT INTO workspace_projects VALUES('alice','p1',0),('alice','p2',0)",
  );
  await client.execute({
    sql: "INSERT INTO pump_launch_reviews VALUES('alice',?,'p1',?)",
    args: [id, JSON.stringify({ format: 'pump-launch-group-review-v1' })],
  });
});
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  mocks.endpoint = 'https://rpc.example.test';
  for (const x of Object.values(mocks)) if (vi.isMockFunction(x)) x.mockClear();
  await client.execute('DELETE FROM imported_token_project_gates');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => client.close());
it('authenticates GET/POST, enforces origin and content type, and never caches private responses', async () => {
  mocks.user = null;
  for (const r of [
    await GET(new Request(origin + '/?projectId=p1')),
    await send(prepare()),
  ]) {
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toBe('no-store');
  }
  mocks.user = { userId: 'alice' };
  expect((await send(prepare(), { origin: 'https://other.test' })).status).toBe(
    403,
  );
  expect((await send(prepare(), { 'content-type': 'text/plain' })).status).toBe(
    415,
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('injects only authenticated owner/site origin and routes all complete-group actions without submission', async () => {
  expect((await send(prepare())).status).toBe(200);
  expect(mocks.prepare.mock.calls[0][1]).toBe('alice');
  expect(mocks.prepare.mock.calls[0][2]).toMatchObject({
    origin,
    projectId: 'p1',
  });
  for (const [action, service] of [
    ['approve', mocks.approve],
    ['register', mocks.register],
    ['revalidate', mocks.refresh],
    ['observe', mocks.observe],
    ['recover', mocks.recover],
    ['runtime-preview', mocks.runtime],
    ['cancel', mocks.cancel],
  ] as const) {
    const body = {
      action,
      id,
      ...(['approve', 'register'].includes(action) ? { consent } : {}),
      ...(action === 'register' ? { transactions: ['AQ==', 'Ag=='] } : {}),
    };
    expect((await send(body)).status).toBe(200);
    expect(service.mock.calls[0].slice(0, 3)).toEqual([mocks.db, 'alice', id]);
  }
  expect(
    (await send({ action: 'submit', id, consent, submitApproved: true }))
      .status,
  ).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('routes explicit code-identity consent to owned short-lived signing authorization', async () => {
  const previewId = crypto.randomUUID();
  const codeConsent = {
    approved: true,
    previewId,
    identitySha256: 'd'.repeat(64),
    acknowledgeUpgradeableCode: true,
    acknowledgeNoSemanticAudit: true,
  };
  expect(
    (
      await send({
        action: 'authorize-signing',
        id,
        previewId,
        consent,
        codeConsent,
      })
    ).status,
  ).toBe(200);
  expect(mocks.authorize.mock.calls[0].slice(0, 6)).toEqual([
    mocks.db,
    'alice',
    id,
    previewId,
    consent,
    codeConsent,
  ]);
  expect(mocks.register).not.toHaveBeenCalled();
});
it('routes separate tip retention, one-attempt broadcast consent and read-only recovery with the authenticated owner', async () => {
  const broadcastId = crypto.randomUUID(),
    sha256 = 'd'.repeat(64),
    broadcastConsent = {
      approved: true,
      reviewId: id,
      broadcastId,
      broadcastSha256: sha256,
      signedGroupSha256: 'e'.repeat(64),
      scope: 'one-attempt-jito-complete-group-and-tip',
      acknowledgeUncertainOutcome: true,
    };
  const actions = [
    [{ action: 'broadcast-read', id }, mocks.broadcastRead],
    [
      {
        action: 'broadcast-prepare',
        id,
        tipRaw: '1000',
        tipFeeLimitRaw: '5000',
      },
      mocks.broadcastPrepare,
    ],
    [
      {
        action: 'broadcast-register-tip',
        id,
        broadcastId,
        sha256,
        transaction: 'AQ==',
      },
      mocks.broadcastTip,
    ],
    [
      { action: 'broadcast-submit', id, consent: broadcastConsent },
      mocks.broadcastSubmit,
    ],
    [{ action: 'broadcast-recover', id }, mocks.broadcastRecover],
  ] as const;
  for (const [body, service] of actions) {
    expect((await send(body)).status).toBe(200);
    expect(service.mock.calls[0].slice(0, 3)).toEqual([mocks.db, 'alice', id]);
  }
  expect(mocks.broadcastSubmit.mock.calls[0][3]).toEqual(broadcastConsent);
  expect((await send({ action: 'broadcast-read', id })).status).toBe(200);
  expect(
    (
      await send({
        action: 'broadcast-register-tip',
        id,
        broadcastId,
        sha256,
        transaction: 'AQ==',
      })
    ).status,
  ).toBe(200);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('rejects foreign owners/projects and malformed source/permission overrides before services', async () => {
  mocks.user = { userId: 'bob' };
  expect((await send({ action: 'observe', id })).status).toBe(404);
  expect((await send(prepare())).status).toBe(404);
  mocks.user = { userId: 'alice' };
  for (const patch of [
    { ownerId: 'bob' },
    { origin: 'other' },
    { rpcUrl: 'https://other.test' },
    { review: {} },
    { simulation: {} },
    { signingAllowed: true },
  ])
    expect((await send({ ...prepare(), ...patch })).status).toBe(400);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.observe).not.toHaveBeenCalled();
});
it('rate gates expensive actions by owner/project/action while retaining reads and registration retries', async () => {
  expect((await send({ action: 'observe', id })).status).toBe(200);
  const limited = await send({ action: 'observe', id });
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('5');
  expect((await send({ action: 'revalidate', id })).status).toBe(200);
  expect((await GET(new Request(origin + '/?id=' + id))).status).toBe(200);
  const body = { action: 'register', id, consent, transactions: ['AQ=='] };
  expect((await send(body)).status).toBe(200);
  expect((await send(body)).status).toBe(200);
});
it('keeps project/group/observation reads separate with server-bound pagination and owner', async () => {
  expect((await GET(new Request(origin + '/?projectId=p1'))).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith(mocks.db, 'alice', 'p1', {
    before: null,
  });
  expect(
    (await GET(new Request(origin + '/?id=' + id + '&observations=1'))).status,
  ).toBe(200);
  expect(mocks.observations).toHaveBeenCalledWith(mocks.db, 'alice', id, null);
  expect(
    (await GET(new Request(origin + '/?id=' + id + '&projectId=p1'))).status,
  ).toBe(400);
});
it('bounds streamed bytes, rejects invalid UTF8/JSON and honors cancellation before actions', async () => {
  const request = (body: BodyInit, signal?: AbortSignal) =>
    new Request(origin + '/', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body,
      signal,
    });
  expect((await POST(request('x'.repeat(65537)))).status).toBe(413);
  expect((await POST(request(new Uint8Array([255])))).status).toBe(400);
  expect((await POST(request('{'))).status).toBe(400);
  const control = new AbortController();
  control.abort();
  expect(
    (await POST(request(JSON.stringify(prepare()), control.signal))).status,
  ).toBe(408);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('sanitizes private provider/configuration errors and blocks transport mutation methods', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('secret provider URL'));
  const r = await send(prepare());
  expect(r.status).toBe(502);
  expect(JSON.stringify(await r.json())).not.toContain('secret');
  await client.execute('DELETE FROM imported_token_project_gates');
  mocks.endpoint = 'http://bad.example';
  expect((await send(prepare())).status).toBe(502);
  await client.execute('DELETE FROM imported_token_project_gates');
  mocks.endpoint = 'https://rpc.example.test';
  mocks.prepare.mockImplementationOnce(async (...args: unknown[]) => {
    await (args[4] as PumpLaunchRpc)(
      'sendTransaction',
      [],
      args[3] as AbortSignal,
    );
    return { state: 'review', signingAllowed: false };
  });
  expect((await send(prepare())).status).toBe(502);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('retains registration and unsigned cancellation without requiring a configured provider', async () => {
  mocks.endpoint = 'not-a-provider-url';
  expect(
    (await send({ action: 'register', id, consent, transactions: ['AQ=='] }))
      .status,
  ).toBe(200);
  expect((await send({ action: 'cancel', id })).status).toBe(200);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('bounds a stalled streamed body by its deadline before any action or provider read', async () => {
  const deadline = new AbortController(),
    cancelled = vi.fn();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(deadline.signal);
  const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
  const request = new Request(origin + '/', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  const pending = POST(request);
  await vi.waitFor(() => expect(timeout).toHaveBeenCalledWith(10000));
  deadline.abort();
  expect((await pending).status).toBe(408);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
