import { expect, it } from 'vitest';
import {
  assessWarmupSellInventory,
  inspectWarmupSellInventory,
} from './warmup-sell-inventory';
import { TOKEN_PROGRAMS, type HoldingsSnapshot } from './wallet-holdings';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { tokenExtensionNames } from './token-extension-names';
const wallet = 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd',
  mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const snapshot = (): HoldingsSnapshot => ({
  chain: 'Solana',
  address: wallet,
  holdings: [
    {
      mint,
      program: TOKEN_PROGRAMS[0],
      decimals: 6,
      raw: '18446744073709551615',
      amount: '18446744073709.551615',
      accounts: [
        {
          address: wallet,
          raw: '18446744073709551614',
          frozen: false,
          extensions: false,
        },
        { address: mint, raw: '1', frozen: true, extensions: false },
      ],
    },
  ],
  accountCount: 2,
  slots: [{ program: TOKEN_PROGRAMS[0], slot: 100 }],
  minSlot: 100,
  maxSlot: 100,
  observedAt: new Date().toISOString(),
  source: 'example.com',
  commitment: 'confirmed',
});
it('retains exact u64 inventory and excludes frozen units for a sell input', () => {
  const report = assessWarmupSellInventory(
    snapshot(),
    wallet,
    mint,
    '18446744073709.551614',
  );
  expect(report.unfrozenRaw).toBe('18446744073709551614');
  expect(report.unfrozenAmount).toBe('18446744073709.551614');
  expect(report.amountCovered).toBe(true);
  expect(report.preparationSupported).toBe(true);
  expect(report.executionAllowed).toBe(false);
  expect(
    assessWarmupSellInventory(snapshot(), wallet, mint, '18446744073709.551615')
      .amountCovered,
  ).toBe(false);
});
it('holds missing and extension inventory without inventing acquired balances or decimals', () => {
  const empty = { ...snapshot(), holdings: [] };
  expect(assessWarmupSellInventory(empty, wallet, mint, '1')).toMatchObject({
    decimals: null,
    unfrozenRaw: '0',
    requestedRaw: null,
    amountCovered: false,
    preparationSupported: false,
  });
  const extended = snapshot();
  extended.holdings[0].program = TOKEN_PROGRAMS[1];
  expect(
    assessWarmupSellInventory(extended, wallet, mint, '1').preparationSupported,
  ).toBe(false);
});
it('rejects owner/mint ambiguity, malformed totals and overprecision', () => {
  expect(() => assessWarmupSellInventory(snapshot(), mint, mint)).toThrow();
  const duplicate = snapshot();
  duplicate.holdings.push(duplicate.holdings[0]);
  expect(() => assessWarmupSellInventory(duplicate, wallet, mint)).toThrow();
  const invalid = snapshot();
  invalid.holdings[0].raw = '1';
  expect(() => assessWarmupSellInventory(invalid, wallet, mint)).toThrow();
  expect(() =>
    assessWarmupSellInventory(snapshot(), wallet, mint, '1.0000001'),
  ).toThrow();
});

it('admits metadata-only Token-2022 inventory after a matching fresh mint read', () => {
  const s = snapshot();
  s.holdings[0].program = TOKEN_PROGRAMS[1];
  s.holdings[0].accounts.forEach((a) => {
    a.extensions = true;
    a.extensionTypes = ['immutableOwner'];
  });
  const observation = {
    mint,
    program: TOKEN_PROGRAMS[1],
    decimals: 6,
    slot: 101,
    extensions: ['metadataPointer', 'tokenMetadata'],
  };
  const result = assessWarmupSellInventory(s, wallet, mint, '1', observation);
  expect(result).toMatchObject({
    preparationSupported: true,
    amountCovered: true,
    executionAllowed: false,
    mintSlot: 101,
    blockedExtensions: [],
  });
  for (const extension of [
    'transferFeeConfig',
    'transferHook',
    'permanentDelegate',
    'nonTransferable',
    'pausable',
    'unknownExtension',
  ]) {
    const blocked = assessWarmupSellInventory(s, wallet, mint, '1', {
      ...observation,
      extensions: [extension],
    });
    expect(blocked.preparationSupported).toBe(false);
    expect(blocked.blockedExtensions).toContain('mint: ' + extension);
  }
  s.holdings[0].accounts[0].extensionTypes = ['cpiGuard'];
  expect(
    assessWarmupSellInventory(s, wallet, mint, '1', observation)
      .blockedExtensions,
  ).toContain('account: cpiGuard');
  s.holdings[0].accounts[0].extensionTypes = null;
  expect(
    assessWarmupSellInventory(s, wallet, mint, '1', observation)
      .preparationSupported,
  ).toBe(false);
  for (const patch of [
    { mint: wallet },
    { decimals: 9 },
    { slot: 99 },
    { slot: 165 },
    { program: TOKEN_PROGRAMS[0] },
  ])
    expect(() =>
      assessWarmupSellInventory(s, wallet, mint, '1', {
        ...observation,
        ...patch,
      }),
    ).toThrow(/match/);
});

function runtimeProvider(patch: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    const call = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    calls.push(call);
    const account = {
      pubkey: wallet,
      account: {
        owner: TOKEN_PROGRAMS[1],
        executable: false,
        data: {
          space: 170,
          parsed: {
            type: 'account',
            info: {
              owner: wallet,
              mint,
              state: 'initialized',
              tokenAmount: { amount: '2000000', decimals: 6 },
              extensions: [{ extension: 'immutableOwner', state: {} }],
            },
          },
        },
      },
    };
    const result =
      call.method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : call.method === 'getSlot'
          ? 100
          : call.method === 'getTokenAccountsByOwner'
            ? {
                context: { slot: 101 },
                value:
                  call.params[1].programId === TOKEN_PROGRAMS[1]
                    ? [account]
                    : [],
              }
            : {
                context: { slot: patch.slot ?? 102 },
                value: {
                  owner: patch.owner ?? TOKEN_PROGRAMS[1],
                  executable: false,
                  data: {
                    space: patch.space ?? 250,
                    parsed: {
                      type: 'mint',
                      info: {
                        decimals: patch.decimals ?? 6,
                        isInitialized: true,
                        ...(!patch.missingExtensions
                          ? {
                              extensions: patch.extensions ?? [
                                { extension: 'metadataPointer', state: {} },
                              ],
                            }
                          : {}),
                      },
                    },
                  },
                },
              };
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }) as typeof fetch;
  return { fetcher, calls };
}
it('reads mint capabilities at or after both account observations and preserves unsupported details', async () => {
  const provider = runtimeProvider();
  const report = await inspectWarmupSellInventory(
    wallet,
    mint,
    AbortSignal.timeout(25000),
    '1.5',
    provider.fetcher,
  );
  expect(report).toMatchObject({
    preparationSupported: true,
    amountCovered: true,
    requestedRaw: '1500000',
    mintExtensions: ['metadataPointer'],
    mintSlot: 102,
  });
  expect(provider.calls.at(-1)).toEqual({
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [
      mint,
      { encoding: 'jsonParsed', commitment: 'confirmed', minContextSlot: 101 },
    ],
  });
  const blocked = await inspectWarmupSellInventory(
    wallet,
    mint,
    AbortSignal.timeout(25000),
    '1',
    runtimeProvider({
      extensions: [{ extension: 'transferFeeConfig', state: {} }],
    }).fetcher,
  );
  expect(blocked).toMatchObject({
    preparationSupported: false,
    blockedExtensions: ['mint: transferFeeConfig'],
  });
  const missing = await inspectWarmupSellInventory(
    wallet,
    mint,
    AbortSignal.timeout(25000),
    '1',
    runtimeProvider({ missingExtensions: true }).fetcher,
  );
  expect(missing.preparationSupported).toBe(false);
  const bare = await inspectWarmupSellInventory(
    wallet,
    mint,
    AbortSignal.timeout(25000),
    '1',
    runtimeProvider({ missingExtensions: true, space: 82 }).fetcher,
  );
  expect(bare.preparationSupported).toBe(true);
});
it('rejects mismatched mint state and malformed extension enumeration', async () => {
  for (const patch of [
    { owner: TOKEN_PROGRAMS[0] },
    { decimals: 7 },
    { slot: 100 },
    { slot: 166 },
    {
      extensions: [
        { extension: 'metadataPointer' },
        { extension: 'metadataPointer' },
      ],
    },
  ])
    await expect(
      inspectWarmupSellInventory(
        wallet,
        mint,
        AbortSignal.timeout(25000),
        '1',
        runtimeProvider(patch).fetcher,
      ),
    ).rejects.toThrow();
  for (const value of [
    null,
    {},
    [{ extension: 'bad-name' }],
    [null],
    Array.from({ length: 65 }, () => ({ extension: 'a' })),
  ])
    expect(() => tokenExtensionNames(value)).toThrow();
});
