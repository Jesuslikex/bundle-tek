import type { TokenMarket } from './token-market';
import { VOLUME_NATIVE_MINT } from './volume-usd-target';
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
  quoteVolumeUsdTarget,
  cancelVolumeSession,
  createVolumeSession,
  estimateVolumeSession,
  listVolumeSessions,
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
  for (const file of [
    'drizzle/0093_pump_organic_sequences.sql',
    'drizzle/0098_volume_bot_sessions.sql',
    'drizzle/0102_volume_usd_targets.sql',
  ])
    for (const sql of readFileSync(file, 'utf8').split(
      '--> statement-breakpoint',
    ))
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
                ? [
                    {
                      owner: wallet,
                      mint: MINT,
                      uiTokenAmount: { amount: '5000' },
                    },
                  ]
                : [],
            postTokenBalances: buy
              ? [
                  {
                    owner: wallet,
                    mint: MINT,
                    uiTokenAmount: { amount: '5000' },
                  },
                ]
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
it('retains the exact numeric wave in the estimate, saved plan and owned reload', async () => {
  const { db } = await fixture();
  const { deps } = chain();
  const input = {
    projectId: 'p1',
    projectRevision: 3,
    terms: { ...terms(), wave: 'big-waves' as const, waveIntensityTenths: 7 },
    seed: newVolumeSeed(),
  };
  const estimate = await estimateVolumeSession(
    db,
    'alice',
    input,
    signal(),
    deps.rpc,
  );
  const saved = await createVolumeSession(
    db,
    'alice',
    input,
    signal(),
    deps.rpc,
  );
  expect(saved.plan).toEqual(estimate.plan);
  expect(saved.plan.terms.waveIntensityTenths).toBe(7);
  const reloaded = await listVolumeSessions(db, 'alice', 'p1');
  expect(reloaded.find((session) => session.id === saved.id)?.plan).toEqual(
    saved.plan,
  );
  expect(await listVolumeSessions(db, 'bob', 'p1')).toEqual([]);
});

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
    await sendVolumeTrade(
      db,
      'alice',
      batch.id,
      trade.index,
      signal(),
      deps.rpc,
    );
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
  let session = await createVolumeSession(
    db,
    'alice',
    input,
    signal(),
    deps.rpc,
  );
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
  expect(session.realized.volumeLamports).toBe(
    String(2 * 100_000_000 + 2 * 99_000_000),
  );
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
    {
      projectId: 'p1',
      projectRevision: 3,
      terms: terms(),
      seed: newVolumeSeed(),
    },
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
    {
      projectId: 'p1',
      projectRevision: 3,
      terms: terms(),
      seed: newVolumeSeed(),
    },
    signal(),
    deps.rpc,
  );
  const prepared = await prepareVolumeBatch(
    db,
    'alice',
    session.id,
    signal(),
    deps,
  );
  const batch = prepared.batches[0];
  const review = batch.review as VolumeBatchReview;
  await expect(
    prepareVolumeBatch(db, 'alice', session.id, signal(), deps),
  ).rejects.toThrow();
  const signed = await signVolumeBatch(
    vault,
    review,
    volumeBatchConsent(review),
    () => {},
  );
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
      {
        projectId: 'p1',
        projectRevision: 2,
        terms: terms(),
        seed: newVolumeSeed(),
      },
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

it('keeps Volume Bot and organic holder-buy sequences off the same wallets', async () => {
  const { db, client } = await fixture();
  const { deps } = chain();
  const organic = (id: string, address: string) =>
    client.execute({
      sql: "INSERT INTO pump_organic_sequences(id,owner_id,project_id,launch_review_id,mint,rent_allowance_raw,plan,plan_sha256,state) VALUES(?,'alice','p0','r',?,'0',?,'h','active')",
      args: [id, MINT, JSON.stringify({ rows: [{ address }] })],
    });
  await organic('o1', wallets[0]);
  await expect(
    createVolumeSession(
      db,
      'alice',
      {
        projectId: 'p1',
        projectRevision: 3,
        terms: terms(),
        seed: newVolumeSeed(),
      },
      signal(),
      deps.rpc,
    ),
  ).rejects.toThrow(/busy/);
  await client.execute("UPDATE pump_organic_sequences SET state='complete'");
  await createVolumeSession(
    db,
    'alice',
    {
      projectId: 'p1',
      projectRevision: 3,
      terms: terms(),
      seed: newVolumeSeed(),
    },
    signal(),
    deps.rpc,
  );
  await expect(organic('o2', wallets[1])).rejects.toThrow(/Volume Bot/);
});

it('captures owned USD targets and binds the exact evidence into estimates and immutable sessions', async () => {
  const { db, client } = await fixture();

  const quote = (
    await quoteVolumeUsdTarget(
      db,
      'alice',
      { projectId: 'p1', projectRevision: 3, targetUsd: '80' },
      signal(),
      async () => market(),
    )
  ).quote;
  const input = {
    projectId: 'p1',
    projectRevision: 3,
    terms: terms(),
    seed: newVolumeSeed(),
    usdQuoteId: quote.id,
  };
  const { deps } = chain();
  const estimate = await estimateVolumeSession(
    db,
    'alice',
    input,
    signal(),
    deps.rpc,
  );
  expect(estimate.plan.usdTarget).toEqual(quote);
  const session = await createVolumeSession(
    db,
    'alice',
    input,
    signal(),
    deps.rpc,
  );
  expect(session.plan.usdTarget).toEqual(quote);
  await expect(
    client.execute({
      sql: 'UPDATE volume_bot_sessions SET plan=plan WHERE id=?',
      args: [session.id],
    }),
  ).rejects.toThrow(/immutable/);
  await expect(
    client.execute({
      sql: 'UPDATE volume_bot_usd_targets SET document=document WHERE id=?',
      args: [quote.id],
    }),
  ).rejects.toThrow(/immutable/);
  await cancelVolumeSession(db, 'alice', session.id);
  await expect(
    createVolumeSession(db, 'alice', input, signal(), deps.rpc),
  ).rejects.toThrow(/already used/);
});
it('refuses foreign, revised, changed and expired USD targets before wallet reads', async () => {
  const { db } = await fixture();
  const quote = (
    await quoteVolumeUsdTarget(
      db,
      'alice',
      { projectId: 'p1', projectRevision: 3, targetUsd: '80' },
      signal(),
      async () => market(new Date(Date.now() - 59000).toISOString()),
    )
  ).quote;
  const input = {
    projectId: 'p1',
    projectRevision: 3,
    terms: terms(),
    seed: newVolumeSeed(),
    usdQuoteId: quote.id,
  };
  let reads = 0;
  const rpc = async () => {
    reads++;
    return { value: 10000000000 };
  };
  for (const change of [
    { usdQuoteId: crypto.randomUUID() },
    { terms: { ...terms(), targetVolumeLamports: '400000001' } },
    { projectRevision: 4 },
  ])
    await expect(
      estimateVolumeSession(
        db,
        'alice',
        { ...input, ...change },
        signal(),
        rpc,
      ),
    ).rejects.toThrow();
  expect(reads).toBe(0);
  const { vi } = await import('vitest');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(quote.expiresAt));
  try {
    await expect(
      estimateVolumeSession(db, 'alice', input, signal(), rpc),
    ).rejects.toThrow(/expired/);
  } finally {
    vi.restoreAllMocks();
  }
  expect(reads).toBe(0);
});
it('does not read markets for unowned projects and sanitizes provider failures', async () => {
  const { db } = await fixture();
  let reads = 0;
  const read = async () => {
    reads++;
    throw new Error('private-provider-detail');
  };
  await expect(
    quoteVolumeUsdTarget(
      db,
      'mallory',
      { projectId: 'p1', projectRevision: 3, targetUsd: '80' },
      signal(),
      read,
    ),
  ).rejects.toThrow();
  expect(reads).toBe(0);
  await expect(
    quoteVolumeUsdTarget(
      db,
      'alice',
      { projectId: 'p1', projectRevision: 3, targetUsd: '80' },
      signal(),
      read,
    ),
  ).rejects.toThrow('SOL/USD market price is unavailable. Try again later.');
});

function market(at = new Date(Date.now() - 1000).toISOString()): TokenMarket {
  return {
    chain: 'Solana',
    address: VOLUME_NATIVE_MINT,
    source: 'api.dexscreener.com',
    observedAt: at,
    returnedPairCount: 1,
    quoteOnlyPairCount: 0,
    executionAllowed: false,
    pairs: [
      {
        address: VOLUME_NATIVE_MINT,
        dex: 'synthetic',
        url: 'https://dexscreener.com/solana/' + VOLUME_NATIVE_MINT,
        quoteSymbol: 'USDC',
        priceUsd: '200',
        liquidityUsd: 100000,
        volume24hUsd: null,
        change24h: null,
        marketCapUsd: null,
      },
    ],
  };
}

it('enforces captured owner, target, time and non-null evidence at the SQL boundary', async () => {
  const { db, client } = await fixture();
  const { deps } = chain();
  const quote = (
    await quoteVolumeUsdTarget(
      db,
      'alice',
      { projectId: 'p1', projectRevision: 3, targetUsd: '80' },
      signal(),
      async () => market(),
    )
  ).quote;
  const input = {
    projectId: 'p1',
    projectRevision: 3,
    terms: terms(),
    seed: newVolumeSeed(),
    usdQuoteId: quote.id,
  };
  const { plan } = await estimateVolumeSession(
    db,
    'alice',
    input,
    signal(),
    deps.rpc,
  );
  for (const change of [
    { owner: 'mallory' },
    { target: '400000001' },
    { evidence: { ...quote, solPriceUsd: '201' } },
    { evidence: null },
  ]) {
    const altered = {
      ...plan,
      terms: {
        ...plan.terms,
        targetVolumeLamports: change.target ?? plan.terms.targetVolumeLamports,
      },
      ...('evidence' in change ? { usdTarget: change.evidence } : {}),
    };
    await expect(
      client.execute({
        sql: "INSERT INTO volume_bot_sessions(id,owner_id,project_id,project_revision,mint,decimals,plan,plan_sha256,state) VALUES(?,?,'p1',3,?,6,?,?,'active')",
        args: [
          crypto.randomUUID(),
          change.owner ?? 'alice',
          MINT,
          JSON.stringify(altered),
          'a'.repeat(64),
        ],
      }),
    ).rejects.toThrow(/USD target/);
  }
  await expect(
    client.execute({
      sql: 'INSERT INTO volume_bot_usd_targets VALUES(?,?,?,?,?,?)',
      args: [
        crypto.randomUUID(),
        'alice',
        'p1',
        3,
        '{}',
        new Date().toISOString(),
      ],
    }),
  ).rejects.toThrow();
  const old = {
    ...quote,
    id: crypto.randomUUID(),
    observedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:01:00.000Z',
  };
  await client.execute({
    sql: 'INSERT INTO volume_bot_usd_targets VALUES(?,?,?,?,?,?)',
    args: [old.id, 'alice', 'p1', 3, JSON.stringify(old), old.expiresAt],
  });
  await expect(
    client.execute({
      sql: "INSERT INTO volume_bot_sessions VALUES(?,'alice','p1',3,?,6,?,?,'active',?)",
      args: [
        crypto.randomUUID(),
        MINT,
        JSON.stringify({ ...plan, usdTarget: old }),
        'a'.repeat(64),
        new Date().toISOString(),
      ],
    }),
  ).rejects.toThrow(/USD target/);
});

it('refuses USD estimates if the project changes during balance observation', async () => {
  const { db, client } = await fixture();
  const quote = (
    await quoteVolumeUsdTarget(
      db,
      'alice',
      { projectId: 'p1', projectRevision: 3, targetUsd: '80' },
      signal(),
      async () => market(),
    )
  ).quote;
  const input = {
    projectId: 'p1',
    projectRevision: 3,
    terms: terms(),
    seed: newVolumeSeed(),
    usdQuoteId: quote.id,
  };
  const rpc = async () => {
    await client.execute(
      "UPDATE imported_token_projects SET archived=1 WHERE id='p1'",
    );
    return { value: 10000000000 };
  };
  await expect(
    estimateVolumeSession(db, 'alice', input, signal(), rpc),
  ).rejects.toThrow(/changed or expired/);
});

it('keeps the database future-observation guard even when the application clock accepts it', async () => {
  const { db } = await fixture();
  const { vi } = await import('vitest');
  const future = Date.now() + 60000;
  const observation = market(new Date(future).toISOString());
  vi.spyOn(Date, 'now').mockReturnValue(future);
  try {
    await expect(
      quoteVolumeUsdTarget(
        db,
        'alice',
        { projectId: 'p1', projectRevision: 3, targetUsd: '80' },
        signal(),
        async () => observation,
      ),
    ).rejects.toThrow('USD capture expired or the project changed');
  } finally {
    vi.restoreAllMocks();
  }
});
