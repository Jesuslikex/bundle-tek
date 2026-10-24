import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import type { JitoSimulationAccount } from './jito-bundle-simulation-frames';
import { decodeJitoWalletTokenBalances } from './jito-bundle-token-state';
import { readSwapTokenAccountBindings } from './swap-token-account-bindings';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
const other = bs58.encode(new Uint8Array(32).fill(7));
const raw = (
  account: {
    owner: string;
    executable: boolean;
    lamports: string;
    data: string[];
  } | null,
): JitoSimulationAccount | null =>
  account && {
    ...account,
    data: Uint8Array.from(Buffer.from(account.data[0], 'base64')),
  };
async function fixture(
  side: 'Buy' | 'Sell' = 'Buy',
  token2022 = false,
  keepWrapped = false,
  existing = false,
) {
  const f = await nativeWarmupFixture({
    side,
    v2: token2022,
    token2022,
    keepWrapped,
    existing,
  });
  const keys = f.simulation.settlementEvidence!.keys;
  const route = f.simulation.routeAssessment.decoded!;
  const post = keys.map(() => null) as (JitoSimulationAccount | null)[];
  const pre = keys.map(() => null) as (JitoSimulationAccount | null)[];
  for (const [i, address] of [
    route.sourceAccount,
    route.destinationAccount,
  ].entries()) {
    pre[keys.indexOf(address)] = raw(f.first[i]);
    post[keys.indexOf(address)] = raw(f.last[i]);
  }
  const mints = [
    { address: SWAP_WRAPPED_SOL, program: SWAP_TOKEN, decimals: 9 },
    {
      address: f.mint,
      program: token2022 ? SWAP_TOKEN_2022 : SWAP_TOKEN,
      decimals: 6,
    },
  ];
  return { ...f, keys, pre, post, mints };
}
describe.each(['Buy', 'Sell'] as const)('%s raw wallet balances', (side) => {
  it.each([false, true])(
    'decodes real fixture raw SPL/2022=%s independently of reported token amounts',
    async (modern) => {
      const f = await fixture(side, modern, true, true);
      for (const [accounts, reported] of [
        [f.pre, f.simulation.settlementEvidence!.preTokens],
        [f.post, f.simulation.settlementEvidence!.postTokens],
      ] as const) {
        const rows = decodeJitoWalletTokenBalances(
          f.keys,
          accounts,
          f.wallet,
          f.mints,
        );
        expect(rows).toEqual(reported);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => !('signingAllowed' in row))).toBe(true);
      }
      const target = f.post.find(
        (a) =>
          a?.owner === (modern ? SWAP_TOKEN_2022 : SWAP_TOKEN) &&
          bs58.encode(a.data.slice(0, 32)) === f.mint,
      )!;
      new DataView(target.data.buffer).setBigUint64(64, 19n, true);
      expect(
        decodeJitoWalletTokenBalances(f.keys, f.post, f.wallet, f.mints).find(
          (row) => row.mint === f.mint,
        )?.uiTokenAmount.amount,
      ).toBe('19');
    },
  );
  it('does not fabricate a closed WSOL account or refund token amount', async () => {
    const f = await fixture(side, false, false, true);
    const rows = decodeJitoWalletTokenBalances(
      f.keys,
      f.post,
      f.wallet,
      f.mints,
    );
    expect(rows.some((row) => row.mint === SWAP_WRAPPED_SOL)).toBe(false);
  });
});
it('preserves separate wallet account indices with the same mint', async () => {
  const f = await fixture();
  const selected = f.post.findIndex((a) => a !== null);
  const rows = decodeJitoWalletTokenBalances(
    [...f.keys, other],
    [...f.post, structuredClone(f.post[selected])],
    f.wallet,
    f.mints,
  );
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.accountIndex)).toEqual([
    String(selected),
    String(f.keys.length),
  ]);
});
it('omits foreign pool token accounts only after checking a valid raw header', async () => {
  const f = await fixture();
  const account = structuredClone(f.post.find((a) => a !== null)!);
  account.data.set(bs58.decode(other), 32);
  expect(
    decodeJitoWalletTokenBalances([other], [account], f.wallet, f.mints),
  ).toEqual([]);
  account.data[108] = 9;
  expect(() =>
    decodeJitoWalletTokenBalances([other], [account], f.wallet, f.mints),
  ).toThrow();
});
it('ignores ordinary foreign non-token state and validates declared mint bytes', async () => {
  const f = await fixture();
  expect(
    decodeJitoWalletTokenBalances(
      [other],
      [
        {
          owner: other,
          data: new Uint8Array(6),
          executable: false,
          lamports: '1',
        },
      ],
      f.wallet,
      f.mints,
    ),
  ).toEqual([]);
  const mint = {
    ...f.mints[0],
    data: new Uint8Array(82),
    executable: false,
    lamports: '1000',
    owner: SWAP_TOKEN,
  };
  mint.data[44] = 9;
  mint.data[45] = 1;
  expect(
    decodeJitoWalletTokenBalances(
      [SWAP_WRAPPED_SOL],
      [mint],
      f.wallet,
      f.mints,
    ),
  ).toEqual([]);
  mint.data[44] = 6;
  expect(() =>
    decodeJitoWalletTokenBalances(
      [SWAP_WRAPPED_SOL],
      [mint],
      f.wallet,
      f.mints,
    ),
  ).toThrow();
});
it.each([
  [SWAP_TOKEN, 82],
  [SWAP_TOKEN_2022, 82],
  [SWAP_TOKEN_2022, 166],
] as const)(
  'omits structurally valid foreign mint %s/%i while retaining declared identity checks',
  async (program, size) => {
    const f = await fixture();
    const mint: JitoSimulationAccount = {
      owner: program,
      executable: false,
      lamports: '1000',
      data: new Uint8Array(size),
    };
    mint.data[44] = 6;
    mint.data[45] = 1;
    if (size === 166) mint.data[165] = 1;
    expect(
      decodeJitoWalletTokenBalances([other], [mint], f.wallet, f.mints),
    ).toEqual([]);
    expect(() =>
      decodeJitoWalletTokenBalances(
        [SWAP_WRAPPED_SOL],
        [mint],
        f.wallet,
        f.mints,
      ),
    ).toThrow();
    const wrongProgram = {
      ...f.mints[1],
      program: program === SWAP_TOKEN ? SWAP_TOKEN_2022 : SWAP_TOKEN,
    };
    expect(() =>
      decodeJitoWalletTokenBalances([f.mint], [mint], f.wallet, [
        f.mints[0],
        wrongProgram,
      ]),
    ).toThrow();
    const wrongPrecision = { ...f.mints[1], program, decimals: 7 };
    expect(() =>
      decodeJitoWalletTokenBalances([f.mint], [mint], f.wallet, [
        f.mints[0],
        wrongPrecision,
      ]),
    ).toThrow();
    for (const [offset, value] of [
      [45, 0],
      [0, 2],
      [46, 2],
    ] as const) {
      const copy = structuredClone(mint);
      copy.data[offset] = value;
      expect(() =>
        decodeJitoWalletTokenBalances([other], [copy], f.wallet, f.mints),
      ).toThrow();
    }
  },
);
it.each([
  ['delegate', 72, 1],
  ['invalid delegate option', 72, 2],
  ['native option', 109, 2],
  ['close authority', 129, 1],
  ['invalid close option', 129, 2],
  ['delegated allowance', 121, 1],
  ['frozen', 108, 2],
  ['uninitialized', 108, 0],
] as const)('refuses wallet %s', async (_name, offset, byte) => {
  const f = await fixture();
  const account = structuredClone(f.post.find((a) => a !== null)!);
  account.data[offset] = byte;
  expect(() =>
    decodeJitoWalletTokenBalances([other], [account], f.wallet, f.mints),
  ).toThrow();
});
it.each([false, true])(
  'admits inactive revoked COption bodies for SPL/2022=%s consistently with existing bindings',
  async (modern) => {
    const f = await fixture('Buy', modern);
    const index = f.post.findIndex((a) => a !== null);
    const account = structuredClone(f.post[index]!);
    account.data.fill(9, 76, 108);
    account.data.fill(8, 133, 165);
    account.data.fill(7, 113, 121);
    const expected = decodeJitoWalletTokenBalances(
      [f.keys[index]],
      [f.post[index]],
      f.wallet,
      f.mints,
    );
    expect(
      decodeJitoWalletTokenBalances(
        [f.keys[index]],
        [account],
        f.wallet,
        f.mints,
      ),
    ).toEqual(expected);
    const value = f.last.map(
      (rawAccount) =>
        rawAccount && {
          ...rawAccount,
          data: [Buffer.from(account.data).toString('base64'), 'base64'],
        },
    );
    const bindings = await readSwapTokenAccountBindings(
      f.simulation.routeAssessment,
      f.order,
      100,
      async () => ({ context: { slot: '101' }, value }),
    );
    expect(bindings.accounts[1]).toMatchObject({
      status: 'Matched bindings',
      delegate: null,
      closeAuthority: null,
      delegatedAmountRaw: '0',
      nativeReserveRaw: null,
    });
    for (const [offset, tag] of [
      [72, 1],
      [72, 2],
      [129, 1],
      [129, 2],
      [109, 1],
      [109, 2],
      [121, 1],
    ] as const) {
      const copy = structuredClone(account);
      copy.data[offset] = tag;
      expect(() =>
        decodeJitoWalletTokenBalances(
          [f.keys[index]],
          [copy],
          f.wallet,
          f.mints,
        ),
      ).toThrow();
    }
  },
);
it('refuses unrelated wallet mints and wrong supported token program evidence', async () => {
  const f = await fixture();
  const account = structuredClone(f.post.find((a) => a !== null)!);
  for (const variant of [
    {
      ...account,
      data: Uint8Array.from([...bs58.decode(other), ...account.data.slice(32)]),
    },
    { ...account, owner: SWAP_TOKEN_2022 },
  ])
    expect(() =>
      decodeJitoWalletTokenBalances([other], [variant], f.wallet, f.mints),
    ).toThrow();
});
it('ignores opaque program state containing the wallet pubkey but refuses a declared mint with that owner', async () => {
  const f = await fixture();
  const account = structuredClone(f.post.find((a) => a !== null)!);
  account.owner = other;
  expect(bs58.encode(account.data.slice(32, 64))).toBe(f.wallet);
  expect(
    decodeJitoWalletTokenBalances([other], [account], f.wallet, f.mints),
  ).toEqual([]);
  expect(() =>
    decodeJitoWalletTokenBalances([f.mint], [account], f.wallet, f.mints),
  ).toThrow();
});
it('omits opaque foreign mint extensions without admitting them for a declared mint', async () => {
  const f = await fixture('Buy', true);
  const data = new Uint8Array(170);
  data[44] = 6;
  data[45] = 1;
  data[165] = 1;
  data[166] = 255;
  data[167] = 255; // Unknown extension bytes are not transfer-policy evidence.
  const mint: JitoSimulationAccount = {
    owner: SWAP_TOKEN_2022,
    executable: false,
    lamports: '1000',
    data,
  };
  expect(
    decodeJitoWalletTokenBalances([other], [mint], f.wallet, f.mints),
  ).toEqual([]);
  expect(() =>
    decodeJitoWalletTokenBalances([f.mint], [mint], f.wallet, f.mints),
  ).toThrow();
  const copy = structuredClone(mint);
  copy.data[44] = 255;
  expect(
    decodeJitoWalletTokenBalances([other], [copy], f.wallet, f.mints),
  ).toEqual([]);
});
it('refuses malformed and unsupported wallet extensions', async () => {
  const f = await fixture('Buy', true);
  const account = structuredClone(f.post.find((a) => a !== null)!);
  for (const data of [
    account.data.slice(0, 164),
    account.data.slice(0, 169),
    Uint8Array.from([...account.data, 1]),
  ])
    expect(() =>
      decodeJitoWalletTokenBalances(
        [other],
        [{ ...account, data }],
        f.wallet,
        f.mints,
      ),
    ).toThrow();
  account.data[166] = 2; // TransferFeeAmount is unsupported by this wallet settlement profile.
  expect(() =>
    decodeJitoWalletTokenBalances([other], [account], f.wallet, f.mints),
  ).toThrow();
});
it('refuses inconsistent WSOL native flag, reserve and lamports', async () => {
  const f = await fixture('Sell', false, true, true);
  const account = structuredClone(
    f.post.find(
      (a) => a && bs58.encode(a.data.slice(0, 32)) === SWAP_WRAPPED_SOL,
    )!,
  );
  for (const mutate of [
    (a: JitoSimulationAccount) => {
      a.data[109] = 0;
    },
    (a: JitoSimulationAccount) => {
      a.data[113] ^= 1;
    },
    (a: JitoSimulationAccount) => {
      a.lamports = '0';
    },
  ]) {
    const copy = structuredClone(account);
    mutate(copy);
    expect(() =>
      decodeJitoWalletTokenBalances([other], [copy], f.wallet, f.mints),
    ).toThrow();
  }
});
it('independently refuses mapping, key, mint evidence, integer and byte bounds', async () => {
  const f = await fixture();
  const account = f.post.find((a) => a !== null)!;
  for (const keys of [[], [other, other], ['invalid'], Array(257).fill(other)])
    expect(() =>
      decodeJitoWalletTokenBalances(keys, [account], f.wallet, f.mints),
    ).toThrow();
  for (const change of [
    { decimals: 19 },
    { decimals: 1.5 },
    { program: other },
    { address: 'invalid' },
  ])
    expect(() =>
      decodeJitoWalletTokenBalances([other], [account], f.wallet, [
        { ...f.mints[0], ...change },
        f.mints[1],
      ]),
    ).toThrow();
  for (const mints of [
    [],
    [f.mints[1]],
    [f.mints[0], f.mints[0]],
    [...f.mints, f.mints[0]],
  ])
    expect(() =>
      decodeJitoWalletTokenBalances([other], [account], f.wallet, mints),
    ).toThrow();
  for (const lamports of ['-1', '01', '18446744073709551616', '1.5'])
    expect(() =>
      decodeJitoWalletTokenBalances(
        [other],
        [{ ...account, lamports }],
        f.wallet,
        f.mints,
      ),
    ).toThrow();
  expect(() =>
    decodeJitoWalletTokenBalances(
      [other],
      [{ ...account, data: new Uint8Array(524289) }],
      f.wallet,
      f.mints,
    ),
  ).toThrow();
  const sparse = [account];
  Reflect.deleteProperty(sparse, '0');
  expect(() =>
    decodeJitoWalletTokenBalances([other], sparse, f.wallet, f.mints),
  ).toThrow();
});
it('preserves full u64 amounts and refuses token state at a declared mint address', async () => {
  const f = await fixture();
  const account = structuredClone(f.post.find((a) => a !== null)!);
  new DataView(account.data.buffer).setBigUint64(64, (1n << 64n) - 1n, true);
  expect(
    decodeJitoWalletTokenBalances([other], [account], f.wallet, f.mints)[0]
      .uiTokenAmount.amount,
  ).toBe('18446744073709551615');
  expect(() =>
    decodeJitoWalletTokenBalances([f.mint], [account], f.wallet, f.mints),
  ).toThrow();
});
it('enforces aggregate raw-data bounds on foreign non-token accounts', async () => {
  const f = await fixture();
  const keys = Array.from({ length: 5 }, (_, i) =>
    bs58.encode(new Uint8Array(32).fill(i + 10)),
  );
  const accounts = keys.map(() => ({
    owner: other,
    executable: false,
    lamports: '1',
    data: new Uint8Array(524288),
  }));
  expect(() =>
    decodeJitoWalletTokenBalances(keys, accounts, f.wallet, f.mints),
  ).toThrow();
});
