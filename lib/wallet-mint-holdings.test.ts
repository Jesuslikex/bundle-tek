import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
vi.mock('./solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: () => 'https://mainnet.helius-rpc.com/',
}));
import { observeWalletMintHoldings } from './wallet-mint-holdings';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { TOKEN_PROGRAMS } from './wallet-holdings';
const address = bs58.encode(new Uint8Array(32).fill(1)),
  mint = bs58.encode(new Uint8Array(32).fill(2));
function provider(
  patch: (result: Record<string, unknown>, method: string) => unknown = (r) =>
    r,
  program: string = TOKEN_PROGRAMS[0],
) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(init.body as string);
    calls.push(call);
    if (call.method === 'getGenesisHash')
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: SOLANA_MAINNET_GENESIS,
      });
    const account = (n: number, amount: string, state: string) => ({
      pubkey: bs58.encode(new Uint8Array(32).fill(n)),
      account: {
        owner: program,
        executable: false,
        data: {
          space: 165,
          parsed: {
            type: 'account',
            info: {
              owner: address,
              mint,
              state,
              tokenAmount: { amount, decimals: 6 },
            },
          },
        },
      },
    });
    const result =
      call.method === 'getAccountInfo'
        ? {
            context: { slot: 100 },
            value: {
              owner: program,
              executable: false,
              data: {
                parsed: {
                  type: 'mint',
                  info: { decimals: 6, isInitialized: true },
                },
              },
            },
          }
        : {
            context: { slot: 101 },
            value: [
              account(3, '1000', 'frozen'),
              account(4, '3003', 'initialized'),
            ],
          };
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: patch(result, call.method),
    });
  }) as typeof fetch;
  return { calls, fetcher };
}
it.each(TOKEN_PROGRAMS)(
  'reads exact mint coverage for %s without enumerating unrelated tokens',
  async (program) => {
    const { calls, fetcher } = provider(undefined, program),
      s = await observeWalletMintHoldings(
        address,
        mint,
        6,
        AbortSignal.timeout(1000),
        fetcher,
      );
    expect(s).toMatchObject({
      scope: 'mint',
      mint,
      program,
      raw: '4003',
      frozenRaw: '1000',
      unfrozenRaw: '3003',
      amount: '0.004003',
      accountCount: 2,
      mintSlot: 100,
      slot: 101,
    });
    expect(calls).toHaveLength(3);
    expect(calls[2].params).toEqual([
      address,
      { mint },
      { encoding: 'jsonParsed', commitment: 'confirmed', minContextSlot: 100 },
    ]);
    expect(s).not.toHaveProperty('holdings');
  },
);
it('supports zero accounts while retaining mint-bound provenance', async () => {
  const { fetcher } = provider((r, method) =>
    method === 'getTokenAccountsByOwner' ? { ...r, value: [] } : r,
  );
  expect(
    await observeWalletMintHoldings(
      address,
      mint,
      6,
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ).toMatchObject({
    scope: 'mint',
    accountCount: 0,
    raw: '0',
    unfrozenRaw: '0',
  });
});
it('completes a 520-account inventory across eleven bounded pages', async () => {
  let pageNumber = 0;
  const { fetcher } = provider((r, method) => {
    if (method !== 'getTokenAccountsByOwnerV2') return r;
    const index = pageNumber++;
    const template = (r.value as unknown[])[1];
    const accounts = Array.from(
      { length: index === 10 ? 20 : 50 },
      (_, offset) => {
        const row = JSON.parse(JSON.stringify(template));
        const bytes = new Uint8Array(32).fill(8);
        new DataView(bytes.buffer).setUint32(0, index * 50 + offset + 100);
        row.pubkey = bs58.encode(bytes);
        return row;
      },
    );
    return {
      context: { slot: 101 + index },
      value: { accounts, paginationKey: index === 10 ? null : `next-${index}` },
    };
  });
  const snapshot = await observeWalletMintHoldings(
    address,
    mint,
    6,
    AbortSignal.timeout(1000),
    fetcher,
    { pagination: 'helius-v2' },
  );
  expect(snapshot.accountCount).toBe(520);
  expect(snapshot.raw).toBe((520n * 3003n).toString());
  expect(snapshot.slots).toHaveLength(11);
  expect(snapshot.slot).toBe(111);
});

it.each([
  'owner',
  'mint',
  'program',
  'decimals',
  'state',
  'duplicate',
  'slot',
  'mint-metadata',
])('rejects mismatched %s evidence', async (kind) => {
  const { fetcher } = provider((r, method) => {
    if (method === 'getAccountInfo' && kind === 'mint-metadata')
      return { ...r, value: null };
    if (method !== 'getTokenAccountsByOwner') return r;
    const data = r as {
      context: { slot: number };
      value: Array<{
        pubkey: string;
        account: {
          owner: string;
          data: {
            parsed: {
              info: {
                owner: string;
                mint: string;
                state: string;
                tokenAmount: { decimals: number };
              };
            };
          };
        };
      }>;
    };
    const i = data.value[0].account.data.parsed.info;
    if (kind === 'owner') i.owner = mint;
    if (kind === 'mint') i.mint = address;
    if (kind === 'program') data.value[0].account.owner = TOKEN_PROGRAMS[1];
    if (kind === 'decimals') i.tokenAmount.decimals = 9;
    if (kind === 'state') i.state = 'uninitialized';
    if (kind === 'duplicate') data.value.push(data.value[0]);
    if (kind === 'slot') data.context.slot = 99;
    return data;
  });
  await expect(
    observeWalletMintHoldings(
      address,
      mint,
      6,
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ).rejects.toThrow();
});
it('keeps the existing per-response bound and reports a safe oversized-result code', async () => {
  const { fetcher } = provider((r, method) =>
    method === 'getTokenAccountsByOwner'
      ? { ...r, padding: 'x'.repeat(530000) }
      : r,
  );
  await expect(
    observeWalletMintHoldings(
      address,
      mint,
      6,
      AbortSignal.timeout(1000),
      fetcher,
    ),
  ).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' });
});

it('follows mint-only continuation pages and preserves every confirmed slot', async () => {
  let pageNumber = 0;
  const { calls, fetcher } = provider((r, method) => {
    if (method !== 'getTokenAccountsByOwnerV2') return r;
    const values = r.value as unknown[];
    const n = pageNumber++;
    return {
      context: { slot: 101 + n },
      value: {
        accounts: [values[n]],
        paginationKey: n === 0 ? 'next-page' : null,
      },
    };
  });
  const s = await observeWalletMintHoldings(
    address,
    mint,
    6,
    AbortSignal.timeout(1000),
    fetcher,
    { pagination: 'helius-v2' },
  );
  expect(s).toMatchObject({
    raw: '4003',
    frozenRaw: '1000',
    unfrozenRaw: '3003',
    accountCount: 2,
    slots: [101, 102],
    slot: 102,
  });
  expect(calls).toHaveLength(4);
  expect(calls[3].params).toEqual([
    address,
    { mint },
    {
      commitment: 'confirmed',
      encoding: 'jsonParsed',
      minContextSlot: 100,
      limit: 50,
      paginationKey: 'next-page',
    },
  ]);
});

it.each([
  'missing-context',
  'regressing-slot',
  'repeated-cursor',
  'empty-continuation',
  'missing-terminal',
  'duplicate-account',
  'page-bound',
  'page-limit',
])('rejects incomplete or inconsistent pagination: %s', async (kind) => {
  let n = 0;
  const { fetcher } = provider((r, method) => {
    if (method !== 'getTokenAccountsByOwnerV2') return r;
    const values = r.value as unknown[];
    const index = n++;
    const account = JSON.parse(JSON.stringify(values[index % 2]));
    if (kind === 'page-limit')
      account.pubkey = bs58.encode(new Uint8Array(32).fill(index + 10));
    return {
      ...(kind !== 'missing-context'
        ? {
            context: {
              slot: kind === 'regressing-slot' && index > 0 ? 100 : 101 + index,
            },
          }
        : {}),
      value: {
        accounts:
          kind === 'empty-continuation'
            ? []
            : kind === 'page-bound'
              ? Array(51).fill(account)
              : [kind === 'duplicate-account' ? values[0] : account],
        ...(kind !== 'missing-terminal'
          ? {
              paginationKey:
                kind === 'page-limit'
                  ? `page-${index}`
                  : index === 0 || kind === 'repeated-cursor'
                    ? 'next'
                    : null,
            }
          : {}),
      },
    };
  });
  await expect(
    observeWalletMintHoldings(
      address,
      mint,
      6,
      AbortSignal.timeout(1000),
      fetcher,
      { pagination: 'helius-v2' },
    ),
  ).rejects.toThrow();
});
