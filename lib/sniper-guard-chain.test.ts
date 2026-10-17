import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  decodeCurveBuy,
  readCurveBuys,
  readLaunchTokenBalances,
  type SniperGuardRpc,
} from './sniper-guard-chain';
import { PUMP_NATIVE_QUOTE, PUMP_TOKEN_2022 } from './pump-launch-config';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const curve = key(40),
  buyer = key(9),
  usdc = key(41);
const native = { bondingCurve: curve, quoteMint: PUMP_NATIVE_QUOTE };
const spl = { bondingCurve: curve, quoteMint: usdc };

function nativeTx(
  n: number,
  before: number,
  after: number,
  err: unknown = null,
) {
  return {
    slot: 500 + n,
    blockTime: 1_800_000_000,
    meta: {
      err,
      preBalances: [10_000_000_000, before],
      postBalances: [9_000_000_000, after],
    },
    transaction: {
      signatures: [sig(n)],
      message: {
        accountKeys: [
          { pubkey: buyer, signer: true },
          { pubkey: curve, signer: false },
        ],
      },
    },
  };
}
function splTx(n: number, before: string | null, after: string) {
  const row = (amount: string) => ({
    accountIndex: 1,
    mint: usdc,
    owner: curve,
    uiTokenAmount: { amount },
  });
  return {
    slot: 600 + n,
    blockTime: null,
    meta: {
      err: null,
      preBalances: [1, 1],
      postBalances: [1, 1],
      preTokenBalances: before === null ? [] : [row(before)],
      postTokenBalances: [row(after)],
    },
    transaction: {
      signatures: [sig(n)],
      message: {
        accountKeys: [
          { pubkey: buyer, signer: true },
          { pubkey: key(42), signer: false },
        ],
      },
    },
  };
}

describe('decodeCurveBuy', () => {
  it('measures SOL paid into the curve', () => {
    expect(decodeCurveBuy(nativeTx(1, 100, 600), native)).toEqual({
      signature: sig(1),
      slot: 501,
      blockTime: 1_800_000_000,
      signers: [buyer],
      quoteInRaw: '500',
    });
  });
  it('ignores sells, failed transactions and unrelated transactions', () => {
    expect(decodeCurveBuy(nativeTx(1, 600, 100), native)).toBeNull();
    expect(
      decodeCurveBuy(
        nativeTx(1, 100, 600, { InstructionError: [0, 'x'] }),
        native,
      ),
    ).toBeNull();
    const unrelated = nativeTx(1, 100, 600);
    unrelated.transaction.message.accountKeys[1].pubkey = key(77);
    expect(decodeCurveBuy(unrelated, native)).toBeNull();
  });
  it('measures USDC or stock paid into the curve quote account', () => {
    expect(decodeCurveBuy(splTx(1, '1000', '4000'), spl)?.quoteInRaw).toBe(
      '3000',
    );
    expect(decodeCurveBuy(splTx(2, null, '250'), spl)?.quoteInRaw).toBe('250');
    expect(decodeCurveBuy(splTx(3, '4000', '1000'), spl)).toBeNull();
  });
  it('rejects malformed transactions instead of guessing', () => {
    expect(() => decodeCurveBuy({ slot: 1 }, native)).toThrow();
    const short = nativeTx(1, 100, 600);
    short.meta.postBalances = [1];
    expect(() => decodeCurveBuy(short, native)).toThrow('accounts');
  });
});

function fakeRpc(
  signatures: { signature: string; slot: number; err: unknown }[],
  transactions: Record<string, unknown>,
) {
  return vi.fn<SniperGuardRpc>(async (method, params) => {
    if (method === 'getSignaturesForAddress') {
      const options = params[1] as {
        before?: string;
        until?: string;
        limit: number;
      };
      const newestFirst = [...signatures].reverse();
      let start = 0;
      if (options.before)
        start =
          newestFirst.findIndex((r) => r.signature === options.before) + 1;
      let end = newestFirst.length;
      if (options.until) {
        const stop = newestFirst.findIndex(
          (r) => r.signature === options.until,
        );
        if (stop >= 0) end = stop;
      }
      return newestFirst.slice(start, end).slice(0, options.limit);
    }
    if (method === 'getTransaction')
      return transactions[params[0] as string] ?? null;
    throw new Error('unexpected ' + method);
  });
}

describe('readCurveBuys', () => {
  it('returns buys oldest first and advances the cursor', async () => {
    const rows = [1, 2, 3].map((n) => ({
      signature: sig(n),
      slot: n,
      err: null,
    }));
    const rpc = fakeRpc(rows, {
      [sig(1)]: nativeTx(1, 0, 10),
      [sig(2)]: nativeTx(2, 10, 5),
      [sig(3)]: nativeTx(3, 5, 25),
    });
    const result = await readCurveBuys(
      rpc,
      native,
      null,
      new AbortController().signal,
    );
    expect(result.buys.map((b) => [b.signature, b.quoteInRaw])).toEqual([
      [sig(1), '10'],
      [sig(3), '20'],
    ]);
    expect(result.cursor).toBe(sig(3));
    expect(result.complete).toBe(true);
    const next = await readCurveBuys(
      rpc,
      native,
      sig(3),
      new AbortController().signal,
    );
    expect(next.buys).toEqual([]);
    expect(next.cursor).toBe(sig(3));
  });
  it('skips failed signatures without fetching them', async () => {
    const rpc = fakeRpc(
      [
        { signature: sig(1), slot: 1, err: { InstructionError: [0, 'x'] } },
        { signature: sig(2), slot: 2, err: null },
      ],
      { [sig(2)]: nativeTx(2, 0, 7) },
    );
    const result = await readCurveBuys(
      rpc,
      native,
      null,
      new AbortController().signal,
    );
    expect(result.buys).toHaveLength(1);
    expect(rpc.mock.calls.filter(([m]) => m === 'getTransaction')).toHaveLength(
      1,
    );
  });
  it('stops at a transaction the RPC cannot return yet so the next poll resumes there', async () => {
    const rows = [1, 2, 3].map((n) => ({
      signature: sig(n),
      slot: n,
      err: null,
    }));
    const rpc = fakeRpc(rows, {
      [sig(1)]: nativeTx(1, 0, 10),
      [sig(3)]: nativeTx(3, 10, 30),
    });
    const result = await readCurveBuys(
      rpc,
      native,
      null,
      new AbortController().signal,
    );
    expect(result.buys.map((b) => b.signature)).toEqual([sig(1)]);
    expect(result.cursor).toBe(sig(1));
    expect(result.pending).toBe(true);
    expect(result.complete).toBe(false);
  });
  it('reports partial coverage when more signatures arrive than the page budget', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      signature: bs58.encode(
        new Uint8Array(64).fill(1).map((v, j) => (j === 0 ? i + 1 : v)),
      ),
      slot: i,
      err: { failed: true },
    }));
    const rpc = fakeRpc(rows, {});
    const result = await readCurveBuys(
      rpc,
      native,
      null,
      new AbortController().signal,
      1,
    );
    expect(result.complete).toBe(false);
    expect(result.pending).toBe(false);
    expect(result.cursor).toBe(rows[149].signature);
  });
});

describe('readLaunchTokenBalances', () => {
  it('reads each wallet token account for the Nuke list', async () => {
    const mint = key(50),
      wallets = [key(1), key(2)];
    const [ata] = await findAssociatedTokenPda({
      owner: address(wallets[0]),
      mint: address(mint),
      tokenProgram: address(PUMP_TOKEN_2022),
    });
    const rpc = vi.fn<SniperGuardRpc>(async () => ({
      value: [
        {
          data: {
            parsed: {
              info: { mint, owner: wallets[0], tokenAmount: { amount: '123' } },
            },
          },
        },
        null,
      ],
    }));
    const balances = await readLaunchTokenBalances(
      rpc,
      mint,
      wallets,
      new AbortController().signal,
    );
    expect(balances[0]).toEqual({
      wallet: wallets[0],
      tokenAccount: String(ata),
      amountRaw: '123',
    });
    expect(balances[1].amountRaw).toBe('0');
  });
});
