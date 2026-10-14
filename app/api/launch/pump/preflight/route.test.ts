import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pumpAccountBytes } from '@/lib/pump-launch-simulation';
import { raw } from '../../../../../test/pump-launch-simulation-fixture';
import type { PumpLaunchRpc } from '@/lib/pump-launch-simulation';
import { pumpInitialBuySimulationFixture } from '../../../../../test/pump-initial-buy-simulation-fixture';
import { releaseLaunchMetadata } from '@/lib/launch-metadata-release';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '@/lib/workspace-project';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  rpc: null as PumpLaunchRpc | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pump-launch-simulation', async (original) => {
  const actual =
    await original<typeof import('@/lib/pump-launch-simulation')>();
  return {
    ...actual,
    simulatePumpCreate: (
      ...args: Parameters<typeof actual.simulatePumpCreate>
    ) =>
      actual.simulatePumpCreate(
        args[0],
        args[1],
        args[2],
        args[3] ?? mocks.rpc!,
        args[4],
        args[5],
      ),
  };
});
vi.mock('@/lib/pump-initial-buy-simulation', async (original) => {
  const actual =
    await original<typeof import('@/lib/pump-initial-buy-simulation')>();
  return {
    ...actual,
    simulatePumpInitialBuy: (
      ...args: Parameters<typeof actual.simulatePumpInitialBuy>
    ) =>
      actual.simulatePumpInitialBuy(
        args[0],
        args[1],
        args[2],
        args[3] ?? mocks.rpc!,
        args[4],
        args[5],
      ),
  };
});
vi.mock('@/lib/pump-initial-buy-review', async (original) => {
  const actual =
    await original<typeof import('@/lib/pump-initial-buy-review')>();
  return {
    ...actual,
    preparePumpInitialBuyReview: (
      ...args: Parameters<typeof actual.preparePumpInitialBuyReview>
    ) =>
      actual.preparePumpInitialBuyReview(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4] ?? mocks.rpc!,
      ),
    actPumpInitialBuyReview: (
      ...args: Parameters<typeof actual.actPumpInitialBuyReview>
    ) =>
      actual.actPumpInitialBuyReview(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6] ?? mocks.rpc!,
      ),
  };
});
import { POST as atomicPOST, GET as atomicGET } from '../initial-buy/route';
import {
  getTransactionDecoder as atomicDecoder,
  getTransactionEncoder as atomicEncoder,
  getBase64Decoder as atomicBase64,
  type SignatureBytes as AtomicSignature,
} from '@solana/kit-v1';
import bs58 from 'bs58';
import {
  preparePumpInitialBuyReview,
  refreshPumpInitialBuyReview,
} from '@/lib/pump-initial-buy-review';
import { POST } from './route';
let mf: Miniflare,
  f: Awaited<ReturnType<typeof pumpInitialBuySimulationFixture>>,
  body: Record<string, unknown>,
  sequence = 0;
const origin = 'https://bundle.test',
  updatedAt = '2026-10-14T00:00:00.000Z';
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
    'base64',
  ),
);
const send = (value: unknown = body, headers: Record<string, string> = {}) =>
  POST(
    new Request(origin + '/api/launch/pump/preflight', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    }),
  );
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'pump-preflight-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'pump-preflight-local-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'pump-preflight-test',
  )) as unknown as D1Database;
  for (const sql of [
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE project_artwork(owner_id TEXT,id TEXT,data BLOB,mime TEXT,archived INTEGER DEFAULT 0,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,folder_id TEXT,folder_ids TEXT,PRIMARY KEY(owner_id,chain,address))',
    'CREATE TABLE wallet_folders(owner_id TEXT,id TEXT,chain TEXT,revision INTEGER,archived INTEGER,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
  ])
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../../../drizzle/0078_lush_rictor.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../../../drizzle/0079_real_justice.sql', import.meta.url),
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await mocks.db.prepare(sql).run();
}, 30000);
async function seed(stock = false, token22 = false) {
  mocks.user = { userId: 'alice' };
  f = await pumpInitialBuySimulationFixture(stock, token22);
  mocks.rpc = f.rpc;
  for (const table of [
    'solana_execution_reservations',
    'workspace_projects',
    'project_artwork',
    'workspace_wallets',
    'wallet_folders',
    'wallet_ownership_proofs',
    'imported_token_project_gates',
  ])
    await mocks.db.prepare('DELETE FROM ' + table).run();
  const projectId = 'pump-preflight-' + ++sequence,
    id = createHash('sha256').update(png).digest('hex');
  const doc = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: f.intent.name,
      ticker: f.intent.symbol,
      developerBuy: 0.1,
      ...(stock ? { currency: 'TSLAX', quoteAddress: f.intent.quoteMint } : {}),
    },
    identity: { ...EMPTY_IDENTITY, artworkUrl: '/api/artwork/' + id },
    options: {
      ...DEFAULT_VENUE_OPTIONS,
      wallets: {
        chain: 'Solana',
        deployer: {
          address: f.intent.payer,
          revision: 1,
          folderRevision: 0,
          root: true,
        },
        recipients: [],
      },
    },
  });
  await mocks.db
    .prepare(
      'INSERT INTO workspace_projects(owner_id,id,document,updated_at) VALUES(?,?,?,?)',
    )
    .bind('alice', projectId, JSON.stringify(doc), updatedAt)
    .run();
  await mocks.db
    .prepare(
      'INSERT INTO project_artwork(owner_id,id,data,mime) VALUES(?,?,?,?)',
    )
    .bind('alice', id, png, 'image/png')
    .run();
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .bind('alice', 'Solana', f.intent.payer, 1, 0, '', null)
    .run();
  await mocks.db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .bind('alice', 'Solana', f.intent.payer)
    .run();
  const release = await releaseLaunchMetadata(
    mocks.db,
    'alice',
    projectId,
    updatedAt,
    origin,
  );
  f.intent.uri = release.uri;
  f.setMetadataUri(release.uri);
  body = {
    projectId,
    updatedAt,
    releaseId: release.id,
    payer: f.intent.payer,
    payerRevision: 1,
    mint: f.intent.mint,
    feeAndRentLimitRaw: '10000000',
  };
}
beforeEach(() => seed());
afterAll(async () => {
  await mf?.dispose();
});
it('requires sign-in, same origin, strict bounded JSON and explicit fee/rent terms before RPC', async () => {
  mocks.user = null;
  expect((await send()).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect((await send(undefined, { origin: 'https://other.test' })).status).toBe(
    403,
  );
  expect((await send(undefined, { 'content-type': 'text/plain' })).status).toBe(
    415,
  );
  expect((await send({ ...body, owner: 'bob' })).status).toBe(400);
  expect((await send({ ...body, feeAndRentLimitRaw: 5000000 })).status).toBe(
    400,
  );
  expect((await send({ ...body, mint: body.payer })).status).toBe(400);
  expect((await send({ large: 'x'.repeat(2100) })).status).toBe(413);
  expect(f.calls).toHaveLength(0);
});
it('runs the real route, owned D1 reads, builder and RPC collector with no approval or broadcast', async () => {
  const response = await send();
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    format: string;
    executionAllowed: boolean;
    signingAllowed: boolean;
    completeLaunch: boolean;
    metadataUri: string;
    packet: { transaction: string };
    simulation: { payerDebitRaw: string };
  };
  expect(result).toMatchObject({
    format: 'pump-create-preflight-v1',
    executionAllowed: false,
    signingAllowed: false,
    completeLaunch: false,
    metadataUri: f.intent.uri,
    simulation: { payerDebitRaw: '3010000' },
  });
  expect(result.packet.transaction).toBeTruthy();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(f.calls.some((c) => c.method === 'simulateTransaction')).toBe(true);
  expect(
    f.calls.some((c) => ['sendTransaction', 'sendBundle'].includes(c.method)),
  ).toBe(false);
});
it('rejects another owner, watch-only payer and stale project version before RPC', async () => {
  mocks.user = { userId: 'bob' };
  expect((await send()).status).toBe(404);
  mocks.user = { userId: 'alice' };
  expect(
    (await send({ ...body, updatedAt: '2026-10-13T00:00:00.000Z' })).status,
  ).toBe(409);
  await mocks.db.prepare('DELETE FROM wallet_ownership_proofs').run();
  expect((await send()).status).toBe(404);
  expect(f.calls).toHaveLength(0);
});
it('requires the exact saved deployer revision and active folder', async () => {
  expect((await send({ ...body, payerRevision: 2 })).status).toBe(404);
  const row = await mocks.db
    .prepare('SELECT document FROM workspace_projects')
    .first<{ document: string }>();
  const doc = JSON.parse(row!.document);
  doc.options.wallets.deployer = {
    address: f.intent.payer,
    revision: 1,
    folderRevision: 2,
    folderId: 'folder-a',
  };
  await mocks.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(doc))
    .run();
  await mocks.db
    .prepare("UPDATE workspace_wallets SET folder_id='folder-a'")
    .run();
  await mocks.db
    .prepare('INSERT INTO wallet_folders VALUES(?,?,?,?,?)')
    .bind('alice', 'folder-a', 'Solana', 1, 0)
    .run();
  expect((await send()).status).toBe(409);
  expect(f.calls).toHaveLength(0);
});
it('isolates its rate gate from other wallet/project reads and returns a retry hint', async () => {
  await mocks.db
    .prepare('INSERT INTO imported_token_project_gates VALUES(?,?)')
    .bind('alice', Date.now() + 60000)
    .run();
  expect((await send()).status).toBe(200);
  const count = f.calls.length,
    response = await send();
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('15');
  expect(f.calls).toHaveLength(count);
  expect(
    (await mocks.db
      .prepare(
        "SELECT COUNT(*) AS n FROM imported_token_project_gates WHERE owner_id!='alice'",
      )
      .first<{ n: number }>())!.n,
  ).toBe(1);
});
it('rejects ownership proof removal and project edits during simulation', async () => {
  mocks.rpc = async (method, params, signal) => {
    const response = await f.rpc(method, params, signal);
    if (method === 'simulateTransaction')
      await mocks.db.prepare('DELETE FROM wallet_ownership_proofs').run();
    return response;
  };
  expect((await send()).status).toBe(409);
  await mocks.db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .bind('alice', 'Solana', f.intent.payer)
    .run();
  await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
  mocks.rpc = async (method, params, signal) => {
    const response = await f.rpc(method, params, signal);
    if (method === 'simulateTransaction')
      await mocks.db
        .prepare("UPDATE workspace_projects SET updated_at='changed'")
        .run();
    return response;
  };
  expect((await send()).status).toBe(409);
});
it('sanitizes provider failure and cannot return a successful approval from it', async () => {
  mocks.rpc = async () => {
    throw new Error('SECRET RPC URL and provider stack');
  };
  const response = await send();
  expect(response.status).toBe(502);
  const text = await response.text();
  expect(text).not.toContain('SECRET');
  expect(text).toContain('No signing approval');
});

for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`preflights the exact saved developer target with owned database reads and two unsigned simulations (${stock ? (token22 ? 'Token-2022 stock' : 'SPL stock') : 'SOL'})`, async () => {
    await seed(stock, token22);
    const response = await send({ ...body, maximumQuoteCostRaw: '100000000' });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      format: 'pump-create-buy-preflight-v1',
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
      containsInitialBuy: true,
      containsHolderBuys: false,
      developerSupplyPercent: 0.1,
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
      metadataUri: f.intent.uri,
      requestedHoldersBuy: 20,
      packet: { transactionVersion: 1 },
      simulation: { status: 'Simulated', buybackSplitRoundingAttested: false },
    });
    expect(
      f.calls.filter((c) => c.method === 'simulateTransaction'),
    ).toHaveLength(2);
    expect(
      f.calls.some((c) => ['sendTransaction', 'sendBundle'].includes(c.method)),
    ).toBe(false);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
it('rejects invalid quote caps and caller-supplied supply targets before RPC', async () => {
  for (const maximumQuoteCostRaw of [
    '0',
    '-1',
    '1.1',
    '18446744073709551616',
    1,
  ])
    expect((await send({ ...body, maximumQuoteCostRaw })).status).toBe(400);
  expect(
    (
      await send({
        ...body,
        maximumQuoteCostRaw: '100000000',
        tokenAmountRaw: '1',
      })
    ).status,
  ).toBe(400);
  expect(f.calls).toEqual([]);
});
it('rejects a watch-only or foreign payer before atomic RPC', async () => {
  mocks.user = { userId: 'bob' };
  expect(
    (await send({ ...body, maximumQuoteCostRaw: '100000000' })).status,
  ).toBe(404);
  mocks.user = { userId: 'alice' };
  await mocks.db.prepare('DELETE FROM wallet_ownership_proofs').run();
  expect(
    (await send({ ...body, maximumQuoteCostRaw: '100000000' })).status,
  ).toBe(404);
  expect(f.calls).toEqual([]);
});
it('rejects zero developer buys and scheduling before atomic RPC', async () => {
  const row = await mocks.db
    .prepare('SELECT document FROM workspace_projects')
    .first<{ document: string }>();
  const doc = JSON.parse(row!.document);
  doc.plan.developerBuy = 0;
  await mocks.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(doc))
    .run();
  expect(
    (await send({ ...body, maximumQuoteCostRaw: '100000000' })).status,
  ).toBe(409);
  doc.plan.developerBuy = 0.1;
  doc.plan.scheduled = true;
  await mocks.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(doc))
    .run();
  expect(
    (await send({ ...body, maximumQuoteCostRaw: '100000000' })).status,
  ).toBe(409);
  expect(f.calls).toEqual([]);
});
it('rejects ownership changes during the atomic simulation', async () => {
  let simulations = 0;
  mocks.rpc = async (method, params, signal) => {
    const response = await f.rpc(method, params, signal);
    if (method === 'simulateTransaction' && ++simulations === 2)
      await mocks.db.prepare('DELETE FROM wallet_ownership_proofs').run();
    return response;
  };
  expect(
    (await send({ ...body, maximumQuoteCostRaw: '100000000' })).status,
  ).toBe(409);
});

it('shares the project rate gate between create-only and atomic preflight', async () => {
  expect(
    (await send({ ...body, maximumQuoteCostRaw: '100000000' })).status,
  ).toBe(200);
  const reads = f.calls.length;
  const retry = await send();
  expect(retry.status).toBe(429);
  expect(retry.headers.get('retry-after')).toBe('15');
  expect(f.calls).toHaveLength(reads);
});
it('sanitizes atomic simulation failures and cannot expose an approval', async () => {
  f.state.err = { InstructionError: [3, 'SECRET provider detail'] };
  const response = await send({ ...body, maximumQuoteCostRaw: '100000000' });
  expect(response.status).toBe(502);
  const text = await response.text();
  expect(text).not.toContain('SECRET');
  expect(text).toContain('No signing approval');
});
it('rejects changes to the saved developer percentage during atomic RPC', async () => {
  let simulations = 0;
  mocks.rpc = async (method, params, signal) => {
    const response = await f.rpc(method, params, signal);
    if (method === 'simulateTransaction' && ++simulations === 2) {
      const row = await mocks.db
        .prepare('SELECT document FROM workspace_projects')
        .first<{ document: string }>();
      const doc = JSON.parse(row!.document);
      doc.plan.developerBuy = 0.2;
      await mocks.db
        .prepare('UPDATE workspace_projects SET document=?')
        .bind(JSON.stringify(doc))
        .run();
    }
    return response;
  };
  expect(
    (await send({ ...body, maximumQuoteCostRaw: '100000000' })).status,
  ).toBe(409);
});

it('persists the atomic review under real immutable and reservation triggers, without approval', async () => {
  const terms = {
    ...body,
    origin,
    maximumQuoteCostRaw: '100000000',
  } as Parameters<typeof preparePumpInitialBuyReview>[2];
  const result = await preparePumpInitialBuyReview(
    mocks.db,
    'alice',
    terms,
    new AbortController().signal,
    f.rpc,
  );
  expect(result).toMatchObject({
    format: 'pump-create-buy-review-v1',
    state: 'review',
    signingAllowed: false,
    executionAllowed: false,
    review: {
      developerSupplyPercent: 0.1,
      input: { tokenAmountRaw: '1000000000000', transactionVersion: 1 },
    },
  });
  const reads = f.calls.length;
  expect(
    await preparePumpInitialBuyReview(
      mocks.db,
      'alice',
      terms,
      new AbortController().signal,
      f.rpc,
    ),
  ).toEqual(result);
  expect(f.calls).toHaveLength(reads);
  const refreshed = await refreshPumpInitialBuyReview(
    mocks.db,
    'alice',
    result.review.id,
    new AbortController().signal,
    f.rpc,
  );
  expect(refreshed.packet.sha256).toBe(result.review.sha256);
  await expect(
    refreshPumpInitialBuyReview(
      mocks.db,
      'bob',
      result.review.id,
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('not found');
  await expect(
    preparePumpInitialBuyReview(
      mocks.db,
      'alice',
      { ...terms, maximumQuoteCostRaw: '100000001' },
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('Another launch review');
  await expect(
    preparePumpInitialBuyReview(
      mocks.db,
      'bob',
      terms,
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('owned launch');
  await expect(
    mocks.db
      .prepare("UPDATE pump_launch_reviews SET terms='{}' WHERE id=?")
      .bind(result.review.id)
      .run(),
  ).rejects.toThrow('Immutable');
  await expect(
    mocks.db
      .prepare('INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)')
      .bind('alice', terms.payer, 'swap', 'other', 'approved')
      .run(),
  ).rejects.toThrow('reserved for launch');
  expect(
    f.calls.some((c) => ['sendTransaction', 'sendBundle'].includes(c.method)),
  ).toBe(false);
});
it('rejects an existing swap reservation before collecting a durable atomic review', async () => {
  const terms = {
    ...body,
    origin,
    maximumQuoteCostRaw: '100000000',
  } as Parameters<typeof preparePumpInitialBuyReview>[2];
  await mocks.db
    .prepare('INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)')
    .bind('alice', terms.payer, 'swap', 'other', 'approved')
    .run();
  await expect(
    preparePumpInitialBuyReview(
      mocks.db,
      'alice',
      terms,
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('already reserved');
  expect(f.calls).toEqual([]);
});
it('does not persist or reserve a project edited after its unsigned atomic simulation', async () => {
  const terms = {
    ...body,
    origin,
    maximumQuoteCostRaw: '100000000',
  } as Parameters<typeof preparePumpInitialBuyReview>[2];
  let simulations = 0;
  const rpc = async (
    method: string,
    params: unknown[],
    signal: AbortSignal,
  ) => {
    const response = await f.rpc(method, params, signal);
    if (method === 'simulateTransaction' && ++simulations === 2)
      await mocks.db
        .prepare("UPDATE workspace_projects SET updated_at='changed'")
        .run();
    return response;
  };
  await expect(
    preparePumpInitialBuyReview(
      mocks.db,
      'alice',
      terms,
      new AbortController().signal,
      rpc,
    ),
  ).rejects.toThrow('changed');
  expect(
    (await mocks.db
      .prepare(
        'SELECT COUNT(*) AS n FROM pump_launch_reviews WHERE owner_id=? AND project_id=?',
      )
      .bind('alice', terms.projectId)
      .first<{ n: number }>())!.n,
  ).toBe(0);
});

const atomicSend = (value: unknown, headers: Record<string, string> = {}) =>
  atomicPOST(
    new Request(origin + '/api/launch/pump/initial-buy', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    }),
  );
async function prepareAtomicApi() {
  const response = await atomicSend({
    ...body,
    action: 'prepare',
    maximumQuoteCostRaw: '100000000',
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Awaited<
    ReturnType<typeof preparePumpInitialBuyReview>
  >;
}
const atomicConsent = (
  l: Awaited<ReturnType<typeof preparePumpInitialBuyReview>>,
) => ({
  approved: true,
  sha256: l.review.sha256,
  approvedScope: 'create-and-developer-buy',
  acknowledgeSimulationLimits: true,
});
async function syntheticAtomicSign(
  l: Awaited<ReturnType<typeof preparePumpInitialBuyReview>>,
) {
  const tx = atomicDecoder().decode(
    Buffer.from(l.review.transaction, 'base64'),
  );
  const signatures: Record<string, AtomicSignature> = {};
  for (const signer of [f.f.payerSigner, f.f.mintSigner])
    signatures[signer.address] = new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        signer.keyPair.privateKey,
        Uint8Array.from(tx.messageBytes),
      ),
    ) as AtomicSignature;
  return {
    transaction: atomicBase64().decode(
      atomicEncoder().encode({ ...tx, signatures }),
    ),
    signature: bs58.encode(signatures[f.intent.payer]),
  };
}
it('authenticates strict atomic API terms and isolates history', async () => {
  mocks.user = null;
  expect(
    (
      await atomicSend({
        ...body,
        action: 'prepare',
        maximumQuoteCostRaw: '100000000',
      })
    ).status,
  ).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (
      await atomicSend(
        { ...body, action: 'prepare', maximumQuoteCostRaw: '100000000' },
        { origin: 'https://foreign.example' },
      )
    ).status,
  ).toBe(403);
  expect(
    (await atomicSend({ ...body, action: 'prepare', maximumQuoteCostRaw: '0' }))
      .status,
  ).toBe(400);
  expect((await atomicSend({ large: 'x'.repeat(8300) })).status).toBe(413);
  expect(f.calls).toEqual([]);
  const l = await prepareAtomicApi();
  expect(l.signingAllowed).toBe(false);
  const history = await atomicGET(
    new Request(
      origin + '/api/launch/pump/initial-buy?projectId=' + body.projectId,
    ),
  );
  expect(
    ((await history.json()) as { launches: unknown[] }).launches,
  ).toHaveLength(1);
  mocks.user = { userId: 'bob' };
  expect(
    (await atomicSend({ action: 'recover', id: l.review.id })).status,
  ).toBe(404);
});
for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`executes controlled atomic approval, dual registration, submission and v1 recovery (${stock ? (token22 ? 'Token-2022 stock' : 'SPL stock') : 'SOL'})`, async () => {
    await seed(stock, token22);
    const l = await prepareAtomicApi(),
      s = await syntheticAtomicSign(l);
    expect(
      (
        await atomicSend({
          action: 'register',
          id: l.review.id,
          transaction: s.transaction,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await atomicSend({
          action: 'approve',
          id: l.review.id,
          ...atomicConsent(l),
          acknowledgeSimulationLimits: false,
        })
      ).status,
    ).toBe(400);
    const approved = await atomicSend({
      action: 'approve',
      id: l.review.id,
      ...atomicConsent(l),
    });
    expect(approved.status).toBe(200);
    expect(
      ((await approved.json()) as { signingAllowed: boolean }).signingAllowed,
    ).toBe(true);
    expect(
      (
        await atomicSend({
          action: 'register',
          id: l.review.id,
          transaction: s.transaction,
        })
      ).status,
    ).toBe(200);
    expect(f.calls.some((c) => c.method === 'sendTransaction')).toBe(false);
    let sends = 0;
    mocks.rpc = async (method, params, signal) => {
      if (method === 'sendTransaction') {
        sends++;
        expect(params[0]).toBe(s.transaction);
        expect(params[1]).toMatchObject({
          skipPreflight: false,
          maxRetries: 0,
        });
        return s.signature;
      }
      if (method === 'getTransaction') {
        expect(params[1]).toMatchObject({
          commitment: 'finalized',
          maxSupportedTransactionVersion: 1,
        });
        return {
          slot: '101',
          transaction: [s.transaction, 'base64'],
          meta: { err: null },
        };
      }
      return f.rpc(method, params, signal);
    };
    expect(
      (
        await atomicSend({
          action: 'submit',
          id: l.review.id,
          ...atomicConsent(l),
          approved: false,
        })
      ).status,
    ).toBe(400);
    const submitted = await atomicSend({
      action: 'submit',
      id: l.review.id,
      ...atomicConsent(l),
    });
    expect(submitted.status).toBe(200);
    expect(((await submitted.json()) as { state: string }).state).toBe(
      'submitted',
    );
    await atomicSend({
      action: 'submit',
      id: l.review.id,
      ...atomicConsent(l),
    });
    expect(sends).toBe(1);
    const recovered = await atomicSend({ action: 'recover', id: l.review.id });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      state: 'finalized',
      receipt: {
        succeeded: true,
        containsInitialBuy: true,
        containsHolderBuys: false,
      },
    });
  });
it('never resends after a lost atomic submission response', async () => {
  const l = await prepareAtomicApi(),
    s = await syntheticAtomicSign(l);
  expect(
    (
      await atomicSend({
        action: 'approve',
        id: l.review.id,
        ...atomicConsent(l),
      })
    ).status,
  ).toBe(200);
  await atomicSend({
    action: 'register',
    id: l.review.id,
    transaction: s.transaction,
  });
  let sends = 0;
  mocks.rpc = async (method, params, signal) => {
    if (method === 'sendTransaction') {
      sends++;
      throw new Error('lost response');
    }
    return f.rpc(method, params, signal);
  };
  const response = await atomicSend({
    action: 'submit',
    id: l.review.id,
    ...atomicConsent(l),
  });
  expect(((await response.json()) as { state: string }).state).toBe(
    'submitting',
  );
  await atomicSend({ action: 'submit', id: l.review.id, ...atomicConsent(l) });
  expect(sends).toBe(1);
});

it('rejects revoked payer ownership before approving the atomic review', async () => {
  const l = await prepareAtomicApi();
  await mocks.db.prepare('DELETE FROM wallet_ownership_proofs').run();
  expect(
    (
      await atomicSend({
        action: 'approve',
        id: l.review.id,
        ...atomicConsent(l),
      })
    ).status,
  ).toBe(404);
  const state = await mocks.db
    .prepare('SELECT state FROM pump_launch_reviews WHERE id=?')
    .bind(l.review.id)
    .first<{ state: string }>();
  expect(state!.state).toBe('review');
});

for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`refreshes real atomic history after shared recipient credits and a validated volume timestamp (${stock}, token22=${token22})`, async () => {
    await seed(stock, token22);
    const key = f.packet.buybackAccount;
    if (stock)
      f.before.set(
        key,
        raw(
          f.packet.quote.tokenProgram,
          f.token(f.intent.quoteMint, f.packet.buybackRecipient, 123n, token22),
        ),
      );
    f.state.volumeGain = 7n;
    const terms = {
      ...body,
      origin,
      maximumQuoteCostRaw: '100000000',
    } as Parameters<typeof preparePumpInitialBuyReview>[2];
    const stored = await preparePumpInitialBuyReview(
      mocks.db,
      'alice',
      terms,
      new AbortController().signal,
      f.rpc,
    );
    const account = f.before.get(key)!;
    if (stock) {
      const bytes = pumpAccountBytes(account),
        view = new DataView(bytes.buffer);
      view.setBigUint64(64, view.getBigUint64(64, true) + 1234567n, true);
      f.before.set(key, raw(account.owner, bytes, account.lamports));
    } else
      f.before.set(key, {
        ...account,
        lamports: (BigInt(account.lamports) + 1234567n).toString(),
      });
    f.state.volumeTimestamp = BigInt(Math.floor(Date.now() / 1000));
    const refreshed = await refreshPumpInitialBuyReview(
      mocks.db,
      'alice',
      stored.review.id,
      new AbortController().signal,
      f.rpc,
    );
    expect(refreshed.packet.sha256).toBe(stored.review.sha256);
    expect(refreshed.simulation.volumeGainRaw).toBe('7');
    expect(refreshed.simulation.buybackFeeRaw).toBe(
      stored.simulation.buybackFeeRaw,
    );
    const changed = refreshed.simulation.accountHashes.find(
      (a) => a.address === key,
    )!;
    const original = stored.simulation.accountHashes.find(
      (a) => a.address === key,
    )!;
    expect(changed.beforeSha256).not.toBe(original.beforeSha256);
    expect(changed.sourceIdentitySha256).toBe(original.sourceIdentitySha256);
    // A different, individually valid volume gain must not silently replace the reviewed accounting.
    f.state.volumeGain = 8n;
    await expect(
      refreshPumpInitialBuyReview(
        mocks.db,
        'alice',
        stored.review.id,
        new AbortController().signal,
        f.rpc,
      ),
    ).rejects.toThrow('costs or observed state changed');
    expect(f.calls.some((c) => /send|bundle|sign/i.test(c.method))).toBe(false);
  });

async function atomicRecoveryFixture(registered = true) {
  const launch = await prepareAtomicApi();
  expect(
    (
      await atomicSend({
        action: 'approve',
        id: launch.review.id,
        ...atomicConsent(launch),
      })
    ).status,
  ).toBe(200);
  const signed = registered ? await syntheticAtomicSign(launch) : null;
  if (signed)
    expect(
      (
        await atomicSend({
          action: 'register',
          id: launch.review.id,
          transaction: signed.transaction,
        })
      ).status,
    ).toBe(200);
  const calls: { method: string; params: unknown[] }[] = [];
  const state = {
    receipt: null as unknown,
    slot: '2000',
    height: '1033',
    mintSlot: '2001',
    mint: null as unknown,
    finalNetwork: SOLANA_MAINNET_GENESIS,
  };
  let genesisReads = 0;
  mocks.rpc = async (method, params, signal) => {
    signal.throwIfAborted();
    calls.push({ method, params });
    if (method === 'getGenesisHash')
      return ++genesisReads % 2 === 1
        ? SOLANA_MAINNET_GENESIS
        : state.finalNetwork;
    if (method === 'getTransaction') return state.receipt;
    if (method === 'getEpochInfo')
      return { absoluteSlot: state.slot, blockHeight: state.height };
    if (method === 'getAccountInfo')
      return { context: { slot: state.mintSlot }, value: state.mint };
    throw new Error('Unexpected recovery-only method');
  };
  const read = () =>
    mocks.db
      .prepare(
        'SELECT state,receipt,signature FROM pump_launch_reviews WHERE id=?',
      )
      .bind(launch.review.id)
      .first<{
        state: string;
        receipt: string | null;
        signature: string | null;
      }>();
  return {
    launch,
    signed,
    calls,
    state,
    read,
    resetNetworkReads: () => {
      genesisReads = 0;
    },
    recover: () => atomicSend({ action: 'recover', id: launch.review.id }),
  };
}
for (const registered of [false, true])
  it(`recovers expired developer history only from linked finalized mint absence (registered=${registered})`, async () => {
    const r = await atomicRecoveryFixture(registered);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(r.launch.review.expiresAt) + 1);
    try {
      const response = await r.recover();
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({
        state: 'cancelled',
        signingAllowed: false,
        completeLaunch: false,
        receipt: {
          kind: 'expired-unobserved',
          signatureKnown: registered,
          networkFeeUnresolved: true,
          finalizedBlockHeight: '1033',
          expiryBankSlot: '2000',
          mintObservedSlot: '2001',
          mintAbsent: true,
          packetSha256: r.launch.review.sha256,
          mint: r.launch.review.input.create.mint,
        },
      });
      expect(
        r.calls.find((c) => c.method === 'getAccountInfo')?.params[1],
      ).toEqual({
        encoding: 'base64',
        commitment: 'finalized',
        minContextSlot: 2000,
      });
      expect(r.calls.some((c) => c.method === 'getTransaction')).toBe(
        registered,
      );
      expect((await r.read())!.signature).toBe(
        registered ? r.signed!.signature : null,
      );
      const count = r.calls.length;
      expect((await r.recover()).status).toBe(200);
      expect(r.calls).toHaveLength(count);
    } finally {
      clock.mockRestore();
    }
  });
it('keeps developer reservations across the expiry margin, a present mint, stale absence or a changed final network', async () => {
  const r = await atomicRecoveryFixture();
  r.state.height = '1032';
  expect((await r.recover()).status).toBe(200);
  expect(r.calls.some((c) => c.method === 'getAccountInfo')).toBe(false);
  expect((await r.read())!.state).toBe('signed');
  r.state.height = '1033';
  r.state.mint = {};
  expect((await r.recover()).status).toBe(200);
  expect((await r.read())!.state).toBe('signed');
  r.state.mint = null;
  r.state.mintSlot = '1999';
  expect((await r.recover()).status).toBe(409);
  expect((await r.read())!.state).toBe('signed');
  r.resetNetworkReads();
  r.state.mintSlot = '2001';
  r.state.finalNetwork = 'wrong';
  expect((await r.recover()).status).toBe(409);
  expect(await r.read()).toMatchObject({ state: 'signed', receipt: null });
  expect(r.calls.some((c) => /send|bundle/i.test(c.method))).toBe(false);
});
it('rejects malformed developer receipts without replacing history, then records the exact finalized failure and fee', async () => {
  const r = await atomicRecoveryFixture();
  for (const patch of [
    { meta: {} },
    { meta: { err: false } },
    { slot: '99' },
    { transaction: [r.launch.review.transaction, 'base64'] },
    { meta: { err: null, fee: '-1' } },
  ]) {
    r.state.receipt = {
      slot: '2000',
      transaction: [r.signed!.transaction, 'base64'],
      meta: { err: null },
      ...patch,
    };
    expect((await r.recover()).status).toBe(
      Object.hasOwn(patch.meta ?? {}, 'fee') ? 502 : 409,
    );
    expect(await r.read()).toMatchObject({ state: 'signed', receipt: null });
  }
  r.state.receipt = {
    slot: '2000',
    transaction: [r.signed!.transaction, 'base64'],
    meta: { err: { InstructionError: ['1', 'Custom'] }, fee: '10000' },
  };
  const response = await r.recover();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: 'failed',
    completeLaunch: false,
    receipt: {
      kind: 'finalized',
      succeeded: false,
      networkFeeRaw: '10000',
      networkFeeUnresolved: false,
    },
  });
  expect(r.calls.some((c) => /send|bundle/i.test(c.method))).toBe(false);
});
it('rechecks mainnet before committing a successful developer receipt', async () => {
  const r = await atomicRecoveryFixture();
  r.state.receipt = {
    slot: '2000',
    transaction: [r.signed!.transaction, 'base64'],
    meta: { err: null },
  };
  r.state.finalNetwork = 'wrong';
  expect((await r.recover()).status).toBe(409);
  expect(await r.read()).toMatchObject({ state: 'signed', receipt: null });
});
it('allows only one concurrent developer recovery transition and never sends during recovery', async () => {
  const r = await atomicRecoveryFixture(),
    waiters: (() => void)[] = [];
  const recoveryRpc = mocks.rpc!;
  mocks.rpc = async (method, params, signal) => {
    if (method === 'getTransaction') {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (waiters.length === 2) for (const done of waiters) done();
      });
      return {
        slot: '2000',
        transaction: [r.signed!.transaction, 'base64'],
        meta: { err: null, fee: '10000' },
      };
    }
    return recoveryRpc(method, params, signal);
  };
  const responses = await Promise.all([r.recover(), r.recover()]);
  expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 409,
  ]);
  expect((await r.read())!.state).toBe('finalized');
  expect(r.calls.some((c) => /send|bundle/i.test(c.method))).toBe(false);
});
it('cancels an unsigned initial developer review locally and leaves a recover-only request unchanged', async () => {
  const l = await prepareAtomicApi();
  f.calls.length = 0;
  expect(
    (await atomicSend({ action: 'recover', id: l.review.id })).status,
  ).toBe(200);
  const cancelled = await atomicSend({ action: 'cancel', id: l.review.id });
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({
    state: 'cancelled',
    receipt: null,
  });
  expect(f.calls).toEqual([]);
});
