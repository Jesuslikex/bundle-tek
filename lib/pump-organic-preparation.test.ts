import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { createClient, type Client } from '@libsql/client';
import { generateKeyPairSigner } from '@solana/kit';
import { createTursoDatabase } from '../db/turso';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import { encodePumpSigningInput } from './pump-launch-signing';
import { planPumpOrganicSequence } from './pump-organic-sequence';
import { decodePumpInitialBuyState } from './pump-initial-buy-state';
import { initialBuyFeeFixture } from '../test/pump-initial-buy-simulation-fixture';
import { savePumpOrganicSequence } from './pump-organic-service';
import { preparePumpOrganicBatch } from './pump-organic-preparation';
import { requirePumpOrganicBatchReview } from './pump-organic-batch';
import { buildPumpOrganicBuyMessage } from './pump-organic-buy-message';
import { PUMP_TOKEN_2022 } from './pump-launch-config';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';

async function setup(state = 'finalized') {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  await client.execute(
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0)',
  );
  await client.execute(
    'CREATE TABLE pump_launch_reviews(owner_id TEXT,id TEXT,project_id TEXT,review TEXT,state TEXT,payer TEXT)',
  );
  await client.execute(
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT)',
  );
  await client.execute(
    "INSERT INTO workspace_projects VALUES('alice','p1','{}','now',0)",
  );
  for (const sql of readFileSync(
    'drizzle/0093_pump_organic_sequences.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await client.execute(sql);
  const db = createTursoDatabase(client);
  const create = await pumpCreateFixture();
  const launchId = crypto.randomUUID();
  await client.execute({
    sql: 'INSERT INTO pump_launch_reviews(owner_id,id,project_id,review,state) VALUES(?,?,?,?,?)',
    args: [
      'alice',
      launchId,
      'p1',
      JSON.stringify({ input: encodePumpSigningInput(create) }),
      state,
    ],
  });
  const holders = await Promise.all(
    [0, 1, 2].map(async () => (await generateKeyPairSigner()).address),
  );
  const plan = planPumpOrganicSequence({
    mode: 'Stagger',
    buys: holders.map((address) => ({ address, tokenAmountRaw: '1000000' })),
    delayMinMs: 30_000,
    delayMaxMs: 30_000,
    slippageBps: 300,
    quoteMint: create.quoteMint,
    curve: {
      virtualTokensRaw: '1073000000000000',
      virtualQuoteRaw: '30000000000',
      realTokensRaw: '793100000000000',
    },
    feeConfig: decodePumpInitialBuyState('FeeConfig', initialBuyFeeFixture()),
  });
  const sequence = await savePumpOrganicSequence(db, 'alice', {
    projectId: 'p1',
    launchReviewId: launchId,
    mint: create.mint,
    rentAllowanceRaw: '3000000',
    plan,
  });
  return { db, create, plan, sequence };
}

const tokenAccount = (mint: string, owner: string, amount: bigint) => {
  const b = new Uint8Array(165);
  b.set(bs58.decode(mint), 0);
  b.set(bs58.decode(owner), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  b[108] = 1;
  return {
    owner: PUMP_TOKEN_2022,
    executable: false,
    lamports: '2074080',
    data: [Buffer.from(b).toString('base64'), 'base64'],
  };
};
const rpc =
  (create: Awaited<ReturnType<typeof pumpCreateFixture>>, ok = true) =>
  async (method: string, params: unknown[]) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getLatestBlockhash')
      return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 900 } };
    if (method === 'getFeeForMessage')
      return { context: { slot: '50' }, value: '5000' };
    const keys =
      (params[1] as { accounts?: { addresses: string[] } })?.accounts
        ?.addresses ?? (params[0] as string[]);
    const holder = keys[0];
    if (method === 'getMultipleAccounts')
      return {
        context: { slot: '50' },
        value: [
          {
            owner: '11111111111111111111111111111111',
            executable: false,
            lamports: '1000000000',
            data: ['', 'base64'],
          },
          null,
        ],
      };
    if (method === 'simulateTransaction')
      return {
        context: { slot: '50' },
        value: {
          err: ok ? null : { InstructionError: [2, { Custom: 6002 }] },
          unitsConsumed: '80000',
          accounts: [
            {
              owner: '11111111111111111111111111111111',
              executable: false,
              lamports: String(1000000000 - 3000000),
              data: ['', 'base64'],
            },
            tokenAccount(create.mint, holder, 1000000n),
          ],
        },
      };
    throw new Error('unexpected ' + method);
  };

it('builds, simulates and saves one batch with a fresh shared lifetime', async () => {
  const f = await setup();
  const review = await preparePumpOrganicBatch(
    f.db,
    'alice',
    f.sequence.id,
    0,
    new AbortController().signal,
    rpc(f.create),
  );
  // 30s fixed delay with a 45s window: first batch holds buys 0 and 1.
  expect(review.buys.map((b) => b.index)).toEqual([0, 1]);
  expect(review.lastValidBlockHeight).toBe('900');
  const { decoded } = await requirePumpOrganicBatchReview(review);
  const expected = await buildPumpOrganicBuyMessage({
    create: f.create,
    holder: f.plan.rows[0].address,
    tokenAmountRaw: '1000000',
    maximumQuoteCostRaw: f.plan.rows[0].maximumQuoteCostRaw,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 900n,
  });
  expect(decoded[0].buy.packetSha256).toBe(expected.packetSha256);
  await expect(
    preparePumpOrganicBatch(
      f.db,
      'alice',
      f.sequence.id,
      1,
      new AbortController().signal,
      rpc(f.create),
    ),
  ).rejects.toThrow('earlier batch');
});

it('saves nothing when any buy fails simulation or the launch is not finalized', async () => {
  const f = await setup();
  await expect(
    preparePumpOrganicBatch(
      f.db,
      'alice',
      f.sequence.id,
      0,
      new AbortController().signal,
      rpc(f.create, false),
    ),
  ).rejects.toThrow('live curve');
  const stale = await setup('submitted');
  await expect(
    preparePumpOrganicBatch(
      stale.db,
      'alice',
      stale.sequence.id,
      0,
      new AbortController().signal,
      rpc(stale.create),
    ),
  ).rejects.toThrow('finalized launch');
});
