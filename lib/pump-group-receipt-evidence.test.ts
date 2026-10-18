import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '../db/turso';
import { pumpGroupChainEffectsFixture } from '../test/pump-group-chain-effects-fixture';
import { pumpGroupPaymentFixture } from '../test/pump-group-payment-fixture';
import { validatedAccountLaunchEvidence } from './account-launch-evidence';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import {
  collectPumpGroupReceiptEvidence,
  parsePumpGroupReceiptEvidence,
} from './pump-group-receipt-evidence';
import {
  readOwnedPumpGroupReceiptEvidence,
  retainOwnedPumpGroupReceiptEvidence,
} from './pump-group-receipt-evidence-service';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { inspectPumpQuoteMint } from './pump-launch-config';
import { decodePumpSigningInput } from './pump-launch-signing';
const httpContext = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  rpc: null as PumpLaunchRpc | null,
  endpoint: vi.fn(() => 'https://controlled-fixture.example'),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => httpContext.user,
}));
vi.mock('@/db', () => ({ getD1: () => httpContext.db }));
vi.mock('@/lib/solana-rpc', async (original) => ({
  ...(await original<typeof import('./solana-rpc')>()),
  getSolanaIndexerRpcEndpoint: httpContext.endpoint,
}));
vi.mock('@/lib/wallet-balances', async (original) => ({
  ...(await original<typeof import('./wallet-balances')>()),
  balanceRpc: (
    _endpoint: string,
    method: string,
    params: unknown[],
    s: AbortSignal,
  ) => httpContext.rpc!(method, params, s),
}));
import { GET, POST } from '../app/api/account-launch-activity/evidence/route';

let f: Awaited<ReturnType<typeof pumpGroupChainEffectsFixture>>;
beforeAll(async () => {
  f = await pumpGroupChainEffectsFixture();
}, 120000);
const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  httpContext.user = { userId: 'alice' };
  httpContext.endpoint.mockClear();
});
const signal = () => new AbortController().signal;
const collect = (rpc: PumpLaunchRpc = f.rpc) =>
  collectPumpGroupReceiptEvidence(f.group, signal(), rpc);
async function database() {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  await client.execute(
    'CREATE TABLE pump_launch_reviews(id TEXT PRIMARY KEY,owner_id TEXT,review TEXT,signed TEXT,signature TEXT,state TEXT)',
  );
  await client.execute(
    'CREATE TABLE pump_group_signatures(review_id TEXT,owner_id TEXT,context_sha256 TEXT,manifest_sha256 TEXT,signed_group_sha256 TEXT,signed TEXT,signature TEXT)',
  );
  await client.execute(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  );
  for (const sql of readFileSync(
    'drizzle/0113_pump_group_receipt_evidence.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await client.execute(sql);
  await client.execute({
    sql: 'INSERT INTO pump_launch_reviews VALUES(?,?,?,?,?,?)',
    args: [
      f.review.id,
      'alice',
      canonicalPumpHolderJson(f.review),
      canonicalPumpHolderJson(f.signed),
      f.signed.packets[0].signature,
      'signed',
    ],
  });
  await client.execute({
    sql: 'INSERT INTO pump_group_signatures VALUES(?,?,?,?,?,?,?)',
    args: [
      f.review.id,
      'alice',
      f.review.contextSha256,
      f.review.manifestSha256,
      f.signed.signedGroupSha256,
      canonicalPumpHolderJson(f.signed),
      f.signed.packets[0].signature,
    ],
  });
  return { client, db: createTursoDatabase(client) };
}
const id = () => crypto.randomUUID();
async function rehash(e: Awaited<ReturnType<typeof collect>>) {
  const { sha256: _sha256, ...body } = e;
  e.sha256 = await pumpHolderDigest(body);
  return e;
}
it('retains exact detached finalized metadata, strips provider extras and replays with no provider', async () => {
  const rpc = vi.fn<PumpLaunchRpc>(async (method, params, s) => {
    const value = await f.rpc(method, params, s);
    return method === 'getTransaction'
      ? {
          ...(value as object),
          providerDebug: 'not retained',
          meta: {
            ...(value as { meta: object }).meta,
            logMessages: ['not retained'],
            innerInstructions: [],
          },
        }
      : value;
  });
  const e = await collect(rpc);
  expect(rpc.mock.calls.filter((c) => c[0] === 'getTransaction')).toHaveLength(
    f.signed.packets.length,
  );
  expect(JSON.stringify(e)).not.toContain('not retained');
  expect(e.receipts[0]?.meta).toHaveProperty('innerInstructions', []);
  expect(
    await parsePumpGroupReceiptEvidence(
      JSON.parse(JSON.stringify(e)),
      f.group,
      signal(),
    ),
  ).toEqual(e);
  expect(e).toMatchObject({
    acquisitionBasisVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    reservationsChanged: false,
  });
});
it('preserves successful packets in a partial snapshot and refuses an entirely missing observation', async () => {
  const e = await collect(async (m, p, s) =>
    m === 'getTransaction' && p[0] === f.signed.packets[1].signature
      ? null
      : f.rpc(m, p, s),
  );
  expect(e.report.complete).toBe(false);
  expect(e.report.packets[1].outcome).toBe('not-observed');
  expect(e.report.packets.some((p) => p.outcome === 'success')).toBe(true);
  expect(await parsePumpGroupReceiptEvidence(e, f.group, signal())).toEqual(e);
  await expect(
    collect(async (m, p, s) =>
      m === 'getTransaction' ? null : f.rpc(m, p, s),
    ),
  ).rejects.toThrow('No finalized');
});

it('preserves token-quote units and incomplete metadata without certifying acquisition basis', async () => {
  const stock = await pumpGroupChainEffectsFixture(true);
  const e = await collectPumpGroupReceiptEvidence(
    stock.group,
    signal(),
    stock.rpc,
  );
  expect(e.report.quoteMint).toBe(stock.review.input.create.quoteMint);
  expect(e.report.quoteDecimals).toBe(
    inspectPumpQuoteMint(
      decodePumpSigningInput(stock.review.input.create).quoteMintAccount!,
    ).decimals,
  );
  expect(e.report.wallets.some((w) => w.knownQuoteDeltaRaw !== '0')).toBe(true);
  expect(await parsePumpGroupReceiptEvidence(e, stock.group, signal())).toEqual(
    e,
  );
  const partial = await collect(async (m, p, s) => {
    const v = await f.rpc(m, p, s);
    if (m === 'getTransaction')
      delete (v as { meta: Record<string, unknown> }).meta.preBalances;
    return v;
  });
  expect(partial.report.complete).toBe(false);
  expect(partial.acquisitionBasisVerified).toBe(false);
  expect(
    await parsePumpGroupReceiptEvidence(partial, f.group, signal()),
  ).toEqual(partial);
});
it('rejects self-rehashed altered receipt bytes, metadata and displayed aggregates', async () => {
  const original = await collect();
  for (const change of [
    (e: typeof original) => {
      (e.receipts[0]!.transaction as string[])[0] =
        f.signed.packets[1].transaction;
    },
    (e: typeof original) => {
      (e.receipts[0]!.meta as { postBalances: string[] }).postBalances[0] = '0';
    },
    (e: typeof original) => {
      e.report.wallets[0].knownTokenDeltaRaw = '1';
    },
  ]) {
    const e = structuredClone(original);
    change(e);
    await rehash(e);
    await expect(
      parsePumpGroupReceiptEvidence(e, f.group, signal()),
    ).rejects.toThrow();
  }
});
it('rejects authority escalation, unknown envelope fields, oversized metadata and cancelled reads', async () => {
  const original = await collect();
  await expect(
    parsePumpGroupReceiptEvidence(
      { ...original, executionAllowed: true },
      f.group,
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    parsePumpGroupReceiptEvidence(
      { ...original, extra: true },
      f.group,
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    collect(async (m, p, s) => {
      const v = await f.rpc(m, p, s);
      if (m === 'getTransaction')
        (v as { meta: Record<string, unknown> }).meta.innerInstructions = [
          'x'.repeat(2097152),
        ];
      return v;
    }),
  ).rejects.toThrow('storage limit');
  const controller = new AbortController();
  controller.abort();
  const rpc = vi.fn(f.rpc);
  await expect(
    collectPumpGroupReceiptEvidence(f.group, controller.signal, rpc),
  ).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it('persists real verified receipts in SQLite, reloads independently and retries without a provider read', async () => {
  const { client, db } = await database(),
    requestId = id(),
    rpc = vi.fn(f.rpc);
  const empty = await readOwnedPumpGroupReceiptEvidence(
    db,
    'alice',
    f.review.id,
    signal(),
  );
  expect(empty.entry).toBeNull();
  const saved = await retainOwnedPumpGroupReceiptEvidence(
    db,
    'alice',
    f.review.id,
    requestId,
    signal(),
    rpc,
  );
  expect(saved.entry?.id).toBe(requestId);
  expect(saved.entry?.successfulPackets).toBe(f.signed.packets.length);
  expect(saved.entry?.acquisitionBasisVerified).toBe(false);
  expect(JSON.stringify(saved)).not.toContain(f.signed.packets[0].transaction);
  const never = vi.fn<PumpLaunchRpc>(async () => {
    throw new Error('No provider allowed for replay');
  });
  expect(
    await retainOwnedPumpGroupReceiptEvidence(
      db,
      'alice',
      f.review.id,
      requestId,
      signal(),
      never,
    ),
  ).toEqual(saved);
  expect(
    await readOwnedPumpGroupReceiptEvidence(db, 'alice', f.review.id, signal()),
  ).toEqual(saved);
  expect(never).not.toHaveBeenCalled();
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM pump_group_receipt_evidence',
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    client.execute(
      'UPDATE pump_group_receipt_evidence SET created_at=created_at',
    ),
  ).rejects.toThrow('immutable');
  await expect(
    client.execute('DELETE FROM pump_group_receipt_evidence'),
  ).rejects.toThrow('immutable');
  await expect(
    readOwnedPumpGroupReceiptEvidence(db, 'bob', f.review.id, signal()),
  ).rejects.toThrow('not found');
});
it('guards pacing, concurrent request identity and changed parent before persistence', async () => {
  const { client, db } = await database(),
    requestId = id();
  const results = await Promise.allSettled([
    retainOwnedPumpGroupReceiptEvidence(
      db,
      'alice',
      f.review.id,
      requestId,
      signal(),
      f.rpc,
    ),
    retainOwnedPumpGroupReceiptEvidence(
      db,
      'alice',
      f.review.id,
      requestId,
      signal(),
      f.rpc,
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM pump_group_receipt_evidence',
      )
    ).rows[0].n,
  ).toBe(1);
  const rpc = vi.fn(f.rpc);
  await expect(
    retainOwnedPumpGroupReceiptEvidence(
      db,
      'alice',
      f.review.id,
      id(),
      signal(),
      rpc,
    ),
  ).rejects.toThrow('5 seconds');
  expect(rpc).not.toHaveBeenCalled();
  await client.execute('DELETE FROM imported_token_project_gates');
  let mutated = false;
  await expect(
    retainOwnedPumpGroupReceiptEvidence(
      db,
      'alice',
      f.review.id,
      id(),
      signal(),
      async (m, p, s) => {
        const r = await f.rpc(m, p, s);
        if (m === 'getTransaction' && !mutated) {
          mutated = true;
          await client.execute(
            "UPDATE pump_launch_reviews SET state='different'",
          );
        }
        return r;
      },
    ),
  ).rejects.toThrow('changed');
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM pump_group_receipt_evidence',
      )
    ).rows[0].n,
  ).toBe(1);
});
it('SQL admission refuses foreign ownership, mismatched packets, permission changes and missing installation', async () => {
  const { client, db } = await database();
  const saved = await retainOwnedPumpGroupReceiptEvidence(
    db,
    'alice',
    f.review.id,
    id(),
    signal(),
    f.rpc,
  );
  const row = (
    await client.execute('SELECT * FROM pump_group_receipt_evidence')
  ).rows[0];
  const encodedEvidence = row.evidence;
  if (typeof encodedEvidence !== 'string')
    throw new Error('Expected retained JSON evidence.');
  for (const changes of [
    { owner_id: 'bob' },
    { context_sha256: '0'.repeat(64) },
    {
      evidence: JSON.stringify({
        ...JSON.parse(encodedEvidence),
        executionAllowed: true,
      }),
    },
    {
      evidence: JSON.stringify(
        (() => {
          const e = JSON.parse(encodedEvidence);
          e.receipts[0].transaction[0] = f.signed.packets[1].transaction;
          return e;
        })(),
      ),
    },
  ]) {
    const altered = { ...row, id: id(), ...changes };
    await expect(
      client.execute({
        sql: `INSERT INTO pump_group_receipt_evidence(${Object.keys(altered).join(',')}) VALUES(${Object.keys(
          altered,
        )
          .map(() => '?')
          .join(',')})`,
        args: Object.values(altered),
      }),
    ).rejects.toThrow();
  }
  expect(saved.entry).not.toBeNull();
  await client.execute('DROP TRIGGER pump_group_receipt_evidence_insert');
  const rpc = vi.fn(f.rpc);
  await expect(
    retainOwnedPumpGroupReceiptEvidence(
      db,
      'alice',
      f.review.id,
      id(),
      signal(),
      rpc,
    ),
  ).rejects.toThrow('not installed');
  expect(rpc).not.toHaveBeenCalled();
});

it('runs the real HTTP route through owner-scoped SQL and cryptographic receipt replay without any submission', async () => {
  const { client, db } = await database();
  httpContext.db = db;
  const rpc = vi.fn(f.rpc);
  httpContext.rpc = rpc;
  const requestId = id(),
    url = 'https://bundle.example/api/account-launch-activity/evidence';
  const post = (body: unknown) =>
    POST(
      new Request(url, {
        method: 'POST',
        headers: {
          origin: 'https://bundle.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );
  const saved = await post({ reviewId: f.review.id, requestId });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const value = await saved.json();
  expect((value as { entry: { id: string } }).entry.id).toBe(requestId);
  expect(
    rpc.mock.calls.every(([method]) =>
      ['getGenesisHash', 'getTransaction'].includes(method),
    ),
  ).toBe(true);
  rpc.mockClear();
  httpContext.endpoint.mockClear();
  expect(
    await (await GET(new Request(url + '?reviewId=' + f.review.id))).json(),
  ).toEqual(value);
  expect(
    await (await post({ reviewId: f.review.id, requestId })).json(),
  ).toEqual(value);
  expect(rpc).not.toHaveBeenCalled();
  expect(httpContext.endpoint).not.toHaveBeenCalled();
  expect(
    (await post({ reviewId: f.review.id, requestId, receipts: [] })).status,
  ).toBe(400);
  httpContext.user = { userId: 'bob' };
  expect(
    (await GET(new Request(url + '?reviewId=' + f.review.id))).status,
  ).toBe(404);
  expect(
    (
      await client.execute(
        'SELECT count(*) AS n FROM pump_group_receipt_evidence',
      )
    ).rows[0].n,
  ).toBe(1);
});

it('derives and reloads reconciled payments through the real saved-evidence route without altering the immutable source', async () => {
  const fixture = await pumpGroupPaymentFixture(false, 'create', f),
    { client, db } = await database();
  httpContext.db = db;
  const rpc = vi.fn(fixture.rpc);
  httpContext.rpc = rpc;
  const url = 'https://bundle.example/api/account-launch-activity/evidence',
    requestId = id();
  const saved = await POST(
    new Request(url, {
      method: 'POST',
      headers: {
        origin: 'https://bundle.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reviewId: f.review.id, requestId }),
    }),
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  const value = validatedAccountLaunchEvidence(await saved.json(), {
    reviewId: f.review.id,
    mint: f.review.input.create.mint,
  });
  expect(value.entry?.payments).toMatchObject({
    complete: true,
    purchaseQuoteSubtotalRaw: '18000',
    accountFundingSubtotalLamports: '70500000',
    acquisitionBasisVerified: false,
    executionAllowed: false,
  });
  const stored = (
    await client.execute(
      'SELECT evidence,sha256 FROM pump_group_receipt_evidence',
    )
  ).rows[0];
  if (typeof stored.evidence !== 'string' || typeof stored.sha256 !== 'string')
    throw new Error('Expected immutable JSON evidence and its hash.');
  expect(stored.sha256).toBe(value.entry?.sha256);
  expect(stored.evidence).not.toContain('pump-group-payments-v1');
  rpc.mockClear();
  httpContext.endpoint.mockClear();
  expect(
    await (await GET(new Request(url + '?reviewId=' + f.review.id))).json(),
  ).toEqual(value);
  expect(rpc).not.toHaveBeenCalled();
  expect(httpContext.endpoint).not.toHaveBeenCalled();
  expect(
    (
      await client.execute(
        'SELECT evidence,sha256 FROM pump_group_receipt_evidence',
      )
    ).rows[0],
  ).toEqual(stored);
});
