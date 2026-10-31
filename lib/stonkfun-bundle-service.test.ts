import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import golden from '@/test/stonkfun-curve-sdk-golden.json';

vi.mock('./workspace-project', () => ({
  validateProjectDocument: (v: unknown) => v,
}));

import {
  buildStonkLaunchMessage,
  LAUNCHLAB_PROGRAM,
  stonkConfigId,
  STONKFUN_STANDARD_PLATFORM,
  TOKEN_PROGRAM,
  WRAPPED_SOL,
  type StonkLaunchInput,
} from './stonkfun-launch';
import {
  prepareStonkBundle,
  type StonkBundleTerms,
} from './stonkfun-bundle-service';
import type { StonkLaunchReview } from './stonkfun-launch-service';
import { verifyStonkBundleReview } from './stonkfun-bundle';

const key = (n: number) =>
  bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(n)).publicKey);
const TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const signal = () => new AbortController().signal;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function setup(
  opts: {
    holderLamports?: number;
    recipients?: { address: string; revision: number }[];
    tokensOutRaw?: string;
    simulateBundle?: 'unsupported' | 'succeeded' | 'failed';
  } = {},
) {
  const input: StonkLaunchInput = {
    name: 'Bundle Test',
    symbol: 'BNDL',
    uri: 'https://bundle.test/api/launch/metadata/' + 'a'.repeat(64),
    payer: key(1),
    mint: key(2),
    quoteMint: WRAPPED_SOL,
    quoteTokenProgram: TOKEN_PROGRAM,
    platformId: STONKFUN_STANDARD_PLATFORM,
    configId: await stonkConfigId(WRAPPED_SOL),
    supply: '1000000000000000',
    totalSellA: '793100000000000',
    totalFundRaisingB: '85000000000',
    cpmmCreatorFeeOn: 0,
    allowConfig: true,
    curveRule: true,
    devBuyRaw: '1000000000',
    minTokensOutRaw: golden.steps[0].tokensOut,
    blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    lastValidBlockHeight: '300000000',
  };
  const built = await buildStonkLaunchMessage(input);
  const holders = [
    { address: key(10), revision: 1, buyRaw: golden.steps[1].amountB },
    { address: key(11), revision: 1, buyRaw: golden.steps[2].amountB },
  ];
  const terms: StonkBundleTerms = {
    origin: 'https://bundle.test',
    projectId: 'p1',
    updatedAt: '2026-10-31T00:00:00.000Z',
    releaseId: 'a'.repeat(64),
    payer: key(1),
    payerRevision: 1,
    mint: key(2),
    devBuyRaw: '1000000000',
    solLimitLamports: '50000000',
    holders,
    tipLamports: '100000',
  };
  const base: StonkLaunchReview = {
    format: 'stonkfun-launch-review-v1',
    minimumSlot: 100,
    terms: {
      projectId: 'p1',
      updatedAt: terms.updatedAt,
      releaseId: terms.releaseId,
      payer: terms.payer,
      payerRevision: 1,
      mint: terms.mint,
      devBuyRaw: terms.devBuyRaw,
      solLimitLamports: terms.solLimitLamports,
    },
    input,
    transaction: built.transaction,
    sha256: built.packetSha256,
    expiresAt: new Date(Date.now() + 45000).toISOString(),
    summary: {
      platformName: 'StonkFun',
      pool: built.pool,
      quoteSymbol: 'SOL',
      quoteDecimals: 9,
      raiseRaw: input.totalFundRaisingB,
      supplyRaw: input.supply,
      devBuyRaw: input.devBuyRaw,
      tokensOutRaw: opts.tokensOutRaw ?? golden.steps[0].tokensOut,
      devSupplyBps: 340,
      solCostLamports: '20000000',
      solLimitLamports: terms.solLimitLamports,
      unitsConsumed: 1,
      startMarketCapUsd: null,
      graduationMarketCapUsd: null,
      pricingObservedAt: new Date().toISOString(),
    },
  };
  const pool = new Uint8Array(400),
    pv = new DataView(pool.buffer);
  pv.setBigUint64(29, 793100000000000n, true);
  pv.setBigUint64(37, BigInt(golden.virtualA), true);
  pv.setBigUint64(45, BigInt(golden.virtualB), true);
  pv.setBigUint64(53, BigInt(golden.steps[1].realA), true);
  pv.setBigUint64(61, BigInt(golden.steps[1].realB), true);
  const config = new Uint8Array(400),
    platform = new Uint8Array(900);
  new DataView(config.buffer).setBigUint64(27, 2500n, true);
  new DataView(platform.buffer).setBigUint64(104, 10000n, true);
  new DataView(platform.buffer).setBigUint64(720, 5000n, true);
  const account = (data: Uint8Array, lamports = 1) => ({
    data: [b64(data), 'base64'],
    owner: LAUNCHLAB_PROGRAM,
    lamports,
  });
  const rpc = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'getMultipleAccounts')
      return {
        value: [
          account(config),
          account(platform),
          ...holders.map(() => ({
            data: ['', 'base64'],
            owner: '11111111111111111111111111111111',
            lamports: opts.holderLamports ?? 2_000_000_000,
          })),
        ],
      };
    if (method === 'getBalance') return { value: 5_000_000_000 };
    if (method === 'simulateTransaction')
      return { value: { err: null, accounts: [account(pool)] } };
    if (method === 'simulateBundle') {
      if (!opts.simulateBundle || opts.simulateBundle === 'unsupported')
        throw new Error('Method not found');
      return {
        value: {
          summary:
            opts.simulateBundle === 'succeeded'
              ? 'succeeded'
              : { failed: { error: 'x' } },
        },
      };
    }
    throw new Error('unexpected ' + method);
  });
  const document = JSON.stringify({
    options: {
      wallets: {
        chain: 'Solana',
        recipients: (opts.recipients ?? holders).map((h) => ({
          address: h.address,
          revision: h.revision,
          folderRevision: 0,
          root: true,
        })),
      },
    },
  });
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes('FROM workspace_projects'))
            return { document, updated_at: terms.updatedAt, archived: 0 };
          return { ok: 1 };
        },
      };
    },
  } as unknown as D1Database;
  const deps = {
    rpc,
    prepareLaunch: vi.fn(async () => structuredClone(base)),
    tipAccounts: async () => [TIP],
  };
  return { db, terms, deps, rpc, base };
}

describe('prepareStonkBundle', () => {
  it('sizes holder buys on the created curve and builds the bundle', async () => {
    const s = await setup();
    const review = await prepareStonkBundle(
      s.db,
      'owner',
      s.terms,
      signal(),
      s.deps,
    );
    expect(review.bundle.holders.map((h) => h.expectedTokensOutRaw)).toEqual([
      golden.steps[1].tokensOut,
      golden.steps[2].tokensOut,
    ]);
    for (const h of review.bundle.holders)
      expect(BigInt(h.minTokensOutRaw)).toBe(
        (BigInt(h.expectedTokensOutRaw) * 9900n) / 10000n,
      );
    expect(review.bundle.tipAccount).toBe(TIP);
    expect(review.bundle.bundleSimulated).toBe(false);
    expect(review.terms.holders).toEqual(s.terms.holders);
    expect(review.sha256).toBe(s.base.sha256);
    await expect(verifyStonkBundleReview(review)).resolves.toBeTruthy();
  });

  it('marks a successful whole-bundle replay and refuses a failed one', async () => {
    const ok = await setup({ simulateBundle: 'succeeded' });
    expect(
      (await prepareStonkBundle(ok.db, 'owner', ok.terms, signal(), ok.deps))
        .bundle.bundleSimulated,
    ).toBe(true);
    const bad = await setup({ simulateBundle: 'failed' });
    await expect(
      prepareStonkBundle(bad.db, 'owner', bad.terms, signal(), bad.deps),
    ).rejects.toThrow(/Bundle simulation rejected/);
  });

  it('refuses wallets that are not saved project holders', async () => {
    const s = await setup({
      recipients: [{ address: key(10), revision: 1 }],
    });
    await expect(
      prepareStonkBundle(s.db, 'owner', s.terms, signal(), s.deps),
    ).rejects.toThrow(/Save each bundle wallet/);
    expect(s.deps.prepareLaunch).not.toHaveBeenCalled();
  });

  it('refuses underfunded holders', async () => {
    const s = await setup({ holderLamports: 1000 });
    await expect(
      prepareStonkBundle(s.db, 'owner', s.terms, signal(), s.deps),
    ).rejects.toThrow(/needs/);
  });

  it('refuses when curve math disagrees with the simulated creator buy', async () => {
    const s = await setup({ tokensOutRaw: '34026261107561' });
    await expect(
      prepareStonkBundle(s.db, 'owner', s.terms, signal(), s.deps),
    ).rejects.toThrow(/curve math differs/);
  });

  it('refuses malformed holder terms', async () => {
    const s = await setup();
    for (const holders of [
      [],
      [{ address: key(1), revision: 1, buyRaw: '1' }],
      [{ address: key(10), revision: 1, buyRaw: '0' }],
      Array.from({ length: 7 }, (_, i) => ({
        address: key(20 + i),
        revision: 1,
        buyRaw: '1',
      })),
    ])
      await expect(
        prepareStonkBundle(
          s.db,
          'owner',
          { ...s.terms, holders },
          signal(),
          s.deps,
        ),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      prepareStonkBundle(
        s.db,
        'owner',
        { ...s.terms, tipLamports: '50' },
        signal(),
        s.deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
