import { describe, expect, it, vi } from 'vitest';
import {
  AutoSellUncertainError,
  createAutoSellExecutor,
} from './auto-sell-execute';
import type { VaultSession } from './browser-wallet-vault';

const MINT = 'Mint111111111111111111111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';
const W1 = 'Wal1111111111111111111111111111111111111111';
const W2 = 'Wal2111111111111111111111111111111111111111';
const session = { payload: { wallets: [] } } as unknown as VaultSession;
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function server(opts: { failWallet?: string; submitFails?: boolean } = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body });
    if (url.endsWith('/prepare')) {
      if (body.wallet === opts.failWallet)
        return ok({ error: 'Balance does not cover this sell.' }, 409);
      return ok({
        order: {
          side: 'Sell',
          inAmount: '1500000',
          inputMint: MINT,
          outputMint: SOL,
          preparation: { wallet: body.wallet, transaction: 'tx', sha256: 'h' },
        },
        history: { id: 'prep' },
        simulation: { succeeded: true },
        reviewWaitMs: 5000,
      });
    }
    if (body.action === 'review') {
      const wallet = calls.find(
        (c) => c.url.endsWith('/prepare') && c.body.wallet !== opts.failWallet,
      )!.body.wallet;
      return ok({
        review: {
          id: 'rev',
          preparationId: 'prep',
          wallet,
          sha256: 'h',
          transaction: 'tx',
          inputRaw: '1500000',
          inputMint: MINT,
          outputMint: SOL,
          network: 'mainnet',
        },
      });
    }
    if (body.action === 'submit' && opts.submitFails)
      return ok({ error: 'send unknown' }, 502);
    return ok({ signature: 'SIG', state: 'submitted' });
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

const make = (s: ReturnType<typeof server>) =>
  createAutoSellExecutor({
    projectId: 'p',
    projectRevision: 3,
    mint: MINT,
    decimals: 6,
    wallets: [
      { address: W1, revision: 1 },
      { address: W2, revision: 1 },
    ],
    session: () => session,
    fetcher: s.fetcher,
    sleep: async () => {},
    sign: vi.fn(async () => ({ signature: 'SIG', transaction: 'signed' })),
  });

describe('auto sell executor', () => {
  it('prepares, reviews, signs, registers and submits a sell', async () => {
    const s = server();
    const result = await make(s)(1_500_000n, new AbortController().signal);
    expect(result).toEqual({
      soldRaw: 1_500_000n,
      signature: 'SIG',
      wallet: W1,
    });
    expect(s.calls[0].body).toMatchObject({
      side: 'Sell',
      amount: '1.5',
      wallet: W1,
      revision: 3,
    });
    expect(s.calls.slice(1).map((c) => c.body.action)).toEqual([
      'review',
      'register',
      'submit',
    ]);
  });

  it('moves to the next wallet when one cannot cover the sell', async () => {
    const s = server({ failWallet: W1 });
    const result = await make(s)(1_500_000n, new AbortController().signal);
    expect(result.wallet).toBe(W2);
  });

  it('reports a signed but unconfirmed submission as uncertain', async () => {
    const s = server({ submitFails: true });
    await expect(
      make(s)(1_500_000n, new AbortController().signal),
    ).rejects.toBeInstanceOf(AutoSellUncertainError);
    expect(s.calls.filter((c) => c.url.endsWith('/prepare'))).toHaveLength(1);
  });

  it('never sends when Stop lands while registering', async () => {
    const s = server();
    const controller = new AbortController();
    const fetcher = vi.fn(
      async (url: string, init: RequestInit): Promise<Response> => {
        const body = JSON.parse(init.body as string);
        if (body.action === 'register') controller.abort();
        return s.fetcher(url, init);
      },
    );
    const sell = createAutoSellExecutor({
      projectId: 'p',
      projectRevision: 3,
      mint: MINT,
      decimals: 6,
      wallets: [{ address: W1, revision: 1 }],
      session: () => session,
      fetcher: fetcher as unknown as typeof fetch,
      sleep: async () => {},
      sign: vi.fn(async () => ({ signature: 'SIG', transaction: 'signed' })),
    });
    const error = await sell(1_500_000n, controller.signal).catch((e) => e);
    expect(error).not.toBeInstanceOf(AutoSellUncertainError);
    expect(error.message).toMatch(/before sending/);
    expect(s.calls.some((c) => c.body.action === 'submit')).toBe(false);
  });
});
