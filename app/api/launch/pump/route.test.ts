import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  type SignatureBytes,
} from '@solana/kit';
import bs58 from 'bs58';
import type { PumpSigningReview } from '@/lib/pump-launch-signing';
import type { PumpLaunchRpc } from '@/lib/pump-launch-simulation';
import { pumpSimulationFixture } from '../../../../test/pump-launch-simulation-fixture';
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
vi.mock('@/lib/pump-launch-service', async (original) => {
  const actual = await original<typeof import('@/lib/pump-launch-service')>();
  return {
    ...actual,
    preparePumpLaunch: (
      db: D1Database,
      owner: string,
      terms: import('@/lib/owned-pump-preflight').OwnedPumpTerms,
      signal: AbortSignal,
    ) => actual.preparePumpLaunch(db, owner, terms, signal, mocks.rpc!),
    actPumpLaunch: (
      db: D1Database,
      owner: string,
      id: string,
      action: Parameters<typeof actual.actPumpLaunch>[3],
      payload: Parameters<typeof actual.actPumpLaunch>[4],
      signal: AbortSignal,
    ) =>
      actual.actPumpLaunch(db, owner, id, action, payload, signal, mocks.rpc!),
  };
});
import { POST, GET } from './route';
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
    new Request(origin + '/api/launch/pump', {
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
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  ])
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../../drizzle/0078_lush_rictor.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../../drizzle/0079_real_justice.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
}, 30000);
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  f = await pumpSimulationFixture(sequence % 2 === 1);
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
      developerBuy: 0,
      holdersBuy: 0,
      holdersBuyQuote: '0',
      scheduled: false,
      currency: sequence % 2 === 0 ? 'TSLAX' : 'SOL',
      quoteAddress: f.intent.quoteMint,
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
    action: 'prepare',
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
type Launch = {
  review: PumpSigningReview;
  state: string;
  signature: string;
  receipt: unknown;
};
async function prepare() {
  const res = await send();
  const data = (await res.json()) as Launch;
  expect(res.status, JSON.stringify(data)).toBe(200);
  return data;
}
async function action(
  l: Launch,
  action: string,
  extra: Record<string, unknown> = {},
) {
  return send({ id: l.review.id, action, ...extra });
}
async function signed(l: Launch) {
  const tx = getTransactionDecoder().decode(
    Buffer.from(l.review.transaction, 'base64'),
  );
  const signatures: Record<string, SignatureBytes> = {};
  for (const signer of [f.f.payerSigner, f.f.mintSigner])
    signatures[signer.address] = new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        signer.keyPair.privateKey,
        Uint8Array.from(tx.messageBytes),
      ),
    ) as SignatureBytes;
  return {
    transaction: getBase64Decoder().decode(
      getTransactionEncoder().encode({ ...tx, signatures }),
    ),
    signature: bs58.encode(signatures[f.intent.payer]),
  };
}
it('authenticates strict bounded requests and never sends during prepare', async () => {
  mocks.user = null;
  expect((await send()).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect((await send(undefined, { origin: 'https://other.test' })).status).toBe(
    403,
  );
  expect((await send({ ...body, owner: 'bob' })).status).toBe(400);
  expect((await send({ large: 'x'.repeat(4200) })).status).toBe(413);
  const l = await prepare();
  expect(l.state).toBe('review');
  expect(f.calls.some((c) => c.method === 'sendTransaction')).toBe(false);
  const again = await prepare();
  expect(again.review.id).toBe(l.review.id);
  mocks.user = { userId: 'bob' };
  expect((await action(l, 'recover')).status).toBe(404);
});
it('requires explicit approval, two exact signatures and separate broadcast; retains finalized receipts', async () => {
  const l = await prepare(),
    s = await signed(l);
  expect(
    (await action(l, 'register', { transaction: s.transaction })).status,
  ).toBe(409);
  expect(
    (await action(l, 'approve', { sha256: l.review.sha256, approved: false }))
      .status,
  ).toBe(400);
  expect(
    (await action(l, 'approve', { sha256: l.review.sha256, approved: true }))
      .status,
  ).toBe(200);
  expect(
    (await action(l, 'register', { transaction: l.review.transaction })).status,
  ).toBe(502);
  expect(
    (await action(l, 'register', { transaction: s.transaction })).status,
  ).toBe(200);
  let sends = 0;
  mocks.rpc = async (method, params, signal) => {
    if (method === 'sendTransaction') {
      sends++;
      expect(params[0]).toBe(s.transaction);
      expect(params[1]).toMatchObject({ skipPreflight: false, maxRetries: 0 });
      return s.signature;
    }
    if (method === 'getTransaction')
      return {
        slot: '101',
        transaction: [s.transaction, 'base64'],
        meta: { err: null },
      };
    return f.rpc(method, params, signal);
  };
  expect(
    (await action(l, 'submit', { sha256: l.review.sha256, approved: false }))
      .status,
  ).toBe(400);
  const response = await action(l, 'submit', {
    sha256: l.review.sha256,
    approved: true,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(((await response.json()) as Launch).state).toBe('submitted');
  await action(l, 'submit', { sha256: l.review.sha256, approved: true });
  expect(sends).toBe(1);
  const recovered = (await (await action(l, 'recover')).json()) as Launch;
  expect(recovered.state).toBe('finalized');
  expect(recovered.receipt).toMatchObject({
    signature: s.signature,
    succeeded: true,
    slot: '101',
  });
});
it('keeps uncertain submission and recovers without resending', async () => {
  const l = await prepare(),
    s = await signed(l);
  await action(l, 'approve', { sha256: l.review.sha256, approved: true });
  await action(l, 'register', { transaction: s.transaction });
  let sends = 0;
  mocks.rpc = async (method, params, signal) => {
    if (method === 'sendTransaction') {
      sends++;
      throw new Error('lost response');
    }
    if (method === 'getTransaction') return null;
    return f.rpc(method, params, signal);
  };
  const submitted = (await (
    await action(l, 'submit', { sha256: l.review.sha256, approved: true })
  ).json()) as Launch;
  expect(submitted.state).toBe('submitting');
  await action(l, 'submit', { sha256: l.review.sha256, approved: true });
  await action(l, 'recover');
  expect(sends).toBe(1);
  mocks.rpc = async (method, params, signal) => {
    if (method === 'getTransaction') return null;
    if (method === 'getBlockHeight') return '1100';
    if (method === 'getAccountInfo') return { value: null };
    return f.rpc(method, params, signal);
  };
  expect(((await (await action(l, 'recover')).json()) as Launch).state).toBe(
    'cancelled',
  );
});
it('blocks changed drafts, requested initial buys and shared wallet reservations', async () => {
  const row = await mocks.db
    .prepare('SELECT document FROM workspace_projects')
    .first<{ document: string }>();
  const doc = JSON.parse(row!.document);
  doc.plan.developerBuy = 1;
  await mocks.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(doc))
    .run();
  expect((await send()).status).toBe(409);
  doc.plan.developerBuy = 0;
  await mocks.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(doc))
    .run();
  const l = await prepare();
  await expect(
    mocks.db
      .prepare(
        "INSERT INTO solana_execution_reservations VALUES(?,?,'withdrawal','other','approved')",
      )
      .bind('alice', f.intent.payer)
      .run(),
  ).rejects.toThrow();
  await mocks.db.prepare('UPDATE workspace_wallets SET revision=2').run();
  expect(
    (await action(l, 'approve', { sha256: l.review.sha256, approved: true }))
      .status,
  ).toBe(404);
  expect((await action(l, 'cancel')).status).toBe(200);
});
it('preserves history and immutable review terms and isolates GET history', async () => {
  const l = await prepare();
  await expect(
    mocks.db
      .prepare('DELETE FROM pump_launch_reviews WHERE id=?')
      .bind(l.review.id)
      .run(),
  ).rejects.toThrow();
  await expect(
    mocks.db
      .prepare("UPDATE pump_launch_reviews SET terms='{}' WHERE id=?")
      .bind(l.review.id)
      .run(),
  ).rejects.toThrow();
  const get = () =>
    GET(new Request(origin + '/api/launch/pump?projectId=' + body.projectId));
  expect(
    ((await (await get()).json()) as { launches: unknown[] }).launches.length,
  ).toBe(1);
  mocks.user = { userId: 'bob' };
  expect(
    ((await (await get()).json()) as { launches: unknown[] }).launches,
  ).toEqual([]);
});

it('enforces folder membership atomically at approval and rejects mismatched finalized packets', async () => {
  const row = await mocks.db
    .prepare('SELECT document FROM workspace_projects')
    .first<{ document: string }>();
  const doc = JSON.parse(row!.document);
  doc.options.wallets.deployer = {
    ...doc.options.wallets.deployer,
    root: undefined,
    folderId: 'launch-folder',
    folderRevision: 1,
  };
  await mocks.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(doc))
    .run();
  await mocks.db
    .prepare(
      "INSERT INTO wallet_folders VALUES('alice','launch-folder','Solana',1,0)",
    )
    .run();
  await mocks.db
    .prepare(
      "UPDATE workspace_wallets SET folder_id='launch-folder',folder_ids='[\"launch-folder\"]'",
    )
    .run();
  const l = await prepare();
  await mocks.db.prepare('UPDATE wallet_folders SET archived=1').run();
  await expect(
    mocks.db
      .prepare("UPDATE pump_launch_reviews SET state='approved' WHERE id=?")
      .bind(l.review.id)
      .run(),
  ).rejects.toThrow();
  await mocks.db.prepare('UPDATE wallet_folders SET archived=0').run();
  await action(l, 'approve', { sha256: l.review.sha256, approved: true });
  const s = await signed(l);
  await action(l, 'register', { transaction: s.transaction });
  mocks.rpc = async (method, params, signal) =>
    method === 'getTransaction'
      ? {
          slot: '101',
          transaction: [l.review.transaction, 'base64'],
          meta: { err: null },
        }
      : f.rpc(method, params, signal);
  expect((await action(l, 'recover')).status).toBe(409);
  const current = await mocks.db
    .prepare('SELECT state FROM pump_launch_reviews WHERE id=?')
    .bind(l.review.id)
    .first<{ state: string }>();
  expect(current?.state).toBe('signed');
});
