import { describe, expect, it, vi } from 'vitest';
import {
  createRotatingTrader,
  executeAcrossWallets,
  executeImportedTrade,
  percentOfBalance,
  readTradeWalletBalance,
  SOL_MINT,
  TradeUncertainError,
} from './imported-trade-execute';
import type { VaultSession } from './browser-wallet-vault';

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const W = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const session = { payload: { wallets: [] } } as unknown as VaultSession;
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
function server(
  side: 'Buy' | 'Sell',
  opts: { submitFails?: boolean; badReview?: boolean } = {},
) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const inputMint = side === 'Buy' ? SOL_MINT : MINT;
  const outputMint = side === 'Buy' ? MINT : SOL_MINT;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body });
    if (url.endsWith('/balance'))
      return ok({
        id: 'p1',
        report: {
          wallet: W,
          mint: MINT,
          nativeRaw: '2000000000',
          unfrozenRaw: '1000',
        },
      });
    if (url.endsWith('/prepare'))
      return ok({
        order: {
          side,
          inAmount: side === 'Buy' ? '100000000' : '500',
          inputMint,
          outputMint,
          preparation: { wallet: W, transaction: 'tx', sha256: 'h' },
        },
        history: { id: 'prep1' },
        simulation: { succeeded: true },
        reviewWaitMs: 3000,
      });
    if (body.action === 'review')
      return ok({
        review: {
          id: 'intent1',
          preparationId: 'prep1',
          wallet: W,
          sha256: 'h',
          transaction: 'tx',
          inputRaw: side === 'Buy' ? '100000000' : '500',
          inputMint: opts.badReview ? MINT : inputMint,
          outputMint,
          network: 'mainnet',
        },
      });
    if (body.action === 'submit' && opts.submitFails)
      return ok({ error: 'unknown' }, 502);
    return ok({
      signature: 'sig1',
      state: body.action === 'register' ? 'signed' : 'submitted',
    });
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}
const ctx = (s: ReturnType<typeof server>) => ({
  projectId: 'p1',
  projectRevision: 2,
  mint: MINT,
  decimals: 6,
  session: () => session,
  fetcher: s.fetcher,
  sleep: vi.fn(async () => {}),
  sign: vi.fn(async () => ({
    signature: 'sig1',
    transaction: 'signed-tx',
  })) as never,
});

describe('executeImportedTrade', () => {
  it('runs a buy through prepare, review, sign, register and one submit', async () => {
    const s = server('Buy');
    const c = ctx(s);
    const r = await executeImportedTrade(
      c,
      { address: W, revision: 1 },
      'Buy',
      100000000n,
      new AbortController().signal,
    );
    expect(r.signature).toBe('sig1');
    expect(s.calls[0].body).toMatchObject({
      side: 'Buy',
      amount: '0.1',
      wallet: W,
    });
    expect(c.sleep).toHaveBeenCalledWith(3100, expect.anything());
    expect(s.calls.filter((x) => x.body.action === 'submit')).toHaveLength(1);
  });
  it('sells token units with the token decimals', async () => {
    const s = server('Sell');
    await executeImportedTrade(
      ctx(s),
      { address: W, revision: 1 },
      'Sell',
      500n,
      new AbortController().signal,
    );
    expect(s.calls[0].body).toMatchObject({ side: 'Sell', amount: '0.0005' });
  });
  it('refuses a review that swaps the mints, before signing', async () => {
    const s = server('Buy', { badReview: true });
    const c = ctx(s);
    await expect(
      executeImportedTrade(
        c,
        { address: W, revision: 1 },
        'Buy',
        100000000n,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/differs/);
    expect(c.sign).not.toHaveBeenCalled();
  });
  it('reports a signed trade with unknown submission as uncertain', async () => {
    const s = server('Buy', { submitFails: true });
    await expect(
      executeImportedTrade(
        ctx(s),
        { address: W, revision: 1 },
        'Buy',
        100000000n,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(TradeUncertainError);
  });
  it('refuses when the vault is locked', async () => {
    const s = server('Buy');
    await expect(
      executeImportedTrade(
        { ...ctx(s), session: () => null },
        { address: W, revision: 1 },
        'Buy',
        100000000n,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/locked/);
  });
  it('reads wallet balances', async () => {
    const s = server('Buy');
    const b = await readTradeWalletBalance(
      ctx(s),
      { address: W, revision: 1 },
      new AbortController().signal,
    );
    expect(b).toEqual({ nativeRaw: 2000000000n, tokenRaw: 1000n });
  });
});

describe('executeAcrossWallets', () => {
  const wallets = [
    { address: 'a', revision: 1 },
    { address: 'b', revision: 1 },
    { address: 'c', revision: 1 },
  ];
  it('staggers with the delay and keeps going after one failure', async () => {
    const sleep = vi.fn(async () => {});
    const run = vi.fn(async (w: { address: string }) => {
      if (w.address === 'b') throw new Error('no');
      return {
        side: 'Buy' as const,
        wallet: w.address,
        inputRaw: '1',
        signature: 's',
        preparationId: 'p',
      };
    });
    const out = await executeAcrossWallets(
      wallets,
      'Stagger',
      800,
      run,
      new AbortController().signal,
      sleep,
    );
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(800, expect.anything());
  });
  it('parallel starts every wallet without delay', async () => {
    const sleep = vi.fn(async () => {});
    const run = vi.fn(async (w: { address: string }) => ({
      side: 'Sell' as const,
      wallet: w.address,
      inputRaw: '1',
      signature: 's',
      preparationId: 'p',
    }));
    const out = await executeAcrossWallets(
      wallets,
      'Parallel',
      800,
      run,
      new AbortController().signal,
      sleep,
    );
    expect(out).toHaveLength(3);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('stops starting new wallets after abort', async () => {
    const c = new AbortController();
    const run = vi.fn(async (w: { address: string }) => {
      c.abort();
      return {
        side: 'Buy' as const,
        wallet: w.address,
        inputRaw: '1',
        signature: 's',
        preparationId: 'p',
      };
    });
    const out = await executeAcrossWallets(
      wallets,
      'Stagger',
      0,
      run,
      c.signal,
    );
    expect(out).toHaveLength(1);
  });
});

it('percentOfBalance handles 4 decimals and bounds', () => {
  expect(percentOfBalance(1000000n, '50')).toBe(500000n);
  expect(percentOfBalance(1000000n, '0.0001')).toBe(1n);
  expect(percentOfBalance(1000000n, '100')).toBe(1000000n);
  expect(() => percentOfBalance(1n, '101')).toThrow();
  expect(() => percentOfBalance(1n, '0')).toThrow();
});

describe('createRotatingTrader', () => {
  it('rotates wallets and falls through pre-sign failures but not signed ones', async () => {
    const s = server('Buy');
    const c = ctx(s);
    const W2 = 'So11111111111111111111111111111111111111112';
    const trader = createRotatingTrader(
      c,
      [
        { address: W2, revision: 1 },
        { address: W, revision: 1 },
      ],
      'Buy',
    );
    // W2's preparation mismatches the server's fixed wallet, so it falls through to W
    const r = await trader(100000000n, new AbortController().signal);
    expect(r.wallet).toBe(W);
    const s2 = server('Buy', { submitFails: true });
    const t2 = createRotatingTrader(
      ctx(s2),
      [
        { address: W, revision: 1 },
        { address: W2, revision: 1 },
      ],
      'Buy',
    );
    await expect(
      t2(100000000n, new AbortController().signal),
    ).rejects.toBeInstanceOf(TradeUncertainError);
    expect(s2.calls.filter((x) => x.url.endsWith('/prepare'))).toHaveLength(1);
  });
});
