import bs58 from 'bs58';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stonkLaunchAddresses } from './stonkfun-launch';
import { dbcPoolAddress, dbcTokenVault } from './meteora-dbc-launch';
import { LAUNCHLAB_PLATFORMS } from './launchlab-platform-launch';

const record = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('./venue-launch-recovery', () => ({
  readVenueLaunchRecovery: vi.fn(async () => record.value),
}));
const { observeVenueSniper, readVenueSniperLaunch } =
  await import('./venue-sniper-guard-service');

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const sig = (n: number) =>
  bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i ? n : 1)));
const wsol = 'So11111111111111111111111111111111111111112';
const mint = key(50),
  payer = key(7),
  other = key(8),
  id = crypto.randomUUID();

function fakeDb(rows: {
  wallet?: { revision: number } | null;
  other?: { address: string } | null;
  proofs?: string[];
}) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () =>
          sql.includes('address<>?')
            ? (rows.other ?? null)
            : (rows.wallet ?? null),
        all: async () => ({
          results: (rows.proofs ?? []).map((address) => ({ address })),
        }),
      }),
    }),
  } as unknown as D1Database;
}

async function launchLabRecord(state = 'finalized') {
  const platformId = LAUNCHLAB_PLATFORMS.LetsBonk;
  const { pool } = await stonkLaunchAddresses(mint, wsol, platformId, payer);
  return {
    id,
    state,
    signature: sig(4),
    review: {
      input: { mint, quoteMint: wsol, payer, platformId },
      summary: { pool: String(pool), quoteSymbol: 'SOL', quoteDecimals: 9 },
    },
  };
}

describe('readVenueSniperLaunch', () => {
  beforeEach(() => {
    record.value = null;
  });
  it('derives the LaunchLab pool and quote vault from the saved launch', async () => {
    record.value = await launchLabRecord();
    const addresses = await stonkLaunchAddresses(
      mint,
      wsol,
      LAUNCHLAB_PLATFORMS.LetsBonk,
      payer,
    );
    const launch = await readVenueSniperLaunch(
      fakeDb({ wallet: { revision: 3 }, other: { address: other } }),
      'owner',
      'launchlab',
      id,
    );
    expect(launch).toEqual({
      venue: 'launchlab',
      id,
      state: 'finalized',
      mint,
      pool: String(addresses.pool),
      quoteVault: String(addresses.vaultB),
      quoteMint: wsol,
      quoteSymbol: 'SOL',
      quoteDecimals: 9,
      developer: payer,
      developerRevision: 3,
      cleanupDestination: other,
      signature: sig(4),
    });
  });
  it('derives the Meteora DBC pool and quote vault', async () => {
    const config = key(60);
    const pool = String(await dbcPoolAddress(config, mint, wsol));
    record.value = {
      id,
      state: 'submitted',
      signature: sig(5),
      review: {
        input: { mint, quoteMint: wsol, payer, config },
        summary: { pool, quoteSymbol: 'SOL', quoteDecimals: 9 },
      },
    };
    const launch = await readVenueSniperLaunch(
      fakeDb({}),
      'owner',
      'meteora-dbc',
      id,
    );
    expect(launch.pool).toBe(pool);
    expect(launch.quoteVault).toBe(String(await dbcTokenVault(pool, wsol)));
    expect(launch.developerRevision).toBeNull();
    expect(launch.cleanupDestination).toBeNull();
  });
  it('refuses unsent launches and a pool that differs from the review', async () => {
    record.value = await launchLabRecord('signed');
    await expect(
      readVenueSniperLaunch(fakeDb({}), 'owner', 'launchlab', id),
    ).rejects.toThrow(/broadcast/);
    const changed = await launchLabRecord();
    changed.review.summary.pool = key(61);
    record.value = changed;
    await expect(
      readVenueSniperLaunch(fakeDb({}), 'owner', 'launchlab', id),
    ).rejects.toThrow(/pool differs/);
  });
});

describe('observeVenueSniper', () => {
  it('reads only the pool and returns outside buys alone', async () => {
    const vault = key(43),
      pool = key(40),
      proven = key(12),
      outsider = key(13);
    const tx = (n: number, signer: string, before: string, after: string) => ({
      slot: 800 + n,
      blockTime: null,
      meta: {
        err: null,
        preBalances: [1, 1],
        postBalances: [1, 1],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: wsol,
            owner: key(44),
            uiTokenAmount: { amount: before },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: wsol,
            owner: key(44),
            uiTokenAmount: { amount: after },
          },
        ],
      },
      transaction: {
        signatures: [sig(n)],
        message: {
          accountKeys: [
            { pubkey: signer, signer: true },
            { pubkey: vault, signer: false },
          ],
        },
      },
    });
    const txs: Record<string, unknown> = {
      [sig(1)]: tx(1, outsider, '0', '500'),
      [sig(2)]: tx(2, proven, '500', '900'),
      [sig(3)]: tx(3, payer, '900', '1000'),
    };
    const methods: string[] = [];
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      methods.push(method);
      if (method === 'getSignaturesForAddress') {
        expect(params[0]).toBe(pool);
        return [3, 2, 1].map((n) => ({
          signature: sig(n),
          slot: 800 + n,
          err: null,
        }));
      }
      return txs[params[0] as string];
    });
    const read = await observeVenueSniper(
      fakeDb({ proofs: [proven] }),
      'owner',
      {
        venue: 'launchlab',
        id,
        state: 'finalized',
        mint,
        pool,
        quoteVault: vault,
        quoteMint: wsol,
        quoteSymbol: 'SOL',
        quoteDecimals: 9,
        developer: payer,
        developerRevision: 1,
        cleanupDestination: null,
        signature: null,
      },
      null,
      rpc,
      new AbortController().signal,
    );
    expect(read.buys.map((b) => b.signers)).toEqual([[outsider]]);
    expect(read.excludedCount).toBe(2);
    expect(read.cursor).toBe(sig(3));
    expect(new Set(methods)).toEqual(
      new Set(['getSignaturesForAddress', 'getTransaction']),
    );
  });
});
