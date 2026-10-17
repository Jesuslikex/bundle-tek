import { afterEach, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import bs58 from 'bs58';
import { getTransactionDecoder } from '@solana/kit-v1';
import { createTursoDatabase } from '../db/turso';
import {
  createVault,
  generateVaultWallets,
  type VaultSession,
} from './browser-wallet-vault';
import { solanaTransferMessage } from './solana-funding';
import { WRAPPED_SOL, type SolanaSwapPreparation } from './warmup-swap-quote';
import {
  signVolumeBatch,
  volumeBatchConsent,
  type VolumeBatchReview,
} from './volume-bot-batch';
import {
  cancelVolumeSession,
  createVolumeSession,
  estimateVolumeSession,
  observeVolumeBatch,
  prepareVolumeBatch,
  rawToDecimal,
  registerVolumeBatch,
  sendVolumeTrade,
  type VolumeDeps,
} from './volume-bot-service';
import { newVolumeSeed, type VolumeTerms } from './volume-bot-plan';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OTHER = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
const clients: Client[] = [];
let vault: VaultSession;
let wallets: string[];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
beforeAll(async () => {
  vault = generateVaultWallets(
    await createVault('synthetic volume bot vault'),
    'solana',
    2,
  );
  wallets = vault.payload.wallets.map((w) => w.address);
});
const signal = () => new AbortController().signal;
const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

async function fixture() {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,chain TEXT,address TEXT,document TEXT,revision INTEGER,archived INTEGER DEFAULT 0)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,archived INTEGER DEFAULT 0)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
    'CREATE TABLE pump_launch_reviews(owner_id TEXT,id TEXT,project_id TEXT,payer TEXT,review TEXT,state TEXT)',
  ])
    await client.execute(sql);
  await client.execute({
    sql: "INSERT INTO imported_token_projects VALUES('alice','p1','Solana',?,?,3,0)",
    args: [
      MINT,
      JSON.stringify({
        token: { chain: 'Solana', address: MINT, decimals: 6 },
      }),
    ],
  });
  for (const address of wallets)
    await client.execute({
      sql: "INSERT INTO workspace_wallets VALUES('alice','Solana',?,0)",
      args: [address],
    });
  for (const sql of readFileSync(
    'drizzle/0099_volume_bot_sessions.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await client.execute(sql);
  return { client, db: createTursoDatabase(client) };
}

/** Synthetic chain: one signer per packet, buys receive 5000 token units. */
function chain(options: { failRound?: number } = {}) {
  const sent = new Map<string, { wallet: string; side: 'Buy' | 'Sell' }>();
  const prepared: { side: string; amount: string; wallet: string }[] = [];
  let nonce = 1n;
  const pending = new Map<string, { wallet: string; side: 'Buy' | 'Sell' }>();
  const deps: VolumeDeps = {
    async prepareSwap(input) {
      prepared.push({
        side: input.side,
        amount: input.amount,
        wallet: input.wallet,
      });
      const bytes = Uint8Array.from([
        1,
        ...new Uint8Array(64),
        128,
        ...solanaTransferMessage(
          input.wallet,
          OTHER,
          '11111111111111111111111111111111',
          nonce++,
        ),
        0,
      ]);
      const transaction = btoa(String.fromCharCode(...bytes));
      pending.set(transaction.slice(100), {
        wallet: input.wallet,
        side: input.side,
      });
      return {
        executionAllowed: false,
        side: input.side,
        inputMint: input.side === 'Buy' ? WRAPPED_SOL : input.tokenMint,
        outputMint: input.side === 'Buy' ? input.tokenMint : WRAPPED_SOL,
        inAmount:
          input.side === 'Buy'
            ? String(Math.round(Number(input.amount) * 1e9))
            : String(Math.round(Number(input.amount) * 1e6)),
        outAmount: '1000',
        minimumOutAmount: '995',
        preparation: {
          wallet: input.wallet,
          transaction,
          sha256: await sha(bytes),
          estimatedFeesLamports: '5000',
          lastValidBlockHeight: '1000',
        },
      } as unknown as SolanaSwapPreparation;
    },
    async simulate() {},
    async rpc(method, params) {
      if (method === 'getBalance') return { value: 10_000_000_000 };
      if (method === 'getBlockHeight') return 900;
      if (method === 'sendTransaction') {
        const raw = params[0] as string;
        const tx = getTransactionDecoder().decode(
          Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
        );
        const signature = bs58.encode(
          Uint8Array.from(Object.values(tx.signatures)[0]!),
        );
        sent.set(signature, pending.get(raw.slice(100))!);
        return signature;
      }
      if (method === 'getSignatureStatuses')
        return {
          value: (params[0] as string[]).map((s) => {
            if (!sent.has(s)) return null;
            const round = [...sent.keys()].indexOf(s);
            return {
              slot: 10,
              confirmationStatus: 'finalized',
              err:
                options.failRound !== undefined &&
                sent.get(s)!.side === 'Buy' &&
                round === options.failRound * 2
                  ? { InstructionError: [0, 'Custom'] }
                  : null,
            };
          }),
        };
      if (method === 'getTransaction') {
        const { wallet, side } = sent.get(params[0] as string)!;
        const failed =
          options.failRound !== undefined &&
          side === 'Buy' &&
          [...sent.keys()].indexOf(params[0] as string) ===
            options.failRound * 2;
        const buy = side === 'Buy' && !failed;
        return {
          meta: {
            fee: 5000,
            preBalances: [1_000_000_000],
            postBalances: [
              side === 'Buy'
                ? 1_000_000_000 - (failed ? 5000 : 100_005_000)
                : 1_000_000_000 + 98_995_000,
            ],
            preTokenBalances:
              side === 'Sell'
                ? [{ owner: wallet, mint: MINT, uiTokenAmount: { amount: '5000' } }]
                : [],
            postTokenBalances: buy
              ? [{ owner: wallet, mint: MINT, uiTokenAmount: { amount: '5000' } }]
              : [],
          },
          transaction: { message: { accountKeys: [wallet] } },
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { deps, prepared };
}

const terms = (): VolumeTerms => ({
  targetVolumeLamports: '400000000',
  durationSeconds: 600,
  delayMinMs: 2_000,
  delayMaxMs: 3_000,
  amount: { kind: 'fixed', lamports: '100000000' },
  wave: 'tight',
  wallets,
});
type Session = Awaited<ReturnType<typeof createVolumeSession>>;
async function runBatch(
  db: D1Database,
  deps: VolumeDeps,
  session: Session,
): Promise<Session> {
  let current = await prepareVolumeBatch(
    db,
    'alice',
    session.id,
    signal(),
    deps,
  );
  const batch = current.batches.at(-1)!;
  if (batch.state === 'closed') return current;
  const review = batch.review as VolumeBatchReview;
  const signed = await signVolumeBatch(
    vault,
    review,
    volumeBatchConsent(review),
    () => {},
  );
  await registerVolumeBatch(db, 'alice', batch.id, {
    consent: volumeBatchConsent(review),
    transactions: signed.signed.map((s) => s.transaction),
  });
  for (const trade of review.trades)
    await sendVolumeTrade(db, 'alice', batch.id, trade.index, signal(), deps.rpc);
  current = await observeVolumeBatch(db, 'alice', batch.id, signal(), deps.rpc);
  return current;
}

it('runs a whole session batch by batch; each sell sells exactly its buy fill', async () => {
  const { db, client } = await fixture();
  const { deps, prepared } = chain();
  const input = {
    projectId: 'p1',
    projectRevision: 3,
    terms: terms(),
    seed: newVolumeSeed(),
  };
  const estimate = await estimateVolumeSession(
    db,
    'alice',
    input,
    signal(),
    deps.rpc,
  );
  expect(estimate.plan.estimate.rounds).toBe(2);
  let session = await createVolumeSession(db, 'alice', input, signal(), deps.rpc);
  expect(session.state).toBe('active');
  // The shared lock now refuses other swaps on these wallets.
  await expect(
    client.execute({
      sql: "INSERT INTO solana_execution_reservations VALUES('alice',?,'imported','x','reserved')",
      args: [wallets[0]],
    }),
  ).rejects.toThrow(/Volume Bot/);
  // A second session on the same wallets is refused.
  await expect(
    createVolumeSession(
      db,
      'alice',
      { ...input, seed: newVolumeSeed() },
      signal(),
      deps.rpc,
    ),
  ).rejects.toThrow(/busy/);
  for (let n = 0; n < session.plan.batches; n++)
    session = await runBatch(db, deps, session);
  expect(session.state).toBe('complete');
  expect(session.batches.every((b) => b.state === 'closed')).toBe(true);
  const sells = prepared.filter((p) => p.side === 'Sell');
  expect(sells).toHaveLength(2);
  expect(sells.every((s) => s.amount === rawToDecimal(5000n, 6))).toBe(true);
  expect(prepared.filter((p) => p.side === 'Buy').map((p) => p.amount)).toEqual(
    ['0.1', '0.1'],
  );
  expect(session.realized.finalizedTrades).toBe(4);
  expect(session.realized.volumeLamports).toBe(String(2 * 100_000_000 + 2 * 99_000_000));
  // Completed: the wallets are free again.
  await client.execute({
    sql: "INSERT INTO solana_execution_reservations VALUES('alice',?,'imported','x','reserved')",
    args: [wallets[0]],
  });
});

it('skips the sell of a buy that failed on chain', async () => {
  const { db } = await fixture();
  const { deps, prepared } = chain({ failRound: 0 });
  let session = await createVolumeSession(
    db,
    'alice',
    { projectId: 'p1', projectRevision: 3, terms: terms(), seed: newVolumeSeed() },
    signal(),
    deps.rpc,
  );
  for (let n = 0; n < session.plan.batches; n++)
    session = await runBatch(db, deps, session);
  expect(session.state).toBe('complete');
  const trades = session.batches.flatMap((b) => b.trades);
  expect(trades.filter((t) => t.state === 'failed')).toHaveLength(1);
  expect(prepared.filter((p) => p.side === 'Sell')).toHaveLength(1);
  expect(
    session.batches.flatMap((b) => (b.review as VolumeBatchReview).skipped),
  ).toHaveLength(1);
});

it('refuses wrong consent, early next batch and sends after cancel', async () => {
  const { db } = await fixture();
  const { deps } = chain();
  const session = await createVolumeSession(
    db,
    'alice',
    { projectId: 'p1', projectRevision: 3, terms: terms(), seed: newVolumeSeed() },
    signal(),
    deps.rpc,
  );
  const prepared = await prepareVolumeBatch(db, 'alice', session.id, signal(), deps);
  const batch = prepared.batches[0];
  const review = batch.review as VolumeBatchReview;
  await expect(
    prepareVolumeBatch(db, 'alice', session.id, signal(), deps),
  ).rejects.toThrow();
  const signed = await signVolumeBatch(vault, review, volumeBatchConsent(review), () => {});
  await expect(
    registerVolumeBatch(db, 'alice', batch.id, {
      consent: { ...volumeBatchConsent(review), sha256: '0'.repeat(64) },
      transactions: signed.signed.map((s) => s.transaction),
    }),
  ).rejects.toThrow(/Approve this exact/);
  await registerVolumeBatch(db, 'alice', batch.id, {
    consent: volumeBatchConsent(review),
    transactions: signed.signed.map((s) => s.transaction),
  });
  const cancelled = await cancelVolumeSession(db, 'alice', session.id);
  expect(cancelled.state).toBe('cancelled');
  const after = await sendVolumeTrade(
    db,
    'alice',
    batch.id,
    review.trades[0].index,
    signal(),
    deps.rpc,
  );
  expect(after.batches[0].trades[0].state).toBe('cancelled');
  await expect(
    prepareVolumeBatch(db, 'alice', session.id, signal(), deps),
  ).rejects.toThrow(/not active/);
});

it('refuses foreign wallets and stale project revisions', async () => {
  const { db } = await fixture();
  const { deps } = chain();
  await expect(
    createVolumeSession(
      db,
      'alice',
      {
        projectId: 'p1',
        projectRevision: 3,
        terms: { ...terms(), wallets: [OTHER] },
        seed: newVolumeSeed(),
      },
      signal(),
      deps.rpc,
    ),
  ).rejects.toThrow(/own active Solana wallets/);
  await expect(
    createVolumeSession(
      db,
      'alice',
      { projectId: 'p1', projectRevision: 2, terms: terms(), seed: newVolumeSeed() },
      signal(),
      deps.rpc,
    ),
  ).rejects.toThrow(/Project changed/);
});

it('formats exact atomic units as decimals', () => {
  expect(rawToDecimal(100_000_000n, 9)).toBe('0.1');
  expect(rawToDecimal(5n, 0)).toBe('5');
  expect(rawToDecimal(1_230_000n, 6)).toBe('1.23');
});
