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
  TOKEN_PROGRAM,
  WRAPPED_SOL,
} from '@/lib/stonkfun-launch';
import {
  LAUNCHLAB_CURVES,
  LAUNCHLAB_PLATFORMS,
} from '@/lib/launchlab-platform-launch';
import type {
  LaunchLabReview,
  LaunchLabRpc,
} from '@/lib/launchlab-launch-service';
import { signLaunchLabLaunch } from '@/lib/launchlab-launch-signing';
import type { VaultSession } from '@/lib/browser-wallet-vault';

const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  rpc: null as unknown as LaunchLabRpc,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/launchlab-launch-service', async (original) => {
  const actual =
    await original<typeof import('@/lib/launchlab-launch-service')>();
  const deps = () => ({ rpc: mocks.rpc });
  return {
    ...actual,
    prepareLaunchLabLaunch: (
      ...a: Parameters<typeof actual.prepareLaunchLabLaunch>
    ) => actual.prepareLaunchLabLaunch(a[0], a[1], a[2], a[3], deps()),
    submitLaunchLabLaunch: (
      ...a: Parameters<typeof actual.submitLaunchLabLaunch>
    ) =>
      actual.submitLaunchLabLaunch(a[0], a[1], a[2], a[3], a[4], a[5], {
        rpc: a[6]?.rpc ?? mocks.rpc,
      }),
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
vi.mock('@/lib/stonkfun-launch-service', async (original) => {
  const actual =
    await original<typeof import('@/lib/stonkfun-launch-service')>();
  return {
    ...actual,
    stonkLaunchStatus: (signature: string, signal: AbortSignal) =>
      actual.stonkLaunchStatus(signature, signal, { rpc: mocks.rpc }),
  };
});
import { GET, POST } from './route';

const origin = 'https://bundle.test',
  updatedAt = '2026-10-19T00:00:00.000Z',
  CONFIG = LAUNCHLAB_CURVES[WRAPPED_SOL].configId;
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
const TOKENS_OUT = 12_345_678_900_000n;
let state: {
  quoteBalance: bigint;
  mintExists: boolean;
  simErr: unknown;
  sent: string[];
  sendFails: boolean;
  sendAttempts: number;
  ruleRequired: boolean;
  platformOwner: string;
};
function rpc(): LaunchLabRpc {
  return async (method, params) => {
    if (method === 'getMultipleAccounts') {
      const config = new Uint8Array(200);
      config.set(bs58.decode(WRAPPED_SOL), 83);
      const platform = new Uint8Array(1000);
      platform.set(new TextEncoder().encode('Bonk'), 112);
      platform[833] = state.ruleRequired ? 1 : 0;
      const quoteMint = new Uint8Array(82);
      quoteMint[44] = 9;
      const keys = params[0] as string[];
      expect(keys[0]).toBe(CONFIG);
      expect(keys[1]).toBe(LAUNCHLAB_PLATFORMS.LetsBonk);
      return {
        context: { slot: 100 },
        value: [
          { data: enc(config), owner: LAUNCHLAB_PROGRAM, lamports: 1 },
          { data: enc(platform), owner: state.platformOwner, lamports: 1 },
          { data: enc(quoteMint), owner: TOKEN_PROGRAM, lamports: 1 },
          state.mintExists
            ? {
                data: enc(new Uint8Array(82)),
                owner: TOKEN_PROGRAM,
                lamports: 1,
              }
            : null,
          null,
          keys[5] && state.ruleRequired
            ? {
                data: enc(new Uint8Array(64)),
                owner: LAUNCHLAB_PROGRAM,
                lamports: 1,
              }
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
                (watch[1] ? 50_000_000 : 0),
            },
            ...(watch[1]
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
type SavedReview = LaunchLabReview & { recoveryId: string };
const send = (value: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(origin + '/api/launchlab/launch', {
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
async function register(review: SavedReview, transaction: string) {
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
    (await send({ action: 'register', id: review.recoveryId, transaction }))
      .status,
  ).toBe(200);
}
const submitSaved = (review: SavedReview) =>
  send({
    action: 'submit',
    id: review.recoveryId,
    sha256: review.sha256,
    approved: true,
  });

beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'launchlab-launch-test',
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
          env: { DB: { type: 'd1', id: 'launchlab-launch-local-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'launchlab-launch-test',
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
  for (const trigger of [
    'pump_launch_venue_recovery_exclusion',
    'pump_launch_launchlab_recovery_exclusion',
    'launchlab_other_venue_recovery_exclusion',
    'pump_other_venue_recovery_identity_exclusion',
    'venue_pump_recovery_identity_exclusion',
  ])
    await mocks.db.prepare('DROP TRIGGER IF EXISTS ' + trigger).run();
  for (const table of [
    'launchlab_launch_recoveries',
    'venue_launch_recoveries',
  ])
    await mocks.db.prepare('DROP TABLE IF EXISTS ' + table).run();
  for (const file of [
    '0145_venue_launch_recoveries.sql',
    '0146_launchlab_launch_recoveries.sql',
  ])
    for (const sql of readFileSync(
      new URL('../../../../drizzle/' + file, import.meta.url),
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
    ruleRequired: false,
    platformOwner: LAUNCHLAB_PROGRAM,
  };
  mocks.rpc = rpc();
  for (const t of [
    'workspace_projects',
    'project_artwork',
    'workspace_wallets',
    'wallet_ownership_proofs',
  ])
    await mocks.db.prepare('DELETE FROM ' + t).run();
  const projectId = 'bonk-' + ++n,
    id = createHash('sha256').update(png).digest('hex');
  const doc = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      launchpad: 'LetsBonk',
      currency: 'SOL',
      quoteAddress: WRAPPED_SOL,
      developerBuy: 0,
      holdersBuy: 0,
      holdersBuyQuote: '0',
      scheduled: false,
      tokenName: 'Bonk Test',
      ticker: 'BTEST',
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
    venue: 'LetsBonk',
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

it('prepares, signs in the browser and relays a LetsBonk launch with a creator buy once', async () => {
  const prepared = await send({ action: 'prepare', terms });
  expect(prepared.status).toBe(200);
  const review = (await prepared.json()) as SavedReview;
  expect(review.input.minTokensOutRaw).toBe(TOKENS_OUT.toString());
  expect(review.input.curveRule).toBe(false);
  expect(review.input.platformId).toBe(LAUNCHLAB_PLATFORMS.LetsBonk);
  expect(review.input.uri).toMatch(
    /^https:\/\/bundle\.test\/api\/launch\/metadata\//,
  );
  expect(review.summary.platformName).toBe('Bonk');
  expect(review.summary.devSupplyBps).toBe(123);
  expect(review.summary.raiseRaw).toBe('85000000000');
  expect(review.summary.solCostLamports).toBe('30010000');
  const signed = await signLaunchLabLaunch(
    session(7, payer),
    session(9, mint),
    review,
    () => {},
  );
  await register(review, signed.transaction);
  const submitted = await submitSaved(review);
  expect(submitted.status).toBe(200);
  expect(await submitted.json()).toMatchObject({
    state: 'submitted',
    signature: signed.signature,
  });
  const saved = await GET(
    new Request(origin + '/api/launchlab/launch?id=' + review.recoveryId),
  );
  expect(await saved.json()).toMatchObject({
    id: review.recoveryId,
    state: 'submitted',
    signature: signed.signature,
  });
  expect(state.sent).toEqual([signed.signature]);
  const status = await GET(
    new Request(origin + '/api/launchlab/launch?signature=' + signed.signature),
  );
  expect(await status.json()).toEqual({ state: 'finalized' });
});

it('prepares a create-only launch', async () => {
  const prepared = await send({
    action: 'prepare',
    terms: { ...terms, devBuyRaw: '0' },
  });
  const review = (await prepared.json()) as LaunchLabReview;
  expect(prepared.status).toBe(200);
  expect(review.input.minTokensOutRaw).toBe('0');
  expect(review.summary.tokensOutRaw).toBe('0');
});

it('refuses tampered signed packets, missing signatures and edited reviews', async () => {
  const review = (await (
    await send({ action: 'prepare', terms })
  ).json()) as LaunchLabReview;
  const signed = await signLaunchLabLaunch(
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
  expect(changed.status).toBe(400);
  await expect(
    signLaunchLabLaunch(
      session(7, payer),
      session(9, mint),
      { ...review, input: { ...review.input, devBuyRaw: '99' } },
      () => {},
    ),
  ).rejects.toThrow(/differs/);
  await expect(
    signLaunchLabLaunch(session(7, payer), session(8, mint), review, () => {}),
  ).rejects.toThrow(/identity/);
  expect(state.sent).toEqual([]);
});

it('never resends when the send response is lost', async () => {
  const review = (await (
    await send({ action: 'prepare', terms })
  ).json()) as SavedReview;
  const signed = await signLaunchLabLaunch(
    session(7, payer),
    session(9, mint),
    review,
    () => {},
  );
  state.sendFails = true;
  await register(review, signed.transaction);
  const res = await submitSaved(review);
  expect(await res.json()).toMatchObject({
    state: 'submitting',
    signature: signed.signature,
  });
  expect((await submitSaved(review)).status).toBe(200);
  expect(state.sendAttempts).toBe(1);
});

it('refuses before simulation when the platform is missing or the mint exists', async () => {
  state.platformOwner = '11111111111111111111111111111111';
  const changed = await send({ action: 'prepare', terms });
  expect(changed.status).toBe(409);
  expect(((await changed.json()) as { error: string }).error).toMatch(
    /LetsBonk platform/,
  );
  state.platformOwner = LAUNCHLAB_PROGRAM;
  state.mintExists = true;
  const exists = await send({ action: 'prepare', terms });
  expect(exists.status).toBe(409);
  expect(((await exists.json()) as { error: string }).error).toMatch(
    /already exists/,
  );
});

it('includes the curve rule when the platform restricts curves', async () => {
  state.ruleRequired = true;
  const review = (await (
    await send({ action: 'prepare', terms })
  ).json()) as LaunchLabReview;
  expect(review.input.curveRule).toBe(true);
});

it('refuses a saved plan for another venue', async () => {
  const res = await send({
    action: 'prepare',
    terms: { ...terms, venue: 'Surge' },
  });
  expect(res.status).toBe(400);
  expect(
    (await send({ action: 'prepare', terms: { ...terms, venue: 'PumpFun' } }))
      .status,
  ).toBe(400);
});

it('refuses too little quote balance, failed simulation, foreign projects and bad requests', async () => {
  state.quoteBalance = 1n;
  const insufficient = await send({ action: 'prepare', terms });
  expect(insufficient.status).toBe(409);
  expect(await insufficient.json()).toMatchObject({
    preparationNotSaved: true,
  });
  state.quoteBalance = 1_000_000_000n;
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
it('does not call a lost save acknowledgement a definite pre-save rejection', async () => {
  const database = mocks.db;
  let committed = false;
  mocks.db = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      if (!sql.startsWith('INSERT INTO launchlab_launch_recoveries'))
        return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async run() {
              await bound.run();
              committed = true;
              throw Error('Lost committed save reply');
            },
          };
        },
      };
    },
  } as D1Database;
  let result: Response;
  try {
    result = await send({ action: 'prepare', terms });
  } finally {
    mocks.db = database;
  }
  expect(committed).toBe(true);
  expect(result.status).toBe(409);
  expect(await result.json()).not.toHaveProperty('preparationNotSaved');
  const history = await GET(
    new Request(origin + '/api/launchlab/launch?projectId=' + terms.projectId),
  );
  const saved = (await history.json()) as { launches: { state: string }[] };
  expect(saved.launches).toHaveLength(1);
  expect(saved.launches[0].state).toBe('review');
});
