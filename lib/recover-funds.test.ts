import { describe, expect, it, vi } from 'vitest';
vi.mock('./native-withdrawal', () => ({
  validatedNativeWithdrawal: async (v: unknown) => v,
  signNativeWithdrawal: vi.fn(),
}));
import {
  filterRecoverRows,
  readNativeBalances,
  reclaimableLamports,
  summarizeRow,
  withdrawSolToFunder,
  WithdrawUncertainError,
} from './recover-funds';
import { WITHDRAWAL_OWNER_SCOPE_HEADER } from './native-withdrawal-owner-scope';
import type { VaultSession } from './browser-wallet-vault';

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      [WITHDRAWAL_OWNER_SCOPE_HEADER]: 'scope',
    },
  });

describe('recover rows', () => {
  it('keeps the fee and rent reserve behind', () => {
    expect(reclaimableLamports(1_000_000n)).toBe(1_000_000n - 5000n - 890880n);
    expect(reclaimableLamports(800_000n)).toBe(0n);
  });
  it('values tokens, supply share and applies Proxima filters', () => {
    const row = (id: string, tokenRaw: bigint, price: number | null) =>
      summarizeRow(
        {
          projectId: id,
          symbol: id,
          archived: false,
          wallets: [{ address: 'a', revision: 1, nativeRaw: 0n, tokenRaw }],
        },
        6,
        1_000_000_000_000n,
        price,
      );
    const big = row('big', 600_000_000_000n, 0.001); // 60% supply, $600
    const small = row('small', 1_000_000n, 0.001); // $0.001, hidden below $0.50
    const empty = summarizeRow(
      { projectId: 'e', symbol: 'e', archived: false, wallets: [] },
      6,
      1n,
      null,
    );
    expect(big.supplyPercent).toBeCloseTo(60);
    expect(big.tokenUsd).toBeCloseTo(600);
    expect(
      filterRecoverRows([big, small, empty], { includeEmpty: false }, null).map(
        (r) => r.projectId,
      ),
    ).toEqual(['big']);
    expect(
      filterRecoverRows([big, small, empty], { includeEmpty: true }, null).map(
        (r) => r.projectId,
      ),
    ).toEqual(['big', 'e']);
    expect(
      filterRecoverRows(
        [big],
        { includeEmpty: false, maxSupplyPercent: 50 },
        null,
      ),
    ).toHaveLength(0);
    expect(
      filterRecoverRows([big], { includeEmpty: false, minUsd: 1000 }, null),
    ).toHaveLength(0);
  });
});

describe('withdrawSolToFunder', () => {
  const wallet = { address: 'W1', revision: 3 };
  const doc = {
    wallet: 'W1',
    recipient: 'F1',
    amountRaw: '1000000000',
    transaction: 'unsigned',
  };
  function server(opts: { submitFails?: boolean } = {}) {
    const calls: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body);
      if (body.action === 'submit' && opts.submitFails)
        return ok({ error: 'unknown' }, 502);
      const state = {
        prepare: 'awaiting_signature',
        begin_signing: 'signing',
        reject_signing: 'cancelled',
        register: 'signed',
        submit: 'submitted',
      }[body.action as string];
      return ok({
        withdrawal: {
          id: 'w1',
          wallet: 'W1',
          state,
          signature:
            body.action === 'register' || body.action === 'submit'
              ? 'sig'
              : null,
          document: doc,
        },
      });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }
  const session = {} as VaultSession;
  it('prepares, signs locally, registers and submits once', async () => {
    const s = server();
    const sign = vi.fn(async () => ({
      signature: 'sig',
      transaction: 'signed',
    }));
    const r = await withdrawSolToFunder({
      wallet,
      funder: 'F1',
      lamports: 1_000_000_000n,
      ownerScope: 'scope',
      session,
      signal: new AbortController().signal,
      fetcher: s.fetcher,
      sign: sign as never,
    });
    expect(r.signature).toBe('sig');
    expect(s.calls.map((c) => c.action)).toEqual([
      'prepare',
      'begin_signing',
      'register',
      'submit',
    ]);
    expect(s.calls[0]).toMatchObject({
      wallet: 'W1',
      walletRevision: 3,
      recipient: 'F1',
      amount: '1',
    });
  });
  it('releases the reservation when signing fails before a signature', async () => {
    const s = server();
    const sign = vi.fn(async () => {
      throw new Error('locked');
    });
    await expect(
      withdrawSolToFunder({
        wallet,
        funder: 'F1',
        lamports: 1_000_000_000n,
        ownerScope: 'scope',
        session,
        signal: new AbortController().signal,
        fetcher: s.fetcher,
        sign: sign as never,
      }),
    ).rejects.toThrow('locked');
    expect(s.calls.map((c) => c.action)).toEqual([
      'prepare',
      'begin_signing',
      'reject_signing',
    ]);
  });
  it('reports an unknown submission as uncertain and never resends', async () => {
    const s = server({ submitFails: true });
    const sign = vi.fn(async () => ({
      signature: 'sig',
      transaction: 'signed',
    }));
    await expect(
      withdrawSolToFunder({
        wallet,
        funder: 'F1',
        lamports: 1_000_000_000n,
        ownerScope: 'scope',
        session,
        signal: new AbortController().signal,
        fetcher: s.fetcher,
        sign: sign as never,
      }),
    ).rejects.toBeInstanceOf(WithdrawUncertainError);
    expect(s.calls.filter((c) => c.action === 'submit')).toHaveLength(1);
  });
  it('refuses a prepared withdrawal to another recipient', async () => {
    const s = server();
    await expect(
      withdrawSolToFunder({
        wallet,
        funder: 'F2',
        lamports: 1_000_000_000n,
        ownerScope: 'scope',
        session,
        signal: new AbortController().signal,
        fetcher: s.fetcher,
        sign: vi.fn() as never,
      }),
    ).rejects.toThrow(/does not match/);
  });
});

it('readNativeBalances waits out a 429', async () => {
  let n = 0;
  const fetcher = vi.fn(async () => {
    n++;
    if (n === 1) return new Response('{}', { status: 429 });
    return new Response(
      JSON.stringify({ snapshot: { items: [{ address: 'a', raw: '5' }] } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const sleep = vi.fn(async () => {});
  expect(
    await readNativeBalances(
      ['a'],
      new AbortController().signal,
      fetcher,
      sleep,
    ),
  ).toEqual({ a: 5n });
  expect(sleep).toHaveBeenCalledWith(15250, expect.anything());
});
