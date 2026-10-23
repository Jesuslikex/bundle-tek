import { vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  actVenueLaunchRecovery,
  type LaunchRecoveryVenue,
} from '../lib/venue-launch-recovery';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import {
  address,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import dbcGolden from '../test/meteora-dbc-sdk-golden.json';
import {
  buildMeteoraDbcMessage,
  WRAPPED_SOL,
  type MeteoraDbcInput,
} from '../lib/meteora-dbc-launch';
import type { MeteoraDbcReview } from '../lib/meteora-dbc-launch-service';
import {
  buildStonkLaunchMessage,
  stonkConfigId,
  STONKFUN_STANDARD_PLATFORM,
  TOKEN_PROGRAM,
  type StonkLaunchInput,
} from '../lib/stonkfun-launch';
import type { StonkLaunchReview } from '../lib/stonkfun-launch-service';

type Review = MeteoraDbcReview | StonkLaunchReview;
const payer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const mint = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
const other = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const payerAddress = bs58.encode(payer.publicKey);
const mintAddress = bs58.encode(mint.publicKey);
const decode = (packet: string) =>
  getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(packet, 'base64')),
  );
const encode = (
  tx: Parameters<ReturnType<typeof getTransactionEncoder>['encode']>[0],
) => getBase64Decoder().decode(getTransactionEncoder().encode(tx));
function sign(transaction: string, wrongPayer = false) {
  const tx = decode(transaction);
  const signatures: Record<string, SignatureBytes> = {};
  for (const [key, pair] of [
    [payerAddress, wrongPayer ? other : payer],
    [mintAddress, mint],
  ] as const)
    signatures[address(key)] = nacl.sign.detached(
      Uint8Array.from(tx.messageBytes),
      pair.secretKey,
    ) as SignatureBytes;
  return encode({ ...tx, signatures });
}
const commonInput = {
  name: 'Recovery Test',
  symbol: 'RCT',
  uri: 'https://bundle.test/api/launch/metadata/' + 'a'.repeat(64),
  payer: payerAddress,
  mint: mintAddress,
  quoteMint: WRAPPED_SOL,
  devBuyRaw: '0',
  minTokensOutRaw: '0',
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: '300000000',
};
const terms = {
  origin: 'https://bundle.test',
  projectId: 'recovery-test',
  updatedAt: '2026-10-23T00:00:00.000Z',
  releaseId: 'a'.repeat(64),
  payer: payerAddress,
  payerRevision: 1,
  mint: mintAddress,
  devBuyRaw: '0',
  solLimitLamports: '100000000',
};
const reviewTerms = Object.fromEntries(
  Object.entries(terms).filter(([key]) => key !== 'origin'),
) as Omit<typeof terms, 'origin'>;
const commonSummary = {
  quoteSymbol: 'SOL',
  quoteDecimals: 9,
  supplyRaw: '1000000000000000',
  devBuyRaw: '0',
  tokensOutRaw: '0',
  devSupplyBps: 0,
  solCostLamports: '10000',
  solLimitLamports: terms.solLimitLamports,
  unitsConsumed: 100000,
};
const reviews = {} as Record<'dbc' | 'stonk', Review>;
async function buildReviews() {
  const dbcInput: MeteoraDbcInput = {
    ...commonInput,
    config: dbcGolden.config,
    baseTokenType: 0,
    firstSwapWithMinFee: false,
  };
  const dbc = await buildMeteoraDbcMessage(dbcInput);
  reviews.dbc = {
    format: 'meteora-dbc-launch-review-v1',
    terms: { ...reviewTerms, config: dbcInput.config },
    input: dbcInput,
    transaction: dbc.transaction,
    sha256: dbc.packetSha256,
    // Intentionally expired. Authentication of retained signatures must still work.
    expiresAt: '2000-01-01T00:00:00.000Z',
    summary: {
      ...commonSummary,
      config: dbcInput.config,
      feeClaimer: payerAddress,
      pool: dbc.pool,
      baseDecimals: 6,
      tokenStandard: 'SPL',
      migrationThresholdRaw: '85000000000',
      creatorTradingFeePercent: 0,
      poolCreationFeeLamports: '0',
    },
  };
  const stonkInput: StonkLaunchInput = {
    ...commonInput,
    quoteTokenProgram: TOKEN_PROGRAM,
    platformId: STONKFUN_STANDARD_PLATFORM,
    configId: await stonkConfigId(WRAPPED_SOL),
    supply: '1000000000000000',
    totalSellA: '793100000000000',
    totalFundRaisingB: '85000000000',
    cpmmCreatorFeeOn: 0,
    allowConfig: true,
    curveRule: true,
  };
  const stonk = await buildStonkLaunchMessage(stonkInput);
  reviews.stonk = {
    format: 'stonkfun-launch-review-v1',
    terms: reviewTerms,
    input: stonkInput,
    transaction: stonk.transaction,
    sha256: stonk.packetSha256,
    expiresAt: '2000-01-01T00:00:00.000Z',
    summary: {
      ...commonSummary,
      platformName: 'Synthetic StonkFun',
      pool: stonk.pool,
      raiseRaw: stonkInput.totalFundRaisingB,
      startMarketCapUsd: null,
      graduationMarketCapUsd: null,
      pricingObservedAt: '2000-01-01T00:00:00.000Z',
    },
  };
}

/** Minimal explicit parent projections, with genuine 0145 table/triggers.
 * Packets use real builders and synthetic keypairs; no real funds or providers. */
export async function venueRecoveryFixture(venue: LaunchRecoveryVenue) {
  await buildReviews();
  const review = structuredClone(
    reviews[venue === 'meteora-dbc' ? 'dbc' : 'stonk'],
  );
  review.minimumSlot = 100;
  review.expiresAt = new Date(Date.now() + 60000).toISOString();
  const signed = sign(review.transaction);
  const signature = bs58.encode(
    decode(signed).signatures[address(payerAddress)]!,
  );
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER);
    CREATE TABLE workspace_wallets(owner_id TEXT,address TEXT,chain TEXT,revision INTEGER,archived INTEGER);
    CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT);
    CREATE TABLE pump_launch_reviews(owner_id TEXT,payer TEXT,state TEXT);`);
  sqlite.exec(readFileSync('drizzle/0145_venue_launch_recoveries.sql', 'utf8'));
  sqlite
    .prepare('INSERT INTO workspace_projects VALUES(?,?,?,?,0)')
    .run(
      'owner',
      review.terms.projectId,
      '{"synthetic":true}',
      review.terms.updatedAt,
    );
  sqlite
    .prepare("INSERT INTO workspace_wallets VALUES(?,?,'Solana',1,0)")
    .run('owner', payerAddress);
  sqlite
    .prepare("INSERT INTO wallet_ownership_proofs VALUES(?,'Solana',?)")
    .run('owner', payerAddress);
  const hooks: {
    beforeRun?: (sql: string, values: SQLInputValue[]) => void | Promise<void>;
    afterRun?: (sql: string, values: SQLInputValue[]) => void | Promise<void>;
  } = {};
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...v: unknown[]) {
          values = v as SQLInputValue[];
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { success: true, results: sqlite.prepare(sql).all(...values) };
        },
        async run() {
          await hooks.beforeRun?.(sql, values);
          const r = sqlite.prepare(sql).run(...values);
          await hooks.afterRun?.(sql, values);
          return {
            success: true,
            results: [],
            meta: { changes: Number(r.changes) },
          };
        },
      };
    },
  } as unknown as D1Database;
  const rpc = vi.fn(
    async (
      method: string,
      _params: unknown[],
      _s: AbortSignal,
    ): Promise<unknown> => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getTransaction') return null;
      if (method === 'getEpochInfo')
        return { absoluteSlot: '300000100', blockHeight: '300000000' };
      if (method === 'getAccountInfo')
        return { context: { slot: '300000100' }, value: null };
      if (method === 'sendTransaction') return signature;
      throw Error('Unexpected synthetic recovery method ' + method);
    },
  );
  const submit = vi.fn(
    async (
      _db: D1Database,
      _owner: string,
      _terms: unknown,
      _input: unknown,
      packet: string,
      signal: AbortSignal,
      deps: {
        rpc?: (
          method: string,
          params: unknown[],
          signal: AbortSignal,
        ) => Promise<unknown>;
      } = {},
    ) => {
      let state: 'sent' | 'unknown' = 'sent';
      try {
        await deps.rpc!(
          'sendTransaction',
          [
            packet,
            {
              encoding: 'base64',
              skipPreflight: false,
              maxRetries: 0,
              preflightCommitment: 'confirmed',
            },
          ],
          signal,
        );
      } catch {
        state = 'unknown';
      }
      return {
        state,
        signature,
        mint: mintAddress,
        pool: address(review.summary.pool),
      };
    },
  );
  const deps: NonNullable<Parameters<typeof actVenueLaunchRecovery>[5]> = {
    rpc,
    prepareDbc: vi.fn(async () => structuredClone(review as MeteoraDbcReview)),
    prepareStonk: vi.fn(async () =>
      structuredClone(review as StonkLaunchReview),
    ),
    submitDbc: submit,
    submitStonk: submit,
  };
  return {
    db,
    sqlite,
    hooks,
    review,
    signed,
    signature,
    rpc,
    submit,
    deps,
    venue,
    terms: { ...review.terms, origin: 'https://bundle.test' },
    owner: 'owner',
    dispose: () => sqlite.close(),
  };
}
