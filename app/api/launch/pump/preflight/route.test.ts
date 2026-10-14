import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { PumpLaunchRpc } from '@/lib/pump-launch-simulation';
import { pumpSimulationFixture } from '../../../../../test/pump-launch-simulation-fixture';
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
      intent: Parameters<typeof actual.simulatePumpCreate>[0],
      limit: string,
      signal: AbortSignal,
    ) => actual.simulatePumpCreate(intent, limit, signal, mocks.rpc!),
  };
});
import { POST } from './route';
let mf: Miniflare,
  f: Awaited<ReturnType<typeof pumpSimulationFixture>>,
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
  ])
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../../../drizzle/0078_lush_rictor.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
}, 30000);
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  f = await pumpSimulationFixture();
  mocks.rpc = f.rpc;
  for (const table of [
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
  body = {
    projectId,
    updatedAt,
    releaseId: release.id,
    payer: f.intent.payer,
    payerRevision: 1,
    mint: f.intent.mint,
    feeAndRentLimitRaw: '5000000',
  };
});
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
