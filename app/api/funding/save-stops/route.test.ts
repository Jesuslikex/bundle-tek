import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import {
  fundingOwnerScope,
  FUNDING_OWNER_SCOPE_HEADER,
} from '@/lib/funding-owner-scope';
import { createFundingSaveReminder } from '@/lib/funding-save-reminder';
import {
  readFundingSaveStopReceipt,
  type FundingSaveStopRequest,
  type FundingSaveStopReceipt,
} from '@/lib/funding-save-stop';
import { validateFunding } from '@/lib/funding-plan';
const auth = vi.hoisted(() => ({
  owner: 'alice' as string | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (auth.owner ? { userId: auth.owner } : null),
}));
vi.mock('@/db', () => ({ getD1: () => auth.db }));
import { GET, POST } from './route';
import { GET as fundingGET, POST as fundingPOST } from '../route';
import { retainFundingSaveStop } from '@/lib/funding-save-stop-storage';
let client: Client;
const url = 'http://localhost/api/funding/save-stops';
const body = (response: Response) =>
  response.json() as Promise<{
    receipt: FundingSaveStopReceipt;
    code?: string;
  }>;
const document = () =>
  validateFunding({
    name: 'Treasury draft',
    chain: 'Solana',
    currency: 'SOL',
    source: 'Manual',
    sourceLabel: 'Treasury',
    funderAddress: '',
    startAt: new Date(Date.now() + 60_000).toISOString(),
    delaySeconds: 0,
    recipients: [
      { address: 'So11111111111111111111111111111111111111112', amount: '0.1' },
    ],
  });
const headers = () => ({
  origin: 'http://localhost',
  'content-type': 'application/json',
  [FUNDING_OWNER_SCOPE_HEADER]: fundingOwnerScope(auth.owner ?? 'alice'),
});
const post = (value: unknown, extra: Record<string, string> = {}) =>
  POST(
    new Request(url, {
      method: 'POST',
      headers: { ...headers(), ...extra },
      body: JSON.stringify(value),
    }),
  );
const get = (id: string, extra = '') =>
  GET(new Request(url + '?stopId=' + id + extra, { headers: headers() }));
async function stop(
  expectedRevision = 0,
  id = 'draft-a',
  stopId = 'stop-a',
): Promise<FundingSaveStopRequest> {
  return {
    format: 'funding-save-stop-request-v1',
    stopId,
    reminder: await createFundingSaveReminder(fundingOwnerScope('alice'), {
      id,
      action: 'save',
      expectedRevision,
      document: document(),
    }),
    consent: 'stop-draft-save-v1',
  };
}
const save = (id: string, expectedRevision = 0, doc = document()) =>
  fundingPOST(
    new Request('http://localhost/api/funding', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        action: 'save',
        id,
        expectedRevision,
        document: doc,
      }),
    }),
  );
const read = (id: string, revision?: number) =>
  fundingGET(
    new Request(
      'http://localhost/api/funding?id=' +
        id +
        (revision === undefined ? '' : '&expectedRevision=' + revision),
      { headers: headers() },
    ),
  );
beforeEach(async () => {
  auth.owner = 'alice';
  client = createClient({ url: 'file::memory:' });
  auth.db = createTursoDatabase(client);
  await client.executeMultiple(
    readFileSync('drizzle/0007_superb_iron_monger.sql', 'utf8'),
  );
  for (const statement of readFileSync(
    'drizzle/0152_funding_save_stops.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await client.execute(statement);
});
afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

it('requires sign-in for stop writes and exact receipt reads', async () => {
  const request = await stop();
  auth.owner = null;
  expect((await post(request)).status).toBe(401);
  expect((await get(request.stopId)).status).toBe(401);
  expect(
    (await client.execute('SELECT count(*) AS n FROM funding_save_stops'))
      .rows[0].n,
  ).toBe(0);
});
it.each(['http://elsewhere.test', 'null', ''])(
  'requires explicit same-origin approval (%s)',
  async (origin) => {
    expect((await post(await stop(), { origin })).status).toBe(403);
  },
);
it.each(['text/plain', 'application/jsonp', 'application/json-malformed'])(
  'refuses non-JSON %s',
  async (type) => {
    expect((await post(await stop(), { 'content-type': type })).status).toBe(
      415,
    );
  },
);
it('requires captured owner scope in header and body independently', async () => {
  const request = await stop();
  expect(
    (await post(request, { [FUNDING_OWNER_SCOPE_HEADER]: '' })).status,
  ).toBe(403);
  request.reminder.ownerScope = fundingOwnerScope('bob');
  expect((await post(request)).status).toBe(403);
  expect((await get('stop-a', '&stopId=stop-b')).status).toBe(400);
});
it.each([null, [], {}, { extra: true }])(
  'refuses incomplete approval %#',
  async (value) => {
    expect((await post(value)).status).toBe(400);
  },
);
it('bounds actual request bytes and rejects extra authority fields', async () => {
  const request = await stop();
  expect((await post({ ...request, note: 'x'.repeat(3000) })).status).toBe(400);
  expect((await post({ ...request, signingAuthorized: true })).status).toBe(
    400,
  );
  expect((await post({ ...request, consent: false })).status).toBe(400);
});
it('fences an absent creation, returns a strict immutable receipt, and rejects the delayed original POST', async () => {
  const request = await stop();
  const response = await post(request);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get(FUNDING_OWNER_SCOPE_HEADER)).toBe(
    fundingOwnerScope('alice'),
  );
  const receipt = await readFundingSaveStopReceipt(
    (await body(response)).receipt,
    request,
  );
  expect(receipt).toMatchObject({
    outcome: 'creation_fenced',
    beforeRevision: null,
    afterRevision: null,
    transfersCancelled: false,
    signingAuthorized: false,
  });
  expect((await save('draft-a')).status).toBe(409);
  expect(
    (await client.execute('SELECT count(*) AS n FROM funding_plans')).rows[0].n,
  ).toBe(0);
  expect(
    (await client.execute('SELECT count(*) AS n FROM funding_events')).rows[0]
      .n,
  ).toBe(0);
  expect((await read('draft-a')).status).toBe(409);
  expect((await read('draft-a', 0)).status).toBe(409);
  expect((await read('draft-a', 1)).status).toBe(404);
  expect((await body(await get('stop-a'))).receipt).toEqual(receipt);
});
it('recovers a lost stop reply with GET only, exact replay keeps one receipt', async () => {
  const request = await stop();
  await post(request);
  const first = await (await get(request.stopId)).json();
  const again = await (await post(request)).json();
  expect(again).toEqual(first);
  expect(
    (await client.execute('SELECT count(*) AS n FROM funding_save_stops'))
      .rows[0].n,
  ).toBe(1);
});
it('never leaks another owner receipt or applies a captured first-owner request to a second account', async () => {
  const request = await stop();
  await post(request);
  auth.owner = 'bob';
  expect((await get(request.stopId)).status).toBe(404);
  expect((await post(request)).status).toBe(403);
  expect((await read('draft-a')).status).toBe(404);
});
it('makes a no-op revision bump explicit rather than confirming the original save', async () => {
  const doc = document();
  await save('draft-a', 0, doc);
  const request = await stop(1);
  request.reminder = await createFundingSaveReminder(
    fundingOwnerScope('alice'),
    { action: 'save', id: 'draft-a', expectedRevision: 1, document: doc },
  );
  const response = await post(request);
  expect(response.status).toBe(200);
  expect((await body(response)).receipt.outcome).toBe('revision_advanced');
  const legacy = await read('draft-a');
  expect(legacy.status).toBe(409);
  const current = await read('draft-a', 1);
  expect(current.status).toBe(409);
  expect((await body(current)).code).toBe('FUNDING_SAVE_STOPPED');
  expect((await save('draft-a', 1, doc)).status).toBe(409);
  const later = await save('draft-a', 2, doc);
  expect(later.status).toBe(200);
  expect((await read('draft-a', 2)).status).toBe(200);
  expect((await read('draft-a')).status).toBe(409);
  expect(
    (await client.execute('SELECT count(*) AS n FROM funding_events')).rows[0]
      .n,
  ).toBe(2);
});
it('does not claim which competing save won when the revision was already advanced', async () => {
  await save('draft-a');
  const request = await stop(0);
  const response = await post(request);
  expect(response.status).toBe(200);
  expect((await body(response)).receipt).toMatchObject({
    outcome: 'already_advanced',
    beforeRevision: 1,
    afterRevision: 1,
  });
  expect(
    (await client.execute('SELECT revision FROM funding_plans')).rows[0]
      .revision,
  ).toBe(1);
});

it('keeps a committed original batch unknown when a different device stops its already-advanced revision before a lost worker reply', async () => {
  const request = await stop();
  const real = auth.db;
  auth.db = {
    prepare: real.prepare.bind(real),
    async batch(statements: D1PreparedStatement[]) {
      await real.batch(statements);
      const receipt = await retainFundingSaveStop(
        real,
        'alice',
        request,
        new AbortController().signal,
      );
      expect(receipt.outcome).toBe('already_advanced');
      throw Error('Synthetic worker reply loss after commit');
    },
  } as unknown as D1Database;
  const response = await save('draft-a');
  expect(response.status).toBe(503);
  expect(
    (await client.execute('SELECT revision FROM funding_plans')).rows[0]
      .revision,
  ).toBe(1);
  const recovery = await read('draft-a', 0);
  expect(recovery.status).toBe(409);
  expect((await body(recovery)).receipt.outcome).toBe('already_advanced');
  expect(
    (await client.execute('SELECT count(*) AS n FROM funding_events')).rows[0]
      .n,
  ).toBe(1);
});
it('keeps stop recovery available with a corrupt funding document', async () => {
  await save('draft-a');
  await client.execute(
    "UPDATE funding_plans SET document='corrupt' WHERE id='draft-a'",
  );
  const request = await stop(1);
  expect((await post(request)).status).toBe(200);
  expect((await get('stop-a')).status).toBe(200);
  expect((await read('draft-a', 1)).status).toBe(409);
  expect((await read('draft-a', 2)).status).toBe(503);
});
it('does not pretend 404 is terminal proof and rejects future unreachable revisions', async () => {
  expect((await get('missing')).status).toBe(404);
  expect((await post(await stop(1))).status).toBe(409);
  expect((await read('draft-a', 0)).status).toBe(404);
});
it('rejects changed stop identities without replacing immutable receipts', async () => {
  const request = await stop();
  await post(request);
  expect(
    (
      await post({
        ...request,
        reminder: { ...request.reminder, documentHash: 'b'.repeat(64) },
      })
    ).status,
  ).toBe(409);
  expect((await post({ ...request, stopId: 'different-stop' })).status).toBe(
    409,
  );
});
it.each([
  '?stopId=../bad',
  '?stopId=a&stopId=b',
  '?stopId=a&extra=1',
  '?stopId=',
])('rejects malformed exact stop query %s', async (query) => {
  expect(
    (await GET(new Request(url + query, { headers: headers() }))).status,
  ).toBe(400);
});
it.each(['-1', '1.0', '01', '1000000001', 'NaN'])(
  'rejects malformed original revision %s',
  async (revision) => {
    expect(
      (
        await fundingGET(
          new Request(
            'http://localhost/api/funding?id=draft-a&expectedRevision=' +
              revision,
            { headers: headers() },
          ),
        )
      ).status,
    ).toBe(400);
  },
);
it('returns 408 for an already-aborted stop without storing a receipt', async () => {
  const request = await stop();
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await POST(
        new Request(url, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(request),
          signal: controller.signal,
        }),
      )
    ).status,
  ).toBe(408);
  expect(
    (await client.execute('SELECT count(*) AS n FROM funding_save_stops'))
      .rows[0].n,
  ).toBe(0);
});
