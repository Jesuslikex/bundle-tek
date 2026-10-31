import { describe, expect, it, vi } from 'vitest';
import {
  CleanupUncertainError,
  SOL_MINT,
  createCleanupExecutor,
} from './market-cleanup-execute';
import type { VaultSession } from './browser-wallet-vault';

const mint = 'Mint111111111111111111111111111111111111111';
const wallet = {
  address: 'Wa11et1111111111111111111111111111111111111',
  revision: 3,
};
const session = { payload: { wallets: [] } } as unknown as VaultSession;

function server(options: {
  side: 'Buy' | 'Sell';
  amount: string;
  submit?: number;
  recover?: Record<string, unknown>[];
}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const recoveries = [...(options.recover ?? [])];
  const inputMint = options.side === 'Sell' ? mint : SOL_MINT,
    outputMint = options.side === 'Sell' ? SOL_MINT : mint;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, body });
    if (url === '/api/imported-projects/prepare')
      return Response.json({
        order: {
          side: options.side,
          inAmount: options.amount,
          inputMint,
          outputMint,
          preparation: {
            wallet: wallet.address,
            transaction: 'tx',
            sha256: 'h',
          },
        },
        history: { id: 'prep-1' },
        simulation: { succeeded: true },
      });
    if (body.action === 'review')
      return Response.json({
        review: {
          id: 'intent-1',
          preparationId: 'prep-1',
          wallet: wallet.address,
          sha256: 'h',
          transaction: 'tx',
          inputRaw: options.amount,
          inputMint,
          outputMint,
          network: 'mainnet',
        },
      });
    if (body.action === 'register')
      return Response.json({ signature: 'sig', state: 'signed' });
    if (body.action === 'submit')
      return options.submit
        ? Response.json({ error: 'busy' }, { status: options.submit })
        : Response.json({ signature: 'sig', state: 'submitted' });
    if (body.action === 'recover') {
      const next = recoveries.shift();
      return next
        ? Response.json(next)
        : Response.json({ error: 'not yet' }, { status: 409 });
    }
    if (body.action === 'cancel') return Response.json({ state: 'cancelled' });
    throw new Error('unexpected');
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}
const make = (
  fetcher: typeof fetch,
  sign = vi.fn(async () => ({ signature: 'sig', transaction: 'signed-tx' })),
) =>
  createCleanupExecutor({
    projectId: 'p',
    projectRevision: 2,
    mint,
    decimals: 6,
    session: () => session,
    fetcher,
    sleep: async () => {},
    sign: sign as never,
    pollMs: 0,
    finalTimeoutMs: 50,
  });

describe('cleanup executor', () => {
  it('runs prepare, review, local signature, register and one send for a buy', async () => {
    const s = server({ side: 'Buy', amount: '1500000000' });
    const executor = make(s.fetcher);
    const sent = await executor.trade(
      wallet,
      'Buy',
      1_500_000_000n,
      new AbortController().signal,
    );
    expect(sent).toMatchObject({
      intentId: 'intent-1',
      signature: 'sig',
      side: 'Buy',
    });
    expect(s.calls[0].body).toMatchObject({
      side: 'Buy',
      amount: '1.5',
      walletRevision: 3,
    });
    expect(s.calls.map((c) => c.body.action ?? 'prepare')).toEqual([
      'prepare',
      'review',
      'register',
      'submit',
    ]);
  });
  it('releases the reservation when nothing was signed', async () => {
    const s = server({ side: 'Sell', amount: '5' });
    const executor = make(
      s.fetcher,
      vi.fn(async () => {
        throw new Error('vault closed');
      }),
    );
    await expect(
      executor.trade(wallet, 'Sell', 5n, new AbortController().signal),
    ).rejects.toThrow(/vault closed/);
    expect(s.calls.at(-1)!.body).toEqual({ action: 'cancel', id: 'intent-1' });
  });
  it('treats a failed send after signing as uncertain', async () => {
    const s = server({ side: 'Sell', amount: '5', submit: 502 });
    const executor = make(s.fetcher);
    await expect(
      executor.trade(wallet, 'Sell', 5n, new AbortController().signal),
    ).rejects.toBeInstanceOf(CleanupUncertainError);
    expect(s.calls.filter((c) => c.body.action === 'submit')).toHaveLength(1);
  });
  it('waits for the finalized receipt and reports proceeds', async () => {
    const s = server({
      side: 'Sell',
      amount: '5',
      recover: [
        {
          state: 'finalized',
          signature: 'sig',
          receipt: { document: { nativeChangeRaw: '42', tokenUnitsRaw: '5' } },
        },
      ],
    });
    const executor = make(s.fetcher);
    const sent = {
      intentId: 'intent-1',
      signature: 'sig',
      wallet: wallet.address,
      side: 'Sell' as const,
      inputRaw: '5',
    };
    await expect(
      executor.awaitFinal(sent, new AbortController().signal),
    ).resolves.toEqual({
      state: 'finalized',
      signature: 'sig',
      nativeChangeRaw: 42n,
      tokenUnitsRaw: 5n,
    });
    const slow = make(server({ side: 'Sell', amount: '5' }).fetcher);
    await expect(
      slow.awaitFinal(sent, new AbortController().signal),
    ).rejects.toBeInstanceOf(CleanupUncertainError);
  });
});
