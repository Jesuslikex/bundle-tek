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
  DBC_CONFIG_SIZE,
  DBC_PROGRAM,
  TOKEN_PROGRAM,
  USDC,
  WRAPPED_SOL,
} from '@/lib/meteora-dbc-launch';
import type {
  MeteoraDbcReview,
  MeteoraDbcRpc,
} from '@/lib/meteora-dbc-launch-service';
import { signMeteoraDbcLaunch } from '@/lib/meteora-dbc-launch-signing';
import type { VaultSession } from '@/lib/browser-wallet-vault';

const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  rpc: null as unknown as MeteoraDbcRpc,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/meteora-dbc-launch-service', async (original) => {
  const actual =
    await original<typeof import('@/lib/meteora-dbc-launch-service')>();
  const deps = () => ({ rpc: mocks.rpc });
  return {
    ...actual,
    prepareMeteoraDbcLaunch: (
      ...a: Parameters<typeof actual.prepareMeteoraDbcLaunch>
    ) => actual.prepareMeteoraDbcLaunch(a[0], a[1], a[2], a[3], deps()),
    submitMeteoraDbcLaunch: (
      ...a: Parameters<typeof actual.submitMeteoraDbcLaunch>
    ) =>
      actual.submitMeteoraDbcLaunch(a[0], a[1], a[2], a[3], a[4], a[5], {
        ...deps(),
        rpc: a[6]?.rpc ?? mocks.rpc,
      }),
  };
});
vi.mock('@/lib/stonkfun-launch-service', async (original) => {
  const actual =
    await original<typeof import('@/lib/stonkfun-launch-service')>();
  return {
    ...actual,
    stonkLaunchStatus: (signature: string, signal: AbortSignal) =>
      actual.stonkLaunchStatus(signature, signal, { rpc: mocks.rpc }),
  };
});
vi.mock('@/lib/venue-launch-recovery', async (original) => {
  const actual = await original<typeof import('@/lib/venue-launch-recovery')>();
  return {
    ...actual,
    prepareVenueLaunchRecovery: (
      ...a: Parameters<typeof actual.prepareVenueLaunchRecovery>
    ) =>
      actual.prepareVenueLaunchRecovery(a[0], a[1], a[2], a[3], a[4], {
        rpc: mocks.rpc,
      }),
    actVenueLaunchRecovery: (
      ...a: Parameters<typeof actual.actVenueLaunchRecovery>
    ) =>
      actual.actVenueLaunchRecovery(a[0], a[1], a[2], a[3], a[4], {
        rpc: mocks.rpc,
      }),
  };
});
import { GET, POST } from './route';

const origin = 'https://bundle.test',
  updatedAt = '2026-10-19T00:00:00.000Z',
  CONFIG = 'FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM',
  FEE_CLAIMER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
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
const enc = (b: Uint8Array) => [Buffer.from(b).toString('base64'), 'base64'];
const tokenAccount = (m: string, owner: string, amount: bigint) => {
  const d = new Uint8Array(165);
  d.set(bs58.decode(m), 0);
  d.set(bs58.decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
};
const TOKENS_OUT = 12_345_678_900_000n,
  SUPPLY = 1_000_000_000_000_000n;
const mintAccount = (supply: bigint) => {
  const d = new Uint8Array(82);
  new DataView(d.buffer).setBigUint64(36, supply, true);
  d[44] = 6;
  d[45] = 1;
  return d;
};
function dbcConfig() {
  const b = new Uint8Array(DBC_CONFIG_SIZE),
    v = new DataView(b.buffer);
  b.set([26, 108, 14, 123, 116, 230, 129, 43], 0);
  b.set(bs58.decode(state.configQuote), 8);
  b.set(bs58.decode(FEE_CLAIMER), 40);
  v.setBigUint64(104, 25_000_000n, true);
  b[130] = state.baseFeeMode;
  b[233] = 1;
  b[235] = 6;
  b[236] = 1;
  b[237] = state.tokenType;
  b[245] = 50;
  v.setBigUint64(264, 85_000_000_000n, true);
  v.setBigUint64(368, 10_000_000n, true);
  return b;
}
let state: {
  quoteBalance: bigint;
  mintExists: boolean;
  simErr: unknown;
  sent: string[];
  sendFails: boolean;
  sendAttempts: number;
  configOwner: string;
  configQuote: string;
  tokenType: number;
  baseFeeMode: number;
};
function rpc(): MeteoraDbcRpc {
  return async (method, params) => {
    if (method === 'getMultipleAccounts') {
      const keys = params[0] as string[];
      expect(keys[0]).toBe(CONFIG);
      expect(keys[1]).toBe(WRAPPED_SOL);
      const quoteMint = new Uint8Array(82);
      quoteMint[44] = 9;
      return {
        context: { slot: 100 },
        value: [
          { data: enc(dbcConfig()), owner: state.configOwner, lamports: 1 },
          { data: enc(quoteMint), owner: TOKEN_PROGRAM, lamports: 1 },
          state.mintExists
            ? { data: enc(mintAccount(1n)), owner: TOKEN_PROGRAM, lamports: 1 }
            : null,
          null,
        ],
      };
    }
    if (method === 'getBalance') return { value: Number(state.quoteBalance) };
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
              lamports:
                Number(state.quoteBalance) -
                30_000_000 -
                (watch[2] ? 50_000_000 : 0),
            },
            {
              data: enc(mintAccount(SUPPLY)),
              owner: TOKEN_PROGRAM,
              lamports: 1,
            },
            ...(watch[2]
              ? [
                  {
                    data: enc(tokenAccount(mint, payer, TOKENS_OUT)),
                    owner: TOKEN_PROGRAM,
                    lamports: 1,
                  },
                ]
              : []),
          ],
        },
      };
    }
    if (method === 'sendTransaction') {
      state.sendAttempts++;
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
    new Request(origin + '/api/meteora-dbc/launch', {
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
          name: 'meteora-dbc-launch-test',
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
          env: { DB: { type: 'd1', id: 'meteora-dbc-launch-local-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'meteora-dbc-launch-test',
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
  await mocks.db
    .prepare('DROP TRIGGER IF EXISTS pump_launch_venue_recovery_exclusion')
    .run();
  await mocks.db.prepare('DROP TABLE IF EXISTS venue_launch_recoveries').run();
  for (const sql of readFileSync(
    new URL(
      '../../../../drizzle/0145_venue_launch_recoveries.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  mocks.user = { userId: 'alice' };
  state = {
    quoteBalance: 1_000_000_000n,
    mintExists: false,
    simErr: null,
    sent: [],
    sendFails: false,
    sendAttempts: 0,
    configOwner: DBC_PROGRAM,
    configQuote: WRAPPED_SOL,
    tokenType: 0,
    baseFeeMode: 0,
  };
  mocks.rpc = rpc();
  for (const t of [
    'workspace_projects',
    'project_artwork',
    'workspace_wallets',
    'wallet_ownership_proofs',
  ])
    await mocks.db.prepare('DELETE FROM ' + t).run();
  const projectId = 'dbc-' + ++n,
    id = createHash('sha256').update(png).digest('hex');
  const doc = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'Meteora DBC',
      currency: 'SOL',
      quoteAddress: WRAPPED_SOL,
      developerBuy: 0,
      holdersBuy: 0,
      holdersBuyQuote: '0',
      scheduled: false,
      tokenName: 'Meteora Test',
      ticker: 'MTEST',
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
    config: CONFIG,
    devBuyRaw: '50000000',
    solLimitLamports: '50000000',
  };
});

it('prepares, signs in the browser and relays a Meteora DBC launch with a creator buy once', async () => {
  const prepared = await send({ action: 'prepare', terms });
  expect(prepared.status).toBe(200);
  const review = (await prepared.json()) as MeteoraDbcReview & {
    recoveryId: string;
  };
  expect(review.input.minTokensOutRaw).toBe(TOKENS_OUT.toString());
  expect(review.input.config).toBe(CONFIG);
  expect(review.input.baseTokenType).toBe(0);
  expect(review.input.uri).toMatch(
    /^https:\/\/bundle\.test\/api\/launch\/metadata\//,
  );
  expect(review.summary).toMatchObject({
    feeClaimer: FEE_CLAIMER,
    tokenStandard: 'SPL',
    migrationThresholdRaw: '85000000000',
    creatorTradingFeePercent: 50,
    poolCreationFeeLamports: '10000000',
    devSupplyBps: 123,
    solCostLamports: '30010000',
  });
  const signed = await signMeteoraDbcLaunch(
    session(7, payer),
    session(9, mint),
    review,
    () => {},
  );
  expect(
    (
      await send({
        action: 'approve',
        id: review.recoveryId,
        sha256: review.sha256,
        approved: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send({
        action: 'register',
        id: review.recoveryId,
        transaction: signed.transaction,
      })
    ).status,
  ).toBe(200);
  const submitted = await send({
    action: 'submit',
    id: review.recoveryId,
    sha256: review.sha256,
    approved: true,
  });
  expect(submitted.status).toBe(200);
  expect(await submitted.json()).toMatchObject({
    state: 'submitted',
    signature: signed.signature,
  });
  expect(state.sent).toEqual([signed.signature]);
  const status = await GET(
    new Request(
      origin + '/api/meteora-dbc/launch?signature=' + signed.signature,
    ),
  );
  expect(await status.json()).toEqual({ state: 'finalized' });
});

it('prepares a create-only Token-2022 launch', async () => {
  state.tokenType = 1;
  const prepared = await send({
    action: 'prepare',
    terms: { ...terms, devBuyRaw: '0' },
  });
  const review = (await prepared.json()) as MeteoraDbcReview & {
    recoveryId: string;
  };
  expect(prepared.status).toBe(200);
  expect(review.input.baseTokenType).toBe(1);
  expect(review.input.minTokensOutRaw).toBe('0');
  expect(review.summary.tokenStandard).toBe('Token-2022');
  expect(review.summary.tokensOutRaw).toBe('0');
});

it('refuses tampered signed packets, edited reviews and wrong keys', async () => {
  const review = (await (
    await send({ action: 'prepare', terms })
  ).json()) as MeteoraDbcReview & { recoveryId: string };
  const signed = await signMeteoraDbcLaunch(
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
  expect(changed.status).toBe(400); // Stateless submit bypass is refused.
  await expect(
    signMeteoraDbcLaunch(
      session(7, payer),
      session(9, mint),
      { ...review, input: { ...review.input, devBuyRaw: '99' } },
      () => {},
    ),
  ).rejects.toThrow(/differs/);
  await expect(
    signMeteoraDbcLaunch(session(7, payer), session(8, mint), review, () => {}),
  ).rejects.toThrow(/identity/);
  expect(state.sent).toEqual([]);
});

it('refuses to send when the config changed after review', async () => {
  const review = (await (
    await send({ action: 'prepare', terms })
  ).json()) as MeteoraDbcReview & { recoveryId: string };
  const signed = await signMeteoraDbcLaunch(
    session(7, payer),
    session(9, mint),
    review,
    () => {},
  );
  expect(
    (
      await send({
        action: 'approve',
        id: review.recoveryId,
        sha256: review.sha256,
        approved: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send({
        action: 'register',
        id: review.recoveryId,
        transaction: signed.transaction,
      })
    ).status,
  ).toBe(200);
  state.tokenType = 1;
  const res = await send({
    action: 'submit',
    id: review.recoveryId,
    sha256: review.sha256,
    approved: true,
  });
  expect(res.status).toBe(409);
  expect(state.sent).toEqual([]);
});

it('never resends when the send response is lost', async () => {
  const review = (await (
    await send({ action: 'prepare', terms })
  ).json()) as MeteoraDbcReview & { recoveryId: string };
  const signed = await signMeteoraDbcLaunch(
    session(7, payer),
    session(9, mint),
    review,
    () => {},
  );
  expect(
    (
      await send({
        action: 'approve',
        id: review.recoveryId,
        sha256: review.sha256,
        approved: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send({
        action: 'register',
        id: review.recoveryId,
        transaction: signed.transaction,
      })
    ).status,
  ).toBe(200);
  state.sendFails = true;
  const res = await send({
    action: 'submit',
    id: review.recoveryId,
    sha256: review.sha256,
    approved: true,
  });
  expect(await res.json()).toMatchObject({
    state: 'submitting',
    signature: signed.signature,
  });
  const again = await send({
    action: 'submit',
    id: review.recoveryId,
    sha256: review.sha256,
    approved: true,
  });
  expect(again.status).toBe(200);
  expect(state.sendAttempts).toBe(1);
  const saved = await GET(
    new Request(origin + '/api/meteora-dbc/launch?id=' + review.recoveryId),
  );
  const record = (await saved.json()) as Record<string, unknown>;
  expect(record.state).toBe('submitting');
  expect(record).not.toHaveProperty('signed');
});

it('refuses missing, mismatched or retired configs and existing mints before simulation', async () => {
  const error = async () => {
    const res = await send({ action: 'prepare', terms });
    expect(res.status).toBe(409);
    return ((await res.json()) as { error: string }).error;
  };
  state.configOwner = '11111111111111111111111111111111';
  expect(await error()).toMatch(/No Meteora DBC config/);
  state.configOwner = DBC_PROGRAM;
  state.configQuote = USDC;
  expect(await error()).toMatch(/pairs with USDC/);
  state.configQuote = WRAPPED_SOL;
  state.baseFeeMode = 2;
  expect(await error()).toMatch(/rate-limiter/);
  state.baseFeeMode = 0;
  state.mintExists = true;
  expect(await error()).toMatch(/already exists/);
});

it('refuses a saved plan for another venue', async () => {
  const doc = JSON.parse(
    (await mocks.db
      .prepare('SELECT document FROM workspace_projects')
      .first<{ document: string }>())!.document,
  );
  doc.plan.launchpad = 'LetsBonk';
  await mocks.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(doc))
    .run();
  const res = await send({ action: 'prepare', terms });
  expect(res.status).toBe(400);
});

it('refuses too little quote balance, failed simulation, high limits, foreign projects and bad requests', async () => {
  state.quoteBalance = 1n;
  expect((await send({ action: 'prepare', terms })).status).toBe(409);
  state.quoteBalance = 1_000_000_000n;
  state.simErr = { InstructionError: [1, 'Custom'] };
  const failed = await send({ action: 'prepare', terms });
  expect(failed.status).toBe(409);
  expect(((await failed.json()) as { error: string }).error).toMatch(
    /Simulation rejected/,
  );
  state.simErr = null;
  expect(
    (
      await send({
        action: 'prepare',
        terms: { ...terms, solLimitLamports: '10000' },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send({
        action: 'prepare',
        terms: { ...terms, solLimitLamports: '6000000000' },
      })
    ).status,
  ).toBe(400);
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
    (await send({ action: 'prepare', terms: { ...terms, config: 'nope' } }))
      .status,
  ).toBe(400);
});
