import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { generateKeyPairSigner } from '@solana/kit';
import { createTursoDatabase } from '../db/turso';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import { pumpLaunchFixture } from '../test/pump-launch-fixture';
import { initialBuyFeeFixture } from '../test/pump-initial-buy-simulation-fixture';
import { encodePumpSigningInput } from './pump-launch-signing';
import { snipeOwnedPumpLaunch } from './pump-organic-preparation';
import { parsePumpOrganicRequest } from './pump-organic-request';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import { DEFAULT_VENUE_OPTIONS, EMPTY_IDENTITY } from './workspace-project';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { PUMP_LAUNCH_PROGRAM } from './pump-launch-config';
import type { PumpLaunchRpc } from './pump-launch-simulation';

const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const terms = (launchReviewId: string) => ({
  launchReviewId,
  mode: 'Stagger' as const,
  delayMinMs: 800,
  delayMaxMs: 800,
  slippageBps: 500,
  rentAllowanceRaw: '4000000',
});

async function setup(mode: 'Manual' | 'Quick' = 'Manual') {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  for (const sql of [
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0)',
    'CREATE TABLE pump_launch_reviews(owner_id TEXT,id TEXT,project_id TEXT,review TEXT,state TEXT,payer TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,archived INTEGER DEFAULT 0)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT)',
  ])
    await client.execute(sql);
  for (const sql of readFileSync(
    'drizzle/0093_pump_organic_sequences.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await client.execute(sql);
  const create = await pumpCreateFixture();
  const holders = await Promise.all(
    [0, 1, 2].map(async () => (await generateKeyPairSigner()).address),
  );
  for (const address of holders) {
    await client.execute({
      sql: "INSERT INTO workspace_wallets VALUES('alice','Solana',?,0)",
      args: [address],
    });
    await client.execute({
      sql: "INSERT INTO wallet_ownership_proofs VALUES('alice','Solana',?)",
      args: [address],
    });
  }
  const document = {
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      mode,
      developerBuy: 0,
      holdersBuy: 0,
      holdersBuyQuote: '0.3',
      holderCount: 3,
      holdersDistribution: {
        kind: 'random',
        deviationPercent: 0,
        seed: 'c'.repeat(32),
      },
    },
    identity: { ...EMPTY_IDENTITY },
    options: {
      ...DEFAULT_VENUE_OPTIONS,
      wallets: {
        chain: 'Solana',
        recipients: holders.map((address) => ({
          address,
          revision: 1,
          folderRevision: 0,
        })),
      },
    },
  };
  await client.execute({
    sql: "INSERT INTO workspace_projects VALUES('alice','p1',?,'now',0)",
    args: [JSON.stringify(document)],
  });
  const launchId = crypto.randomUUID();
  await client.execute({
    sql: "INSERT INTO pump_launch_reviews(owner_id,id,project_id,review,state) VALUES('alice',?,'p1',?,'finalized')",
    args: [launchId, JSON.stringify({ input: encodePumpSigningInput(create) })],
  });
  const f = await pumpLaunchFixture();
  const curve = f.config('BondingCurve', {
    virtual_token_reserves: 1073000000000000n,
    virtual_quote_reserves: 30000000000n,
    real_token_reserves: 793100000000000n,
    real_quote_reserves: 0n,
    token_total_supply: 1000000000000000n,
    complete: false,
    creator: create.payer,
  });
  const rpc: PumpLaunchRpc = async (method) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getMultipleAccounts')
      return {
        value: [curve, initialBuyFeeFixture()].map((data) => ({
          owner: PUMP_LAUNCH_PROGRAM,
          executable: false,
          lamports: '1',
          data: [b64(data), 'base64'],
        })),
      };
    throw new Error('unexpected ' + method);
  };
  return { db: createTursoDatabase(client), client, launchId, holders, rpc };
}

it('plans the saved Manual holder buys from the project, not the request', async () => {
  const { db, client, launchId, holders, rpc } = await setup();
  const signal = new AbortController().signal;
  await snipeOwnedPumpLaunch(db, 'alice', terms(launchId), signal, rpc);
  const rows = await client.execute(
    "SELECT plan,state,rent_allowance_raw FROM pump_organic_sequences WHERE owner_id='alice'",
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].state).toBe('active');
  expect(rows.rows[0].rent_allowance_raw).toBe('4000000');
  const plan = JSON.parse(rows.rows[0].plan as string);
  expect(plan.mode).toBe('Stagger');
  expect(plan.rows.map((r: { address: string }) => r.address)).toEqual(holders);
  expect(BigInt(plan.projectedQuoteCostRaw)).toBeLessThanOrEqual(300000000n);
  // A second Snipe on the same launch is refused while the first is active.
  await expect(
    snipeOwnedPumpLaunch(db, 'alice', terms(launchId), signal, rpc),
  ).rejects.toThrow(/already started/);
});

it('refuses plans that already ran holder buys at launch and other owners', async () => {
  const quick = await setup('Quick');
  const signal = new AbortController().signal;
  await expect(
    snipeOwnedPumpLaunch(
      quick.db,
      'alice',
      terms(quick.launchId),
      signal,
      quick.rpc,
    ),
  ).rejects.toThrow(/Manual mode/);
  const manual = await setup();
  await expect(
    snipeOwnedPumpLaunch(
      manual.db,
      'mallory',
      terms(manual.launchId),
      signal,
      manual.rpc,
    ),
  ).rejects.toThrow(/finalized launch/);
});

it('parses the snipe action strictly with no wallet or amount fields', () => {
  const id = crypto.randomUUID();
  expect(
    parsePumpOrganicRequest({ action: 'snipe', terms: terms(id) }),
  ).toEqual({ action: 'snipe', terms: terms(id) });
  expect(() =>
    parsePumpOrganicRequest({
      action: 'snipe',
      terms: { ...terms(id), buys: [] },
    }),
  ).toThrow();
  expect(() =>
    parsePumpOrganicRequest({
      action: 'snipe',
      terms: { ...terms(id), mode: 'Quick' },
    }),
  ).toThrow();
});
