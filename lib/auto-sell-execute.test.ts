import { describe, expect, it, vi } from 'vitest';
import {
  AutoSellUncertainError,
  createAutoSellExecutor,
} from './auto-sell-execute';
import { autoSellOutcomeReference as retained } from '../test/auto-sell-outcome-fixture';
import type { VaultSession } from './browser-wallet-vault';

const MINT = retained.mint;
const SOL = 'So11111111111111111111111111111111111111112';
const W1 = retained.wallet;
const W2 = SOL;
const session = { payload: { wallets: [] } } as unknown as VaultSession;
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function server(
  opts: {
    failWallet?: string;
    submitFails?: boolean;
    registerFails?: boolean;
  } = {},
) {
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
          preparation: {
            wallet: body.wallet,
            transaction: 'tx',
            sha256: retained.preparationSha256,
          },
        },
        history: { id: retained.preparationId },
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
          id: retained.intentId,
          preparationId: retained.preparationId,
          wallet,
          sha256: retained.preparationSha256,
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
    if (body.action === 'register' && opts.registerFails)
      return ok({ error: 'registration unknown' }, 502);
    return ok({
      signature: retained.signature,
      state: body.action === 'register' ? 'signed' : 'submitted',
    });
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

const make = (
  s: ReturnType<typeof server>,
  patch: { maxSlippageBps?: number } = {},
) =>
  createAutoSellExecutor({
    projectId: retained.projectId,
    projectRevision: 3,
    mint: MINT,
    decimals: 6,
    wallets: [
      { address: W1, revision: 1 },
      { address: W2, revision: 1 },
    ],
    session: () => session,
    ...patch,
    fetcher: s.fetcher,
    sleep: async () => {},
    sign: vi.fn(async () => ({
      signature: retained.signature,
      transaction: 'signed',
    })),
  });

describe('auto sell executor', () => {
  it('prepares, reviews, signs, registers and submits a sell', async () => {
    const s = server();
    const result = await make(s)(1_500_000n, new AbortController().signal);
    expect(result).toEqual({
      soldRaw: 1_500_000n,
      signature: retained.signature,
      wallet: W1,
      outcome: {
        ...retained,
        projectRevision: 3,
        walletRevision: 1,
        inputRaw: '1500000',
      },
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

  it('sends a tighter slippage ceiling with the preparation request', async () => {
    const s = server();
    await make(s, { maxSlippageBps: 10 })(
      1_500_000n,
      new AbortController().signal,
    );
    expect(s.calls[0].body.slippageBps).toBe(10);
  });

  it('leaves the request byte-identical when no tighter ceiling is chosen', async () => {
    const s = server();
    await make(s)(1_500_000n, new AbortController().signal);
    expect(s.calls[0].body).not.toHaveProperty('slippageBps');
  });

  it('reports a signed but unconfirmed submission as uncertain', async () => {
    const s = server({ submitFails: true });
    const error = await make(s)(1_500_000n, new AbortController().signal).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(AutoSellUncertainError);
    expect(error.outcome).toEqual({
      ...retained,
      projectRevision: 3,
      walletRevision: 1,
      inputRaw: '1500000',
    });
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
      projectId: retained.projectId,
      projectRevision: 3,
      mint: MINT,
      decimals: 6,
      wallets: [{ address: W1, revision: 1 }],
      session: () => session,
      fetcher: fetcher as unknown as typeof fetch,
      sleep: async () => {},
      sign: vi.fn(async () => ({
        signature: retained.signature,
        transaction: 'signed',
      })),
    });
    const error = await sell(1_500_000n, controller.signal).catch((e) => e);
    expect(error).toBeInstanceOf(AutoSellUncertainError);
    expect(error.outcome?.signature).toBe(retained.signature);
    expect(s.calls.some((c) => c.body.action === 'submit')).toBe(false);
  });
  it('retains the original lookup context after a registration-stage refusal without another wallet or send', async () => {
    const s = server({ registerFails: true });
    const error = await make(s)(1500000n, new AbortController().signal).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(AutoSellUncertainError);
    expect(error.outcome).toEqual({
      ...retained,
      projectRevision: 3,
      walletRevision: 1,
      inputRaw: '1500000',
    });
    expect(s.calls.filter((c) => c.url.endsWith('/prepare'))).toHaveLength(1);
    expect(s.calls.some((c) => c.body.action === 'submit')).toBe(false);
  });
});
