import { afterEach, expect, it } from 'vitest';
import bs58 from 'bs58';
import { address } from '@solana/kit';
import { pairOrderFixture } from '../test/pair-order-fixture';
import { pairQuoteMint } from '../test/imported-pair-quote-fixture';
import { pairWalletTokenAccount } from '../test/pair-wallet-fixture';
import { inspectPairMintAccount } from './pair-mint-evidence';
import {
  pairAssociatedAddress,
  requiredPairAccountExtensions,
} from './pair-wallet-evidence';
import { prepareOwnedImportedPairOrder } from './imported-pair-order-candidate';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
type Fixture = Awaited<ReturnType<typeof pairOrderFixture>>;
type Message = Awaited<ReturnType<Fixture['makeMessage']>>;
type Raw = ReturnType<typeof pairWalletTokenAccount>;
const SYSTEM = '11111111111111111111111111111111',
  ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let f: Fixture | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
const run = (v: Fixture) =>
  prepareOwnedImportedPairOrder(
    v.db,
    'alice',
    v.orderRequest,
    new AbortController().signal,
    v.orderDependencies,
  );
function readonly(m: Message, key: string) {
  let i = m.staticAccounts.findIndex((a) => a === key);
  if (i < 0) {
    i = m.staticAccounts.length;
    m.staticAccounts.push(address(key));
    m.header.numReadonlyNonSignerAccounts++;
  }
  return i;
}
function writable(m: Message, key: string) {
  m.staticAccounts.splice(3, 0, address(key));
  m.instructions = m.instructions.map((ix) => ({
    ...ix,
    programAddressIndex:
      ix.programAddressIndex >= 3
        ? ix.programAddressIndex + 1
        : ix.programAddressIndex,
    accountIndices: ix.accountIndices?.map((i) => (i >= 3 ? i + 1 : i)),
  }));
  return 3;
}
function mutate(raw: Raw, fn: (b: Uint8Array, v: DataView) => void) {
  const b = Uint8Array.from(atob(raw.data[0]), (c) => c.charCodeAt(0));
  fn(b, new DataView(b.buffer));
  raw.data[0] = btoa(String.fromCharCode(...b));
}
async function fixture(
  options: {
    missing?: boolean;
    close?: boolean;
    amount?: string;
    native?: boolean;
    extended?: boolean;
  } = {},
) {
  const v = (f = await pairOrderFixture());
  const mint = options.native ? SWAP_WRAPPED_SOL : USDC,
    program = options.extended ? SWAP_TOKEN_2022 : SWAP_TOKEN;
  const rawMint = pairQuoteMint(
    options.native ? 9 : 6,
    program,
    options.extended
      ? [{ __kind: 'PausableConfig', authority: null, paused: false }]
      : [],
  );
  const metadata = await inspectPairMintAccount(rawMint, mint),
    key = await pairAssociatedAddress(metadata, v.wallet);
  v.orderState.auxiliaryMints.set(mint, rawMint);
  const prior = pairWalletTokenAccount(
    mint,
    v.wallet,
    program,
    options.amount ?? '50000000',
    requiredPairAccountExtensions(metadata),
  );
  if (options.native) {
    const reserve = 2930n;
    prior.lamports = (
      reserve + BigInt(options.amount ?? '50000000')
    ).toString();
    mutate(prior, (_b, d) => {
      d.setUint32(109, 1, true);
      d.setBigUint64(113, reserve, true);
    });
  }
  v.orderState.otherAccounts.set(key, options.missing ? null : prior);
  v.orderState.transform = (m) => {
    const index = writable(m, key),
      token = readonly(m, program),
      mintIndex = readonly(m, mint);
    m.instructions[0].accountIndices!.push(index, mintIndex, token);
    if (options.missing)
      m.instructions.unshift({
        programAddressIndex: readonly(m, ATA),
        accountIndices: [0, index, 0, mintIndex, readonly(m, SYSTEM), token],
        data: Uint8Array.of(1),
      });
    if (options.close)
      m.instructions.push({
        programAddressIndex: token,
        accountIndices: [index, 0, 0],
        data: Uint8Array.of(9),
      });
    return m;
  };
  const size = atob(prior.data[0]).length,
    rent = String((128 + size) * 10);
  v.orderState.onSimulation = (response, keys) => {
    if (!options.missing && !options.close) return;
    const wallet = response.value.accounts[keys.indexOf(v.wallet)] as Raw;
    if (options.close) {
      response.value.accounts[keys.indexOf(key)] = null;
      if (!options.missing)
        wallet.lamports = (
          BigInt(wallet.lamports) + BigInt(prior.lamports)
        ).toString();
    } else {
      const next = structuredClone(prior);
      next.lamports = rent;
      mutate(next, (_b, d) => {
        d.setBigUint64(64, 0n, true);
        if (options.native) d.setBigUint64(113, BigInt(rent), true);
      });
      response.value.accounts[keys.indexOf(key)] = next;
      wallet.lamports = (BigInt(wallet.lamports) - BigInt(rent)).toString();
    }
  };
  return { v, key, mint, program, prior, rent };
}
it.each([{}, { extended: true }, { native: true }])(
  'retains protected canonical intermediate balances: %j',
  async (options) => {
    const { v, key, mint } = await fixture(options),
      result = await run(v);
    expect(result.review.assessment.auxiliaryAccounts).toEqual([
      expect.objectContaining({
        address: key,
        mint,
        beforeAmountRaw: '50000000',
        maximumNetDebitRaw: '0',
      }),
    ]);
    expect(result.review.simulation.auxiliaryTokenDeltas).toEqual([
      {
        account: key,
        mint,
        beforeRaw: '50000000',
        afterRaw: '50000000',
        deltaRaw: '0',
      },
    ]);
    expect(result).toMatchObject({
      approvalCreated: false,
      reservationCreated: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(result.review.auxiliaryMintEvidence?.mints[0].address).toBe(mint);
  },
);
it.each([false, true])(
  'allows positive intermediate dust while preserving SOL accounting, native=%s',
  async (native) => {
    const { v, key } = await fixture({ native });
    const original = v.orderState.onSimulation!;
    v.orderState.onSimulation = (r, keys) => {
      original(r, keys);
      const next = r.value.accounts[keys.indexOf(key)] as Raw;
      mutate(next, (_b, d) => d.setBigUint64(64, 50000001n, true));
      if (native) {
        next.lamports = (BigInt(next.lamports) + 1n).toString();
      }
    };
    const result = await run(v);
    expect(result.review.simulation.auxiliaryTokenDeltas[0].deltaRaw).toBe('1');
    expect(result.review.simulation.nativeTradeDeltaRaw).toBe('0');
  },
);
it.each([{}, { extended: true }, { native: true }])(
  'accounts for newly retained intermediate rent: %j',
  async (options) => {
    const { v, rent } = await fixture({ ...options, missing: true }),
      result = await run(v);
    expect(result.review.assessment.accountCreationRentRaw).toBe(rent);
    expect(result.review.simulation.retainedAccountRentRaw).toBe(rent);
    expect(result.review.simulation.nativeTradeDeltaRaw).toBe('0');
  },
);
it.each([false, true])(
  'refunds only empty intermediate account cleanup, native=%s',
  async (native) => {
    const { v, prior } = await fixture({ close: true, amount: '0', native }),
      result = await run(v);
    expect(result.review.simulation.nativeTradeDeltaRaw).toBe('0');
    expect(result.review.simulation.refundedNonNativeAccountRentRaw).toBe(
      native ? '0' : prior.lamports,
    );
  },
);
it('accounts for a created and closed intermediate without retaining rent', async () => {
  const { v } = await fixture({ missing: true, close: true, amount: '0' }),
    result = await run(v);
  expect(result.review.assessment.accountCreationRentRaw).toBe('2930');
  expect(result.review.simulation.retainedAccountRentRaw).toBe('0');
});
it.each([
  'loss',
  'owner',
  'delegate',
  'close-authority',
  'frozen',
  'rent',
  'missing',
] as const)('rejects simulated intermediate %s', async (mode) => {
  const { v, key } = await fixture();
  v.orderState.onSimulation = (r, keys) => {
    const a = r.value.accounts[keys.indexOf(key)] as Raw;
    if (mode === 'missing') r.value.accounts[keys.indexOf(key)] = null;
    else if (mode === 'rent') a.lamports = (BigInt(a.lamports) - 1n).toString();
    else
      mutate(a, (b, d) => {
        if (mode === 'loss') d.setBigUint64(64, 49999999n, true);
        if (mode === 'owner') b.set(bs58.decode(SYSTEM), 32);
        if (mode === 'delegate') d.setUint32(72, 1, true);
        if (mode === 'close-authority') d.setUint32(129, 1, true);
        if (mode === 'frozen') b[108] = 2;
      });
  };
  await expect(run(v)).rejects.toMatchObject({ status: 409 });
  expect(
    v.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(true);
});
it.each(['loss', 'reserve', 'owner'] as const)(
  'rejects wrapped intermediate %s',
  async (mode) => {
    const { v, key } = await fixture({ native: true });
    v.orderState.onSimulation = (r, keys) => {
      const a = r.value.accounts[keys.indexOf(key)] as Raw;
      mutate(a, (b, d) => {
        if (mode === 'loss') {
          d.setBigUint64(64, 49999999n, true);
          a.lamports = (BigInt(a.lamports) - 1n).toString();
        }
        if (mode === 'reserve') {
          d.setBigUint64(113, 2651n, true);
          a.lamports = (BigInt(a.lamports) + 1n).toString();
        }
        if (mode === 'owner') b.set(bs58.decode(SYSTEM), 32);
      });
    };
    await expect(run(v)).rejects.toMatchObject({ status: 409 });
  },
);
it('refuses closure of any pre-existing intermediate holding', async () => {
  const { v } = await fixture({ close: true });
  await expect(run(v)).rejects.toMatchObject({ status: 409 });
  expect(
    v.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});
it.each(['delegate', 'frozen', 'noncanonical', 'under-rent'] as const)(
  'rejects invalid intermediate pre-state %s',
  async (mode) => {
    const { v, key, prior } = await fixture();
    if (mode === 'delegate') mutate(prior, (_b, d) => d.setUint32(72, 1, true));
    if (mode === 'frozen')
      mutate(prior, (b) => {
        b[108] = 2;
      });
    if (mode === 'under-rent') prior.lamports = '1';
    if (mode === 'noncanonical') {
      const wrong = bs58.encode(new Uint8Array(32).fill(77));
      v.orderState.otherAccounts.delete(key);
      v.orderState.otherAccounts.set(wrong, prior);
      v.orderState.transform = (m) => {
        m.instructions[0].accountIndices!.push(writable(m, wrong));
        return m;
      };
    }
    await expect(run(v)).rejects.toMatchObject({ status: 409 });
  },
);
it.each(['balance', 'mint-policy'] as const)(
  'rejects late %s changes after simulation',
  async (mode) => {
    const { v, prior, mint } = await fixture();
    v.orderState.onSimulation = () => {
      if (mode === 'balance')
        mutate(prior, (_b, d) => d.setBigUint64(64, 50000001n, true));
      else v.orderState.auxiliaryMints.set(mint, pairQuoteMint(7, SWAP_TOKEN));
    };
    await expect(run(v)).rejects.toMatchObject({ status: 409 });
  },
);
it('requires gross setup rent to fit the user limit even when cleanup refunds it', async () => {
  const { v } = await fixture({ missing: true, close: true, amount: '0' });
  v.orderRequest.feeAndRentLimitRaw = '5000';
  await expect(run(v)).rejects.toMatchObject({ status: 409 });
});
it.each([
  'missing-mint',
  'invalid-owner',
  'changed-program',
  'writable-mint',
  'extra-sol-debit',
] as const)('rejects %s in the protected intermediate path', async (mode) => {
  const { v, mint } = await fixture();
  if (mode === 'missing-mint') v.orderState.auxiliaryMints.set(mint, null);
  if (mode === 'invalid-owner')
    v.orderState.auxiliaryMints.set(mint, pairQuoteMint(6, SYSTEM));
  if (mode === 'changed-program')
    v.orderState.auxiliaryMints.set(mint, pairQuoteMint(6, SWAP_TOKEN_2022));
  if (mode === 'writable-mint') {
    const original = v.orderState.transform!;
    v.orderState.transform = (m) => {
      m = original(m);
      const oldKeys = [...m.staticAccounts];
      const index = m.staticAccounts.indexOf(address(mint));
      m.staticAccounts.splice(index, 1);
      m.staticAccounts.splice(3, 0, address(mint));
      m.header.numReadonlyNonSignerAccounts--;
      m.instructions = m.instructions.map((ix) => ({
        ...ix,
        programAddressIndex: m.staticAccounts.indexOf(
          oldKeys[ix.programAddressIndex],
        ),
        accountIndices: ix.accountIndices?.map((i) =>
          m.staticAccounts.indexOf(oldKeys[i]),
        ),
      }));
      return m;
    };
  }
  if (mode === 'extra-sol-debit')
    v.orderState.onSimulation = (r, keys) => {
      const wallet = r.value.accounts[keys.indexOf(v.wallet)] as Raw;
      wallet.lamports = (BigInt(wallet.lamports) - 1n).toString();
    };
  await expect(run(v)).rejects.toMatchObject({ status: 409 });
});
it('bounds the number of independently protected intermediate assets before simulation', async () => {
  const { v } = await fixture();
  const extras = await Promise.all(
    Array.from({ length: 8 }, async (_, i) => {
      const mint = bs58.encode(new Uint8Array(32).fill(40 + i)),
        metadata = await inspectPairMintAccount(
          pairQuoteMint(6, SWAP_TOKEN),
          mint,
        ),
        key = await pairAssociatedAddress(metadata, v.wallet);
      v.orderState.auxiliaryMints.set(mint, pairQuoteMint(6, SWAP_TOKEN));
      v.orderState.otherAccounts.set(
        key,
        pairWalletTokenAccount(mint, v.wallet, SWAP_TOKEN, '1'),
      );
      return key;
    }),
  );
  const original = v.orderState.transform!;
  v.orderState.transform = (m) => {
    m = original(m);
    for (const key of extras) writable(m, key);
    return m;
  };
  await expect(run(v)).rejects.toMatchObject({ status: 409 });
  expect(
    v.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});
it.each([false, true])(
  'reviews empty seeded wrapped intermediates with exact gross rent, extraFunding=%s',
  async (extraFunding) => {
    const {
      v,
      key: canonical,
      rent,
    } = await fixture({
      missing: true,
      close: true,
      amount: '0',
      native: true,
    });
    const seed = new TextEncoder().encode('pair-intermediate');
    const seeded = bs58.encode(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          Uint8Array.from([
            ...bs58.decode(v.wallet),
            ...seed,
            ...bs58.decode(SWAP_TOKEN),
          ]),
        ),
      ),
    );
    v.orderState.otherAccounts.delete(canonical);
    v.orderState.otherAccounts.set(seeded, null);
    const original = v.orderState.transform!;
    v.orderState.transform = (m) => {
      m = original(m);
      m.staticAccounts[3] = address(seeded);
      const offset = 44 + seed.length,
        b = new Uint8Array(offset + 48),
        d = new DataView(b.buffer);
      d.setUint32(0, 3, true);
      b.set(bs58.decode(v.wallet), 4);
      d.setBigUint64(36, BigInt(seed.length), true);
      b.set(seed, 44);
      d.setBigUint64(offset, BigInt(rent) + (extraFunding ? 1n : 0n), true);
      d.setBigUint64(offset + 8, 165n, true);
      b.set(bs58.decode(SWAP_TOKEN), offset + 16);
      m.instructions.splice(
        0,
        1,
        {
          programAddressIndex: readonly(m, SYSTEM),
          accountIndices: [0, 3],
          data: b,
        },
        {
          programAddressIndex: readonly(m, SWAP_TOKEN),
          accountIndices: [3, readonly(m, SWAP_WRAPPED_SOL)],
          data: Uint8Array.from([18, ...bs58.decode(v.wallet)]),
        },
      );
      return m;
    };
    v.orderState.onSimulation = (r, keys) => {
      r.value.accounts[keys.indexOf(seeded)] = null;
    };
    if (extraFunding)
      await expect(run(v)).rejects.toMatchObject({ status: 409 });
    else {
      const result = await run(v);
      expect(result.review.assessment.auxiliaryAccounts[0]).toMatchObject({
        address: seeded,
        seeded: true,
        closed: true,
        maximumNetDebitRaw: '0',
      });
      expect(result.review.simulation.nativeTradeDeltaRaw).toBe('0');
    }
  },
);
it('returns new intermediate SOL dust through empty wrapped-account cleanup', async () => {
  const { v } = await fixture({ native: true, close: true, amount: '0' });
  const original = v.orderState.onSimulation!;
  v.orderState.onSimulation = (r, keys) => {
    original(r, keys);
    const w = r.value.accounts[keys.indexOf(v.wallet)] as Raw;
    w.lamports = (BigInt(w.lamports) + 1n).toString();
  };
  const result = await run(v);
  expect(result.review.simulation.nativeTradeDeltaRaw).toBe('1');
});
