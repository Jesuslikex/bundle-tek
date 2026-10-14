import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { generateKeyPairSigner } from '@solana/kit';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  prepare: vi.fn(async (..._args: unknown[]) => ({ state: 'review' })),
  approve: vi.fn(async (..._args: unknown[]) => ({ state: 'approved' })),
  register: vi.fn(async (..._args: unknown[]) => ({ state: 'signed' })),
  submit: vi.fn(async (..._args: unknown[]) => ({ state: 'submitted' })),
  recover: vi.fn(async (..._args: unknown[]) => ({ state: 'finalized' })),
  cancel: vi.fn(async (..._args: unknown[]) => ({ state: 'cancelled' })),
  list: vi.fn(async (_db: unknown, owner: string, project: string) =>
    owner === 'alice' && project === 'p1' ? [{ state: 'review' }] : [],
  ),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pump-holder-review-service', () => ({
  preparePumpHolderReview: mocks.prepare,
  approvePumpHolderReview: mocks.approve,
  registerPumpHolderSignedPacket: mocks.register,
  listPumpHolderReviews: mocks.list,
}));
vi.mock('@/lib/pump-holder-execution', () => ({
  submitPumpHolderReview: mocks.submit,
  recoverPumpHolderReview: mocks.recover,
  cancelPumpHolderReview: mocks.cancel,
}));
import { GET, POST } from './route';
let client: Client, wallets: string[];
const origin = 'https://bundle.test',
  id = '00000000-0000-4000-8000-000000000001';
const consent = {
  approved: true,
  reviewId: id,
  sha256: 'a'.repeat(64),
  contextSha256: 'b'.repeat(64),
  approvedScope: 'create-developer-and-holder-buys',
  acknowledgeSimulationLimits: true,
};
const prepare = () => ({
  action: 'prepare',
  projectId: 'p1',
  updatedAt: '2026-10-14T00:00:00Z',
  releaseId: 'a'.repeat(64),
  payer: wallets[0],
  payerRevision: 1,
  mint: wallets[1],
  feeAndRentLimitRaw: '10000000',
  developerMaximumQuoteCostRaw: '100000000',
  holderLimits: [
    {
      address: wallets[2],
      feeAndRentLimitRaw: '10000000',
      maximumQuoteCostRaw: '100000000',
    },
    { address: wallets[3], feeAndRentLimitRaw: '0' },
  ],
});
const send = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(origin + '/api/launch/pump/holders', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
beforeAll(async () => {
  wallets = await Promise.all(
    Array.from(
      { length: 4 },
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
    "INSERT INTO workspace_projects VALUES('alice','p1',0),('alice','p2',0),('bob','p1',0)",
  );
  await client.execute({
    sql: "INSERT INTO pump_launch_reviews VALUES('alice',?,'p1',?)",
    args: [id, JSON.stringify({ format: 'pump-create-holders-review-v1' })],
  });
});
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  for (const value of Object.values(mocks))
    if (vi.isMockFunction(value)) value.mockClear();
  await client.execute('DELETE FROM imported_token_project_gates');
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  client.close();
});

it('requires authentication and makes every response non-cacheable', async () => {
  mocks.user = null;
  const get = await GET(
      new Request(origin + '/api/launch/pump/holders?projectId=p1'),
    ),
    post = await send(prepare());
  expect(get.status).toBe(401);
  expect(post.status).toBe(401);
  expect(get.headers.get('cache-control')).toBe('no-store');
  expect(post.headers.get('cache-control')).toBe('no-store');
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.list).not.toHaveBeenCalled();
});
it('reads only authenticated owner/project history', async () => {
  const response = await GET(
    new Request(origin + '/api/launch/pump/holders?projectId=p1'),
  );
  expect(await response.json()).toEqual({ launches: [{ state: 'review' }] });
  expect(mocks.list).toHaveBeenCalledWith(mocks.db, 'alice', 'p1');
  expect(
    (await GET(new Request(origin + '/api/launch/pump/holders'))).status,
  ).toBe(400);
  mocks.user = { userId: 'bob' };
  expect(
    await (
      await GET(new Request(origin + '/api/launch/pump/holders?projectId=p1'))
    ).json(),
  ).toEqual({ launches: [] });
});
it('rejects foreign origins and non-JSON before any service action', async () => {
  expect((await send(prepare(), { origin: 'https://evil.test' })).status).toBe(
    403,
  );
  expect((await send(prepare(), { 'content-type': 'text/plain' })).status).toBe(
    415,
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('injects only server identity and origin and preserves exact per-wallet raw limits', async () => {
  expect((await send(prepare())).status).toBe(200);
  const { action: _action, ...terms } = prepare();
  expect(mocks.prepare.mock.calls[0].slice(0, 3)).toEqual([
    mocks.db,
    'alice',
    { ...terms, origin },
  ]);
  expect(mocks.prepare.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
});
it('rejects target/source/owner overrides and malformed raw amounts before RPC services', async () => {
  const patches: Record<string, unknown>[] = [
    { origin: 'https://other.test' },
    { ownerId: 'bob' },
    { tokenAmountRaw: '1' },
    { observations: {} },
    { payer: wallets[1] },
    { payer: '11111111111111111111111111111111' },
    { payerRevision: 0 },
    { feeAndRentLimitRaw: '1000000001' },
    { developerMaximumQuoteCostRaw: '18446744073709551616' },
    {
      holderLimits: [
        {
          address: wallets[2],
          feeAndRentLimitRaw: '10000000',
          maximumQuoteCostRaw: 100000000,
        },
      ],
    },
    {
      holderLimits: [
        {
          address: wallets[2],
          feeAndRentLimitRaw: '0',
          maximumQuoteCostRaw: '1',
        },
      ],
    },
    {
      holderLimits: [
        {
          address: wallets[2],
          feeAndRentLimitRaw: '1',
          maximumQuoteCostRaw: '1',
          minimumTokenOutputRaw: '1',
        },
      ],
    },
    {
      holderLimits: [
        {
          address: wallets[2],
          feeAndRentLimitRaw: '1',
          maximumQuoteCostRaw: '01',
        },
      ],
    },
    {
      holderLimits: [
        {
          address: wallets[0],
          feeAndRentLimitRaw: '1',
          maximumQuoteCostRaw: '1',
        },
      ],
    },
    { holderLimits: [] },
  ];
  for (const patch of patches)
    expect((await send({ ...prepare(), ...patch })).status).toBe(400);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it('accepts exact quote-input minima while rejecting floats and excessive slot lists', async () => {
  const body = prepare();
  body.holderLimits = [
    {
      address: wallets[2],
      feeAndRentLimitRaw: '10000000',
      minimumTokenOutputRaw: '1000000',
    } as (typeof body.holderLimits)[number],
  ];
  expect((await send(body)).status).toBe(200);
  expect(
    (
      await send({
        ...prepare(),
        holderLimits: Array(201).fill(prepare().holderLimits[0]),
      })
    ).status,
  ).toBe(400);
  expect(
    (await send({ ...prepare(), developerMaximumQuoteCostRaw: '1.25' })).status,
  ).toBe(400);
});
it('routes separate approval, registration, broadcast consent, recovery and cancellation', async () => {
  for (const [action, expected] of [
    ['approve', 'approved'],
    ['register', 'signed'],
    ['submit', 'submitted'],
    ['recover', 'finalized'],
    ['cancel', 'cancelled'],
  ]) {
    const body = {
      action,
      id,
      ...(['approve', 'register', 'submit'].includes(action)
        ? { consent }
        : {}),
      ...(action === 'register' ? { transaction: 'AAAA' } : {}),
      ...(action === 'submit' ? { submitApproved: true } : {}),
    };
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: expected });
  }
  expect(mocks.submit.mock.calls[0].slice(1, 4)).toEqual([
    'alice',
    id,
    { consent, submitApproved: true },
  ]);
  expect(mocks.register.mock.calls[0].slice(1, 5)).toEqual([
    'alice',
    id,
    consent,
    'AAAA',
  ]);
});
it('requires exact context/scope and a distinct broadcast approval', async () => {
  for (const action of [['approve'], { action: 'approve' }, 1])
    expect((await send({ action, id, consent })).status).toBe(400);
  for (const patch of [
    { approved: false },
    { reviewId: 'other' },
    { contextSha256: 'wrong' },
    { approvedScope: 'create-only' },
    { acknowledgeSimulationLimits: false },
  ])
    expect(
      (await send({ action: 'approve', id, consent: { ...consent, ...patch } }))
        .status,
    ).toBe(400);
  for (const submitApproved of [false, undefined, 'true'])
    expect(
      (await send({ action: 'submit', id, consent, submitApproved })).status,
    ).toBe(400);
  expect(
    (await send({ action: 'recover', id, transaction: 'AAAA' })).status,
  ).toBe(400);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
});
it('does not allow foreign or missing review IDs to reach services', async () => {
  expect(
    (
      await send({
        action: 'recover',
        id: '00000000-0000-4000-8000-000000000002',
      })
    ).status,
  ).toBe(404);
  mocks.user = { userId: 'bob' };
  expect((await send({ action: 'recover', id })).status).toBe(404);
  expect(mocks.recover).not.toHaveBeenCalled();
  expect((await send({ ...prepare(), projectId: 'p2' })).status).toBe(404);
});
it('isolates rate limits by owner, project and action and preserves read access', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000000);
  expect((await send(prepare())).status).toBe(200);
  const limited = await send(prepare());
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('5');
  expect((await send({ ...prepare(), projectId: 'p2' })).status).toBe(200);
  expect((await send({ action: 'approve', id, consent })).status).toBe(200);
  expect(
    (await GET(new Request(origin + '/api/launch/pump/holders?projectId=p1')))
      .status,
  ).toBe(200);
  mocks.user = { userId: 'bob' };
  expect((await send(prepare())).status).toBe(200);
  expect(mocks.prepare).toHaveBeenCalledTimes(3);
});
it('enforces streamed byte bounds and does not expose parser/provider text', async () => {
  const large = await POST(
    new Request(origin + '/api/launch/pump/holders', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'content-length': '1',
      },
      body: ' '.repeat(65537),
    }),
  );
  expect(large.status).toBe(413);
  const malformed = await POST(
    new Request(origin + '/api/launch/pump/holders', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '<html>provider error</html>',
    }),
  );
  expect(malformed.status).toBe(400);
  expect(JSON.stringify(await malformed.json())).not.toContain('<html>');
  mocks.prepare.mockRejectedValueOnce(new Error('private upstream URL'));
  const unavailable = await send(prepare());
  expect(unavailable.status).toBe(502);
  expect(JSON.stringify(await unavailable.json())).not.toContain(
    'private upstream',
  );
});
it('retains known domain error status without assuming an approval succeeded', async () => {
  mocks.prepare.mockRejectedValueOnce(
    new PumpPreflightError(
      'Holder reservation migration is not installed.',
      503,
    ),
  );
  const response = await send(prepare());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Holder reservation migration is not installed.',
  });
});
