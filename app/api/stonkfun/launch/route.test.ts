import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { getTransactionDecoder } from '@solana/kit';
import { releaseLaunchMetadata } from '@/lib/launch-metadata-release';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '@/lib/workspace-project';
import {
  LAUNCHLAB_PROGRAM,
  STONKFUN_STANDARD_PLATFORM,
  TOKEN_2022_PROGRAM,
} from '@/lib/stonkfun-launch';
import type {
  StonkLaunchReview,
  StonkRpc,
} from '@/lib/stonkfun-launch-service';
import { signStonkLaunch } from '@/lib/stonkfun-launch-signing';
import type { VaultSession } from '@/lib/browser-wallet-vault';

const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  rpc: null as unknown as StonkRpc,
  fetcher: null as unknown as typeof fetch,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/stonkfun-launch-service', async (original) => {
  const actual =
    await original<typeof import('@/lib/stonkfun-launch-service')>();
  const deps = () => ({ rpc: mocks.rpc, fetcher: mocks.fetcher });
  return {
    ...actual,
    prepareStonkLaunch: (...a: Parameters<typeof actual.prepareStonkLaunch>) =>
      actual.prepareStonkLaunch(a[0], a[1], a[2], a[3], deps()),
    submitStonkLaunch: (...a: Parameters<typeof actual.submitStonkLaunch>) =>
      actual.submitStonkLaunch(a[0], a[1], a[2], a[3], a[4], a[5], deps()),
    stonkLaunchStatus: (signature: string, signal: AbortSignal) =>
      actual.stonkLaunchStatus(signature, signal, deps()),
  };
});
import { GET, POST } from './route';

const origin = 'https://bundle.test',
  updatedAt = '2026-10-19T00:00:00.000Z',
  SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  CONFIG = 'B7ctMMdGvy46Am56myTtzfkNzt9kWZVTNGM2BWrJ9adg',
  CURVE_RULE = 'QYZp1YzqEHU67ngXphF9LAkxkxWGvpWEv3rXh4yDbWA';
const payerPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),
  mintPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)),
  payer = bs58.encode(payerPair.publicKey),
  mint = bs58.encode(mintPair.publicKey);
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
    'base64',
  ),
);
const pricing = {
  data: {
    quote: {
      mint: SPYX,
      symbol: 'SPYX',
      decimals: 8,
      tokenProgram: TOKEN_2022_PROGRAM,
    },
    raise: { raw: '1143648933' },
    marketCap: { startUsd: 2911.96, graduationUsd: 42787.86 },
    prices: { observedAt: '2026-10-19T15:52:51.664Z' },
    curve: {
      programId: LAUNCHLAB_PROGRAM,
      configId: CONFIG,
      curveType: 'ConstantCurve',
      migrateType: 'cpmm',
      baseDecimals: 6,
      supply: '1000000000000000',
      totalSellA: '793100000000000',
      vesting: { totalLockedAmount: '0', cliffPeriod: '0', unlockPeriod: '0' },
      cpmmCreatorFeeOn: 0,
    },
    platform: { standard: STONKFUN_STANDARD_PLATFORM },
    allowConfig: {
      required: { standard: true },
      standard: 'A1Eom3WAZ9jFUSMhZo7UvAQLbGqenNtPxEbyekaEsQsL',
    },
    curveRule: { standard: CURVE_RULE },
  },
};
const enc = (b: Uint8Array) => [Buffer.from(b).toString('base64'), 'base64'];
const tokenAccount = (m: string, owner: string, amount: bigint) => {
  const d = new Uint8Array(165);
  d.set(bs58.decode(m), 0);
  d.set(bs58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
};
const TOKENS_OUT = 12_345_678_900_000n;
let state: {
  quoteBalance: bigint;
  mintExists: boolean;
  simErr: unknown;
  sent: string[];
  sendFails: boolean;
  pricingOverride?: unknown;
};
function rpc(): StonkRpc {
  return async (method, params) => {
    if (method === 'getMultipleAccounts') {
      const config = new Uint8Array(200);
      config.set(bs58.decode(SPYX), 83);
      const platform = new Uint8Array(1000);
      platform.set(new TextEncoder().encode('StonkFun'), 112);
      platform[833] = 1;
      const quoteMint = new Uint8Array(170);
      quoteMint[44] = 8;
      const keys = params[0] as string[];
      return {
        context: { slot: 100 },
        value: [
          { data: enc(config), owner: LAUNCHLAB_PROGRAM, lamports: 1 },
          { data: enc(platform), owner: LAUNCHLAB_PROGRAM, lamports: 1 },
          { data: enc(quoteMint), owner: TOKEN_2022_PROGRAM, lamports: 1 },
          state.mintExists
            ? {
                data: enc(new Uint8Array(82)),
                owner: TOKEN_2022_PROGRAM,
                lamports: 1,
              }
            : null,
          {
            data: enc(tokenAccount(SPYX, payer, state.quoteBalance)),
            owner: TOKEN_2022_PROGRAM,
            lamports: 1,
          },
          keys[5] === CURVE_RULE
            ? {
                data: enc(new Uint8Array(64)),
                owner: LAUNCHLAB_PROGRAM,
                lamports: 1,
              }
            : null,
        ],
      };
    }
    if (method === 'getBalance') return { value: 1_000_000_000 };
    if (method === 'getLatestBlockhash')
      return {
        value: {
          blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
          lastValidBlockHeight: 300000000,
        },
      };
    if (method === 'simulateTransaction') {
      const watch = (params[1] as { accounts: { addresses: string[] } })
        .accounts.addresses;
      return {
        context: { slot: 101 },
        value: {
          err: state.simErr,
          logs: state.simErr ? ['Program log: Error: insufficient funds'] : [],
          unitsConsumed: 210000,
          accounts: [
            {
              data: enc(new Uint8Array(0)),
              owner: '11111111111111111111111111111111',
              lamports: 970_000_000,
            },
            ...(watch[1]
              ? [
                  {
                    data: enc(tokenAccount(mint, payer, TOKENS_OUT)),
                    owner: TOKEN_2022_PROGRAM,
                    lamports: 1,
                  },
                ]
              : []),
          ],
        },
      };
    }
    if (method === 'sendTransaction') {
      if (state.sendFails) throw new Error('network');
      const tx = getTransactionDecoder().decode(
        Uint8Array.from(Buffer.from(params[0] as string, 'base64')),
      );
      const sig = bs58.encode(Object.values(tx.signatures)[0]!);
      state.sent.push(sig);
      return sig;
    }
    if (method === 'getSignatureStatuses')
      return { value: [{ confirmationStatus: 'finalized', err: null }] };
    throw new Error('unexpected ' + method);
  };
}

let mf: Miniflare, terms: Record<string, unknown>;
const send = (value: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(origin + '/api/stonkfun/launch', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    }),
  );
const session = (seed: number, address: string) =>
  ({
    payload: {
      wallets: [
        {
          family: 'solana',
          address,
          seed: Buffer.alloc(32, seed).toString('hex'),
        },
      ],
    },
  }) as unknown as VaultSession;

beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'stonkfun-launch-test',
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
          env: { DB: { type: 'd1', id: 'stonkfun-launch-local-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'stonkfun-launch-test',
  )) as unknown as D1Database;
  for (const sql of [
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE project_artwork(owner_id TEXT,id TEXT,data BLOB,mime TEXT,archived INTEGER DEFAULT 0,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,folder_id TEXT,folder_ids TEXT,PRIMARY KEY(owner_id,chain,address))',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  ])
    await mocks.db.prepare(sql).run();
  for (const file of ['0078_lush_rictor.sql', '0079_real_justice.sql'])
    for (const sql of readFileSync(
      new URL('../../../../drizzle/' + file, import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await mocks.db.prepare(sql).run();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

let n = 0;
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  state = {
    quoteBalance: 100_000_000n,
    mintExists: false,
    simErr: null,
    sent: [],
    sendFails: false,
  };
  mocks.rpc = rpc();
  mocks.fetcher = (async () =>
    new Response(
      JSON.stringify(state.pricingOverride ?? pricing),
    )) as unknown as typeof fetch;
  for (const t of [
    'workspace_projects',
    'project_artwork',
    'workspace_wallets',
    'wallet_ownership_proofs',
  ])
    await mocks.db.prepare('DELETE FROM ' + t).run();
  const projectId = 'stonk-' + ++n,
    id = createHash('sha256').update(png).digest('hex');
  const doc = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'StonkFun',
      currency: 'SPYX',
      quoteAddress: SPYX,
      developerBuy: 0,
      holdersBuy: 0,
      holdersBuyQuote: '0',
      scheduled: false,
      tokenName: 'Stonk Test',
      ticker: 'STEST',
    },
    identity: { ...EMPTY_IDENTITY, artworkUrl: '/api/artwork/' + id },
    options: {
      ...DEFAULT_VENUE_OPTIONS,
      wallets: {
        chain: 'Solana',
        deployer: {
          address: payer,
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
    .bind('alice', 'Solana', payer, 1, 0, '', null)
    .run();
  await mocks.db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .bind('alice', 'Solana', payer)
    .run();
  const release = await releaseLaunchMetadata(
    mocks.db,
    'alice',
    projectId,
    updatedAt,
    origin,
  );
  terms = {
    projectId,
    updatedAt,
    releaseId: release.id,
    payer,
    payerRevision: 1,
    mint,
    devBuyRaw: '50000000',
    solLimitLamports: '50000000',
  };
});

it('prepares, signs in the browser and relays a StonkFun launch with a creator buy once', async () => {
  const prepared = await send({ action: 'prepare', terms });
  expect(prepared.status).toBe(200);
  const review = (await prepared.json()) as StonkLaunchReview;
  expect(review.input.minTokensOutRaw).toBe(TOKENS_OUT.toString());
  expect(review.input.curveRule).toBe(true);
  expect(review.input.uri).toMatch(
    /^https:\/\/bundle\.test\/api\/launch\/metadata\//,
  );
  expect(review.summary.platformName).toBe('StonkFun');
  expect(review.summary.devSupplyBps).toBe(123);
  expect(review.summary.solCostLamports).toBe('30010000');
  const signed = await signStonkLaunch(
    session(7, payer),
    session(9, mint),
    review,
    () => {},
  );
  const submitted = await send({
    action: 'submit',
    terms,
    input: review.input,
    transaction: signed.transaction,
  });
  expect(submitted.status).toBe(200);
  expect(await submitted.json()).toMatchObject({
    state: 'sent',
    signature: signed.signature,
    mint,
  });
  expect(state.sent).toEqual([signed.signature]);
  const status = await GET(
    new Request(origin + '/api/stonkfun/launch?signature=' + signed.signature),
  );
  expect(await status.json()).toEqual({ state: 'finalized' });
});

it('prepares a create-only launch', async () => {
  const prepared = await send({
    action: 'prepare',
    terms: { ...terms, devBuyRaw: '0' },
  });
  const review = (await prepared.json()) as StonkLaunchReview;
  expect(prepared.status).toBe(200);
  expect(review.input.minTokensOutRaw).toBe('0');
  expect(review.summary.tokensOutRaw).toBe('0');
});

it('refuses tampered signed packets, missing signatures and edited reviews', async () => {
  const review = (await (
    await send({ action: 'prepare', terms })
  ).json()) as StonkLaunchReview;
  const signed = await signStonkLaunch(
    session(7, payer),
    session(9, mint),
    review,
    () => {},
  );
  const changed = await send({
    action: 'submit',
    terms,
    input: { ...review.input, minTokensOutRaw: '1' },
    transaction: signed.transaction,
  });
  expect(changed.status).toBe(409);
  await expect(
    signStonkLaunch(
      session(7, payer),
      session(9, mint),
      { ...review, input: { ...review.input, devBuyRaw: '99' } },
      () => {},
    ),
  ).rejects.toThrow(/differs/);
  await expect(
    signStonkLaunch(session(7, payer), session(8, mint), review, () => {}),
  ).rejects.toThrow(/identity/);
  expect(state.sent).toEqual([]);
});

it('never resends when the send response is lost', async () => {
  const review = (await (
    await send({ action: 'prepare', terms })
  ).json()) as StonkLaunchReview;
  const signed = await signStonkLaunch(
    session(7, payer),
    session(9, mint),
    review,
    () => {},
  );
  state.sendFails = true;
  const res = await send({
    action: 'submit',
    terms,
    input: review.input,
    transaction: signed.transaction,
  });
  expect(await res.json()).toMatchObject({
    state: 'unknown',
    signature: signed.signature,
  });
});

it('refuses before simulation when StonkFun changes its platform or the mint exists', async () => {
  state.pricingOverride = {
    data: {
      ...pricing.data,
      platform: { standard: '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt' },
    },
  };
  const changed = await send({ action: 'prepare', terms });
  expect(changed.status).toBe(502);
  expect(((await changed.json()) as { error: string }).error).toMatch(
    /platform/,
  );
  state.pricingOverride = undefined;
  state.mintExists = true;
  const exists = await send({ action: 'prepare', terms });
  expect(exists.status).toBe(409);
  expect(((await exists.json()) as { error: string }).error).toMatch(
    /already exists/,
  );
});

it('refuses too little quote balance, failed simulation, foreign projects and bad requests', async () => {
  state.quoteBalance = 1n;
  expect((await send({ action: 'prepare', terms })).status).toBe(409);
  state.quoteBalance = 100_000_000n;
  state.simErr = { InstructionError: [1, 'Custom'] };
  const failed = await send({ action: 'prepare', terms });
  expect(failed.status).toBe(409);
  expect(((await failed.json()) as { error: string }).error).toMatch(
    /Simulation rejected/,
  );
  state.simErr = null;
  mocks.user = { userId: 'mallory' };
  expect((await send({ action: 'prepare', terms })).status).toBe(404);
  mocks.user = null;
  expect((await send({ action: 'prepare', terms })).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await send({ action: 'prepare', terms }, { origin: 'https://evil.test' }))
      .status,
  ).toBe(403);
  expect(
    (await send({ action: 'prepare', terms: { ...terms, extra: 1 } })).status,
  ).toBe(400);
  expect(
    (
      await send({
        action: 'prepare',
        terms: { ...terms, solLimitLamports: '2000000000' },
      })
    ).status,
  ).toBe(400);
});
