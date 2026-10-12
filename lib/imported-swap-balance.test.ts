import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { MintHoldingsSnapshot } from './wallet-mint-holdings';
import {
  assessImportedSwapBalance,
  observeImportedSwapBalance,
} from './imported-swap-balance';
const rpcMocks = vi.hoisted(() => ({
  holdings: vi.fn(),
  mintHoldings: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('./wallet-mint-holdings', () => ({
  observeWalletMintHoldings: rpcMocks.mintHoldings,
}));
vi.mock('./wallet-holdings', async (original) => ({
  ...(await original<typeof import('./wallet-holdings')>()),
  observeWalletHoldings: rpcMocks.holdings,
}));
vi.mock('./wallet-balances', async (original) => ({
  ...(await original<typeof import('./wallet-balances')>()),
  balanceRpc: rpcMocks.rpc,
}));
import type { ImportedTokenProject } from './imported-token-project';
import type { HoldingsSnapshot } from './wallet-holdings';
const program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const token: ImportedTokenProject['document']['token'] = {
  chain: 'Solana',
  address: 'mint',
  name: 'Token',
  symbol: 'TOK',
  decimals: 2,
  totalSupplyRaw: '1000',
  tokenProgram: program,
  observedAt: '2026-10-10T08:00:00Z',
  source: 'rpc.test',
};
const snapshot: HoldingsSnapshot = {
  chain: 'Solana',
  address: 'wallet',
  holdings: [
    {
      mint: 'mint',
      program,
      raw: '300',
      amount: '3',
      decimals: 2,
      accounts: [
        { address: 'a', raw: '100', frozen: true, extensions: false },
        { address: 'b', raw: '200', frozen: false, extensions: false },
      ],
    },
  ],
  accountCount: 2,
  slots: [],
  minSlot: 100,
  maxSlot: 101,
  observedAt: token.observedAt,
  source: 'rpc.test',
  commitment: 'confirmed',
};
it('compares sells with exact unfrozen units and retains frozen inventory', () => {
  const report = assessImportedSwapBalance(
    token,
    'wallet',
    'Sell',
    '3',
    snapshot,
    '1',
  );
  expect(report.shortfallRaw).toBe('100');
  expect(report.tokenRaw).toBe('300');
  expect(report.frozenRaw).toBe('100');
  expect(report.amountCovered).toBe(false);
  expect(report.executionAllowed).toBe(false);
  expect(
    assessImportedSwapBalance(token, 'wallet', 'Sell', '2', snapshot, '1')
      .amountCovered,
  ).toBe(true);
});
it('uses native units for buys and admits an observed empty token inventory', () => {
  expect(
    assessImportedSwapBalance(
      token,
      'wallet',
      'Buy',
      '0.000000002',
      snapshot,
      '1',
    ).shortfallRaw,
  ).toBe('1');
  expect(
    assessImportedSwapBalance(
      token,
      'wallet',
      'Sell',
      '0.01',
      { ...snapshot, holdings: [] },
      '0',
    ).shortfallRaw,
  ).toBe('1');
});
it('rejects mismatched wallet, token program or decimals', () => {
  expect(() =>
    assessImportedSwapBalance(token, 'other', 'Sell', '1', snapshot, '0'),
  ).toThrow();
  for (const patch of [{ program: 'other' }, { decimals: 3 }])
    expect(() =>
      assessImportedSwapBalance(
        token,
        'wallet',
        'Sell',
        '1',
        { ...snapshot, holdings: [{ ...snapshot.holdings[0], ...patch }] },
        '0',
      ),
    ).toThrow();
});

it('rejects noncanonical, inconsistent and duplicated account inventory', () => {
  for (const holding of [
    { ...snapshot.holdings[0], raw: '0300' },
    { ...snapshot.holdings[0], raw: '301' },
    {
      ...snapshot.holdings[0],
      accounts: [
        snapshot.holdings[0].accounts[0],
        snapshot.holdings[0].accounts[0],
      ],
    },
    {
      ...snapshot.holdings[0],
      accounts: [{ ...snapshot.holdings[0].accounts[0], raw: '-1' }],
    },
  ])
    expect(() =>
      assessImportedSwapBalance(
        token,
        'wallet',
        'Sell',
        '1',
        { ...snapshot, holdings: [holding] },
        '0',
      ),
    ).toThrow();
});
it('withholds sell preparation for extensions and Token-2022', () => {
  const extended = {
    ...snapshot,
    holdings: [
      {
        ...snapshot.holdings[0],
        accounts: snapshot.holdings[0].accounts.map((a) => ({
          ...a,
          extensions: true,
        })),
      },
    ],
  };
  expect(
    assessImportedSwapBalance(token, 'wallet', 'Sell', '1', extended, '0')
      .preparationSupported,
  ).toBe(false);
  const program2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  expect(
    assessImportedSwapBalance(
      { ...token, tokenProgram: program2022 },
      'wallet',
      'Sell',
      '1',
      {
        ...snapshot,
        holdings: [{ ...snapshot.holdings[0], program: program2022 }],
      },
      '0',
    ).preparationSupported,
  ).toBe(false);
});

it('admits only freshly observed metadata-only Token-2022 sells and preserves precise blocked reasons', () => {
  const program2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const holding = {
    ...snapshot.holdings[0],
    program: program2022,
    accounts: snapshot.holdings[0].accounts.map((a) => ({
      ...a,
      extensions: true,
      extensionTypes: ['immutableOwner'],
    })),
  };
  const current = { ...snapshot, holdings: [holding] };
  const metadata = {
    mint: token.address,
    program: program2022,
    decimals: 2,
    slot: 102,
    extensions: ['metadataPointer', 'tokenMetadata'],
  };
  const assess = (extensions: string[]) =>
    assessImportedSwapBalance(
      { ...token, tokenProgram: program2022 },
      'wallet',
      'Sell',
      '2',
      current,
      '0',
      { ...metadata, extensions },
    );
  expect(assess(metadata.extensions)).toMatchObject({
    preparationSupported: true,
    amountCovered: true,
    requestedRaw: '200',
    mintSlot: 102,
    blockedExtensions: [],
    executionAllowed: false,
  });
  for (const extension of [
    'transferFeeConfig',
    'transferHook',
    'confidentialTransferMint',
    'unknownExtension',
  ])
    expect(assess([extension])).toMatchObject({
      preparationSupported: false,
      blockedExtensions: [`mint: ${extension}`],
    });
  expect(
    assessImportedSwapBalance(
      { ...token, tokenProgram: program2022 },
      'wallet',
      'Sell',
      '2',
      current,
      '0',
    ),
  ).toMatchObject({
    preparationSupported: false,
    blockedExtensions: ['mint details unavailable'],
  });
  expect(
    assessImportedSwapBalance(
      { ...token, tokenProgram: program2022 },
      'wallet',
      'Sell',
      '2',
      {
        ...current,
        holdings: [
          {
            ...holding,
            accounts: holding.accounts.map((a) => ({
              ...a,
              extensionTypes: undefined,
            })),
          },
        ],
      },
      '0',
      metadata,
    ).preparationSupported,
  ).toBe(false);
});

it('pins imported native reads after a fresh Token-2022 mint read and rejects slot or identity drift', async () => {
  const program2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const tradeWallet = bs58.encode(new Uint8Array(32).fill(1)),
    tradeMint = bs58.encode(new Uint8Array(32).fill(2));
  const tradeToken = {
    ...token,
    address: tradeMint,
    tokenProgram: program2022,
  };
  const current = {
    ...snapshot,
    observedAt: new Date().toISOString(),
    holdings: [
      {
        ...snapshot.holdings[0],
        program: program2022,
        accounts: snapshot.holdings[0].accounts.map((a) => ({
          ...a,
          extensions: true,
          extensionTypes: ['immutableOwner'],
        })),
      },
    ],
  };
  const mint = {
    context: { slot: '102' },
    value: {
      owner: program2022,
      executable: false,
      data: {
        space: '250',
        parsed: {
          type: 'mint',
          info: {
            decimals: 2,
            isInitialized: true,
            extensions: [{ extension: 'metadataPointer' }],
          },
        },
      },
    },
  };
  const scoped: MintHoldingsSnapshot = {
    format: 'solana-mint-holdings-v1',
    scope: 'mint',
    chain: 'Solana',
    address: tradeWallet,
    mint: tradeMint,
    program: program2022,
    decimals: 2,
    raw: '300',
    frozenRaw: '100',
    unfrozenRaw: '200',
    amount: '3',
    accounts: current.holdings[0].accounts.map((a, i) => ({
      ...a,
      address: bs58.encode(new Uint8Array(32).fill(i + 10)),
    })),
    accountCount: 2,
    mintSlot: 100,
    slots: [100, 101],
    slot: 101,
    observedAt: current.observedAt,
    source: current.source,
    commitment: 'confirmed',
    mintExtensions: ['metadataPointer'],
  };
  rpcMocks.mintHoldings.mockResolvedValue(scoped);
  rpcMocks.holdings.mockClear();
  rpcMocks.rpc
    .mockReset()
    .mockResolvedValueOnce(mint)
    .mockResolvedValueOnce({ context: { slot: '103' }, value: '10000000' });
  const result = await observeImportedSwapBalance(
    tradeToken,
    tradeWallet,
    'Sell',
    '2',
    AbortSignal.timeout(5000),
  );
  expect(result).toMatchObject({
    preparationSupported: true,
    mintSlot: 102,
    nativeSlot: 103,
    unfrozenRaw: '200',
    inventoryScope: 'mint',
  });
  expect(rpcMocks.rpc.mock.calls[1][2]).toEqual([
    tradeWallet,
    { commitment: 'confirmed', minContextSlot: 102 },
  ]);
  for (const badMint of [
    { ...mint, context: { slot: '100' } },
    { ...mint, value: { ...mint.value, owner: program } },
    {
      ...mint,
      value: {
        ...mint.value,
        data: {
          ...mint.value.data,
          parsed: {
            ...mint.value.data.parsed,
            info: { ...mint.value.data.parsed.info, decimals: 3 },
          },
        },
      },
    },
  ]) {
    rpcMocks.rpc.mockReset().mockResolvedValueOnce(badMint);
    await expect(
      observeImportedSwapBalance(
        tradeToken,
        tradeWallet,
        'Sell',
        '2',
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
    expect(rpcMocks.rpc).toHaveBeenCalledTimes(1);
  }
  rpcMocks.rpc
    .mockReset()
    .mockResolvedValueOnce(mint)
    .mockResolvedValueOnce({ context: { slot: '101' }, value: '10000000' });
  await expect(
    observeImportedSwapBalance(
      tradeToken,
      tradeWallet,
      'Sell',
      '2',
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow('changed or expired');
  expect(rpcMocks.holdings).not.toHaveBeenCalled();
});
