import { afterEach, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '../db/turso';
import {
  createVault,
  generateVaultWallets,
  type VaultSession,
} from './browser-wallet-vault';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import { buildPumpOrganicBuyMessage } from './pump-organic-buy-message';
import {
  createPumpOrganicBatchReview,
  signPumpOrganicBatch,
  type PumpOrganicBatchConsent,
} from './pump-organic-batch';
import { planPumpOrganicSequence } from './pump-organic-sequence';
import { decodePumpInitialBuyState } from './pump-initial-buy-state';
import { initialBuyFeeFixture } from '../test/pump-initial-buy-simulation-fixture';
import {
  observePumpOrganicBatch,
  registerPumpOrganicBatch,
  savePumpOrganicBatch,
  savePumpOrganicSequence,
  sendPumpOrganicBuy,
  stopPumpOrganicSequence,
} from './pump-organic-service';

const clients: Client[] = [];
let vault: VaultSession;
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
beforeAll(async () => {
  vault = generateVaultWallets(
    await createVault('synthetic organic service vault'),
    'solana',
    2,
  );
});
const signal = () => new AbortController().signal;

async function fixture() {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  await client.execute(
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0)',
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
  const holders = vault.payload.wallets.map((w) => w.address);
  const plan = planPumpOrganicSequence(
    {
      mode: 'Stagger',
      buys: holders.map((address) => ({
        address,
        tokenAmountRaw: '1000000000',
      })),
      delayMinMs: 5_000,
      delayMaxMs: 5_000,
      slippageBps: 500,
      quoteMint: create.quoteMint,
      curve: {
        virtualTokensRaw: '1073000000000000',
        virtualQuoteRaw: '30000000000',
        realTokensRaw: '793100000000000',
      },
      feeConfig: decodePumpInitialBuyState('FeeConfig', initialBuyFeeFixture()),
    },
    () => 0,
  );
  const sequence = await savePumpOrganicSequence(db, 'alice', {
    projectId: 'p1',
    launchReviewId: 'launch-1',
    mint: create.mint,
    rentAllowanceRaw: '3000000',
    plan,
  });
  const packets = await Promise.all(
    plan.rows.map((row) =>
      buildPumpOrganicBuyMessage({
        create,
        holder: row.address,
        tokenAmountRaw: row.tokenAmountRaw,
        maximumQuoteCostRaw: row.maximumQuoteCostRaw,
        blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
        lastValidBlockHeight: 900n,
      }),
    ),
  );
  const review = await createPumpOrganicBatchReview({
    id: crypto.randomUUID(),
    sequenceId: sequence.id,
    batch: 0,
    mint: create.mint,
    quoteMint: create.quoteMint,
    buys: plan.rows.map((row, n) => ({
      index: row.index,
      holder: row.address,
      batchOffsetMs: row.batchOffsetMs,
      tokenAmountRaw: row.tokenAmountRaw,
      maximumQuoteCostRaw: row.maximumQuoteCostRaw,
      transaction: packets[n].transaction,
      packetSha256: packets[n].packetSha256,
    })),
    lastValidBlockHeight: '900',
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
  });
  const consent: PumpOrganicBatchConsent = {
    approved: true,
    reviewId: review.id,
    sha256: review.sha256,
    scope: 'organic-holder-buy-batch',
    acknowledgePriceMovesBetweenBuys: true,
  };
  const signed = await signPumpOrganicBatch(
    new Map(holders.map((h) => [h, vault])),
    review,
    consent,
    () => {},
  );
  return { db, client, plan, sequence, review, consent, signed };
}
const rpc = (handlers: Record<string, (params: unknown[]) => unknown>) => {
  const calls: string[] = [];
  const call = async (method: string, params: unknown[]) => {
    calls.push(method);
    if (!handlers[method]) throw new Error('unexpected ' + method);
    return handlers[method](params);
  };
  return Object.assign(call, { calls });
};

it('saves, registers, sends each buy once and settles finalized receipts', async () => {
  const f = await fixture();
  await savePumpOrganicBatch(f.db, 'alice', f.review);
  const registered = await registerPumpOrganicBatch(
    f.db,
    'alice',
    f.review.id,
    {
      consent: f.consent,
      transactions: f.signed.signed.map((s) => s.transaction),
    },
  );
  expect(registered.state).toBe('signed');
  expect(registered.buys.map((b) => b.state)).toEqual(['signed', 'signed']);
  const provider = rpc({
    sendTransaction: (params) =>
      f.signed.signed.find((s) => s.transaction === params[0])!.signature,
    getSignatureStatuses: (params) => ({
      value: (params[0] as string[]).map(() => ({
        slot: 7,
        err: null,
        confirmationStatus: 'finalized',
      })),
    }),
    getBlockHeight: () => '800',
  });
  const sent = await sendPumpOrganicBuy(
    f.db,
    'alice',
    f.review.id,
    0,
    signal(),
    provider,
  );
  expect(sent.buys[0].state).toBe('submitted');
  // A repeat request never reaches the provider again.
  await sendPumpOrganicBuy(f.db, 'alice', f.review.id, 0, signal(), provider);
  expect(provider.calls.filter((c) => c === 'sendTransaction')).toHaveLength(1);
  await sendPumpOrganicBuy(f.db, 'alice', f.review.id, 1, signal(), provider);
  const observed = await observePumpOrganicBatch(
    f.db,
    'alice',
    f.review.id,
    signal(),
    provider,
  );
  expect(observed.buys.map((b) => b.state)).toEqual(['finalized', 'finalized']);
  expect(observed.state).toBe('closed');
});

it('keeps an unknown send outcome non-retryable and expires it only past the margin', async () => {
  const f = await fixture();
  await savePumpOrganicBatch(f.db, 'alice', f.review);
  await registerPumpOrganicBatch(f.db, 'alice', f.review.id, {
    consent: f.consent,
    transactions: f.signed.signed.map((s) => s.transaction),
  });
  let height = '920';
  const provider = rpc({
    sendTransaction: () => {
      throw new Error('socket closed');
    },
    getSignatureStatuses: (params) => ({
      value: (params[0] as string[]).map(() => null),
    }),
    getBlockHeight: () => height,
  });
  const sent = await sendPumpOrganicBuy(
    f.db,
    'alice',
    f.review.id,
    0,
    signal(),
    provider,
  );
  expect(sent.buys[0].state).toBe('submitting');
  await sendPumpOrganicBuy(f.db, 'alice', f.review.id, 0, signal(), provider);
  expect(provider.calls.filter((c) => c === 'sendTransaction')).toHaveLength(1);
  let observed = await observePumpOrganicBatch(
    f.db,
    'alice',
    f.review.id,
    signal(),
    provider,
  );
  expect(observed.buys[0].state).toBe('submitting');
  height = '933';
  observed = await observePumpOrganicBatch(
    f.db,
    'alice',
    f.review.id,
    signal(),
    provider,
  );
  expect(observed.buys.map((b) => b.state)).toEqual(['expired', 'expired']);
});

it('stop cancels unsent buys and the database refuses later sends', async () => {
  const f = await fixture();
  await savePumpOrganicBatch(f.db, 'alice', f.review);
  await registerPumpOrganicBatch(f.db, 'alice', f.review.id, {
    consent: f.consent,
    transactions: f.signed.signed.map((s) => s.transaction),
  });
  await stopPumpOrganicSequence(f.db, 'alice', f.sequence.id);
  const provider = rpc({ sendTransaction: () => 'x' });
  const after = await sendPumpOrganicBuy(
    f.db,
    'alice',
    f.review.id,
    0,
    signal(),
    provider,
  );
  expect(after.buys.map((b) => b.state)).toEqual(['cancelled', 'cancelled']);
  expect(provider.calls).toEqual([]);
  await expect(
    f.client.execute(
      `UPDATE pump_organic_buys SET state='submitting' WHERE batch_id='${f.review.id}'`,
    ),
  ).rejects.toThrow();
});

it('rejects batches that differ from the plan, other owners and missing consent', async () => {
  const f = await fixture();
  await expect(savePumpOrganicBatch(f.db, 'bob', f.review)).rejects.toThrow(
    'not found',
  );
  const tampered = await createPumpOrganicBatchReview({
    ...f.review,
    id: crypto.randomUUID(),
    buys: f.review.buys.map((b, n) => (n ? b : { ...b, batchOffsetMs: 1 })),
  });
  await expect(savePumpOrganicBatch(f.db, 'alice', tampered)).rejects.toThrow(
    'saved plan',
  );
  await savePumpOrganicBatch(f.db, 'alice', f.review);
  await expect(
    registerPumpOrganicBatch(f.db, 'alice', f.review.id, {
      consent: { ...f.consent, sha256: 'x' },
      transactions: f.signed.signed.map((s) => s.transaction),
    }),
  ).rejects.toThrow('Approve');
  await expect(
    f.client.execute(
      `UPDATE pump_organic_batches SET review='{}' WHERE id='${f.review.id}'`,
    ),
  ).rejects.toThrow('immutable');
});
