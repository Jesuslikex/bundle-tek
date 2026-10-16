import { afterEach, expect, it } from 'vitest';
import bs58 from 'bs58';
import { address } from '@solana/kit';
import { pairOrderFixture } from '../test/pair-order-fixture';
import { pairWalletTokenAccount } from '../test/pair-wallet-fixture';
import {
  pairAssociatedAddress,
  requiredPairAccountExtensions,
} from './pair-wallet-evidence';
import { importedTokenDocument } from './imported-token-project';
import { pairQuoteMint } from '../test/imported-pair-quote-fixture';
import { pairQuoteClock } from '../test/imported-pair-quote-fixture';
import {
  prepareOwnedImportedPairOrder,
  inspectOwnedImportedPairOrder,
  importedPairOrderRequest,
} from './imported-pair-order-candidate';
import { SWAP_TOKEN, SWAP_WRAPPED_SOL } from './swap-token-program-evidence';
import { PAIR_CLOCK } from './pair-mint-evidence';
import { pairRentAccount } from '../test/pair-rent-fixture';
type Fixture = Awaited<ReturnType<typeof pairOrderFixture>>;
type Message = Awaited<ReturnType<Fixture['makeMessage']>>;
let f: Fixture | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
const run = (
  v: Fixture,
  owner = 'alice',
  signal = new AbortController().signal,
) =>
  prepareOwnedImportedPairOrder(
    v.db,
    owner,
    v.orderRequest,
    signal,
    v.orderDependencies,
  );
function addReadonly(m: Message, key: string) {
  let index = m.staticAccounts.findIndex((a) => a === key);
  if (index < 0) {
    index = m.staticAccounts.length;
    m.staticAccounts.push(address(key));
    m.header.numReadonlyNonSignerAccounts++;
  }
  return index;
}
it.each(['rate', 'burn'] as const)(
  'rejects a changed Rent %s after the original-packet simulation',
  async (mode) => {
    const v = (f = await pairOrderFixture());
    v.orderState.onSimulation = () => {
      v.state.rentAccount = pairRentAccount(
        mode === 'rate' ? 11n : 10n,
        1,
        mode === 'burn' ? 51 : 50,
      );
    };
    await expect(run(v)).rejects.toMatchObject({ status: 409 });
  },
);
it('uses only bank-bound Rent snapshots throughout an unsigned order review', async () => {
  const v = (f = await pairOrderFixture());
  expect((await run(v)).executionAllowed).toBe(false);
  expect(
    v.rpc.mock.calls.some(
      ([method]) => method === 'getMinimumBalanceForRentExemption',
    ),
  ).toBe(false);
});
it.each(['valid', 'below-floor', 'too-old'] as const)(
  'retains individual request floors for parallel final observations: %s',
  async (mode) => {
    const v = (f = await pairOrderFixture()),
      original = v.rpc.getMockImplementation()!;
    let afterSimulation = false,
      releaseMint = () => {};
    const walletReturned = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    v.orderState.onSimulation = () => {
      afterSimulation = true;
    };
    v.rpc.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (afterSimulation && method === 'getMultipleAccounts') {
        const keys = params[0] as string[],
          config = params[1] as { minContextSlot: number };
        if (keys[0] === v.wallet) {
          (result as { context: { slot: string } }).context.slot = String(
            config.minContextSlot +
              (mode === 'too-old' ? 33 : mode === 'below-floor' ? -1 : 2),
          );
          releaseMint();
          if (keys.includes(PAIR_CLOCK)) {
            const r = result as { context: { slot: string }; value: unknown[] };
            r.value[keys.indexOf(PAIR_CLOCK)] = pairQuoteClock(
              Number(r.context.slot),
              String(Math.floor(v.clock.now / 1000)),
            );
          }
        }
        if (keys.includes(PAIR_CLOCK)) {
          await walletReturned;
          await Promise.resolve();
        }
      }
      return result;
    });
    if (mode === 'valid') {
      const result = await run(v);
      expect(
        result.review.maximumSlot - result.review.minimumSlot,
      ).toBeLessThanOrEqual(32);
      expect(result.economicSimulationVerified).toBe(true);
    } else await expect(run(v)).rejects.toMatchObject({ status: 409 });
  },
);
function addWritable(m: Message, key: string) {
  m.staticAccounts.splice(3, 0, address(key));
  m.instructions = m.instructions.map((i) => ({
    ...i,
    programAddressIndex:
      i.programAddressIndex >= 3
        ? i.programAddressIndex + 1
        : i.programAddressIndex,
    accountIndices: i.accountIndices?.map((a) => (a >= 3 ? a + 1 : a)),
  }));
  return 3;
}
it.each([
  { side: 'Buy' as const, shared: false },
  { side: 'Sell' as const, shared: false },
  { side: 'Buy' as const, shared: true },
  { side: 'Sell' as const, shared: true },
])(
  'prepares a $side stock candidate using V2 shared=$shared without creating approval',
  async ({ side, shared }) => {
    f = await pairOrderFixture(side);
    f.orderState.shared = shared;
    const result = await run(f);
    expect(result).toMatchObject({
      format: 'imported-pair-order-candidate-v1',
      candidatePrepared: true,
      economicSimulationVerified: true,
      approvalCreated: false,
      reservationCreated: false,
      signingAllowed: false,
      executionAllowed: false,
      review: {
        assessment: {
          topLevelInstructionsChecked: true,
          economicSimulationVerified: false,
          networkFeeRaw: '5000',
          nativeWrappingRaw: '0',
          accountCreationRentRaw: '0',
          rawInput: '1',
        },
        programCodeAttested: false,
      },
    });
    expect(result.order.preparation.sha256).toBe(result.review.packetSha256);
    expect(result.review.simulation).toMatchObject({
      economicSimulationVerified: true,
      signatureVerified: false,
      providerObservationOnly: true,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(
      f.rpc.mock.calls.find(
        ([method]) => method === 'simulateTransaction',
      )?.[1],
    ).toEqual([
      result.order.preparation.transaction,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: false,
        replaceRecentBlockhash: false,
        minContextSlot: expect.any(Number),
        accounts: {
          encoding: 'base64',
          addresses: result.review.writableAccounts,
        },
      },
    ]);
    expect(f.prepare).toHaveBeenCalledOnce();
    const snapshots = f.rpc.mock.calls.filter(
      ([method, params]) =>
        method === 'getMultipleAccounts' &&
        (params[0] as string[])[0] === f!.wallet &&
        (params[0] as string[]).includes(PAIR_CLOCK),
    );
    expect(snapshots).toHaveLength(4);
    for (const [, params] of snapshots)
      expect(params[0]).toEqual(
        expect.arrayContaining([f.baseMint, f.asset.address]),
      );
    const url = new URL(f.orderFetcher.mock.calls[0][0] as URL);
    expect(url.searchParams.get('taker')).toBe(f.wallet);
    expect(url.searchParams.get('excludeRouters')).toBe('jupiterz,dflow,okx');
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM imported_token_project_events')
        .get(),
    ).toMatchObject({ n: 0 });
  },
);
it.each(['foreign', 'revision', 'consent', 'authority'] as const)(
  'rejects %s before requesting an order',
  async (mode) => {
    const fixture = (f = await pairOrderFixture());
    if (mode === 'revision') fixture.orderRequest.walletRevision = 2;
    if (mode === 'consent')
      expect(() =>
        importedPairOrderRequest({
          ...fixture.orderRequest,
          prepareUnsigned: false,
        }),
      ).toThrow();
    else if (mode === 'authority')
      expect(() =>
        importedPairOrderRequest({
          ...fixture.orderRequest,
          signingAllowed: true,
        }),
      ).toThrow();
    else
      await expect(
        run(fixture, mode === 'foreign' ? 'bob' : 'alice'),
      ).rejects.toMatchObject({ status: mode === 'foreign' ? 404 : 409 });
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.rpc).not.toHaveBeenCalled();
  },
);
it('does not request a wallet-bound packet without sufficient source balance', async () => {
  f = await pairOrderFixture();
  f.accounts[1] = null;
  await expect(run(f)).rejects.toMatchObject({ status: 409 });
  expect(f.prepare).not.toHaveBeenCalled();
});
it.each([
  'raw-input',
  'authority',
  'extra-transfer',
  'extra-wallet-account',
  'mint-write',
] as const)('rejects a candidate with %s', async (mode) => {
  f = await pairOrderFixture();
  const fixture = f;
  fixture.orderState.transform = (m) => {
    if (mode === 'raw-input') {
      const b = Uint8Array.from(m.instructions[0].data);
      new DataView(b.buffer).setBigUint64(8, 2n, true);
      m.instructions[0] = { ...m.instructions[0], data: b };
    }
    if (mode === 'authority') {
      m.instructions.unshift({
        programAddressIndex: 5,
        accountIndices: [1, 0],
        data: Uint8Array.from([6, 2, 0]),
      });
    }
    if (mode === 'extra-transfer' || mode === 'extra-wallet-account') {
      const other = bs58.encode(new Uint8Array(32).fill(11)),
        index = addWritable(m, other);
      if (mode === 'extra-wallet-account')
        fixture.orderState.otherAccounts.set(
          other,
          pairWalletTokenAccount(
            fixture.asset.address,
            fixture.wallet,
            fixture.mints[1].owner,
            '1',
          ),
        );
      else {
        const program = addReadonly(m, '11111111111111111111111111111111'),
          data = new Uint8Array(12);
        new DataView(data.buffer).setUint32(0, 2, true);
        new DataView(data.buffer).setBigUint64(4, 1n, true);
        m.instructions.unshift({
          programAddressIndex: program,
          accountIndices: [0, index],
          data,
        });
      }
    }
    if (mode === 'mint-write') m.header.numReadonlyNonSignerAccounts--;
    return m;
  };
  await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
});
it.each(['fee', 'height', 'blockhash'] as const)(
  'refuses changed or excessive %s evidence',
  async (mode) => {
    f = await pairOrderFixture();
    if (mode === 'fee') f.orderState.feeRaw = '10000001';
    if (mode === 'height') f.orderState.height = '175';
    if (mode === 'blockhash') f.orderState.valid = false;
    await expect(run(f)).rejects.toMatchObject({ status: 409 });
  },
);
it('rejects source balance or saved context changes after preparation', async () => {
  f = await pairOrderFixture();
  const fixture = f,
    original = f.prepare.getMockImplementation()!;
  f.prepare.mockImplementation(async (...args) => {
    const order = await original(...args);
    fixture.sqlite.prepare('UPDATE workspace_wallets SET revision=2').run();
    return order;
  });
  await expect(run(f)).rejects.toMatchObject({ status: 409 });
});
it('rechecks exact selected account balances after instruction review', async () => {
  f = await pairOrderFixture();
  const fixture = f;
  f.state.onWalletRead = (n) => {
    if (n === 4) fixture.state.walletAccount!.lamports = '999999999';
  };
  await expect(run(f)).rejects.toMatchObject({ status: 409 });
});
it.each(['stable', 'changed'] as const)(
  'independently resolves and rechecks %s ALT contents',
  async (mode) => {
    f = await pairOrderFixture();
    const fixture = f,
      table = bs58.encode(new Uint8Array(32).fill(12));
    const bytes = new Uint8Array(88),
      view = new DataView(bytes.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, (1n << 64n) - 1n, true);
    view.setBigUint64(12, 50n, true);
    bytes.set(bs58.decode('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), 56);
    const raw = {
      owner: 'AddressLookupTab1e1111111111111111111111111',
      executable: false,
      lamports: '5000000',
      data: [btoa(String.fromCharCode(...bytes)), 'base64'],
    };
    fixture.orderState.otherAccounts.set(table, raw);
    fixture.orderState.transform = (m) => {
      m.staticAccounts.splice(6, 1);
      m.header.numReadonlyNonSignerAccounts--;
      return {
        ...m,
        addressTableLookups: [
          {
            lookupTableAddress: address(table),
            writableIndexes: [],
            readonlyIndexes: [0],
          },
        ],
      };
    };
    if (mode === 'changed') {
      const original = fixture.rpc.getMockImplementation()!;
      let reads = 0;
      fixture.rpc.mockImplementation(async (method, params) => {
        if (
          method === 'getMultipleAccounts' &&
          (params[0] as string[])[0] === table &&
          ++reads === 2
        ) {
          bytes[56] ^= 1;
          raw.data[0] = btoa(String.fromCharCode(...bytes));
        }
        return original(method, params);
      });
    }
    if (mode === 'changed')
      await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
    else expect((await run(fixture)).review.lookupTables).toHaveLength(1);
  },
);
async function nativeStock(v: Fixture, side: 'Buy' | 'Sell') {
  const stock = v.mintEvidence.mints[1];
  const document = importedTokenDocument(
    { chain: 'Solana', address: stock.address },
    {
      chain: 'Solana',
      address: stock.address,
      name: 'Captured TSLAX mint fixture',
      symbol: 'TSLAX',
      decimals: 8,
      totalSupplyRaw: '1000000000',
      metadataUri: 'https://fixture.example/metadata.json',
      observedAt: new Date(v.clock.now).toISOString(),
      source: 'https://fixture.example',
      contextSlot: 100,
      tokenProgram: stock.program,
    },
  );
  v.sqlite
    .prepare('UPDATE imported_token_projects SET address=?,document=?')
    .run(stock.address, JSON.stringify(document));
  v.mints[0] = structuredClone(v.mints[1]);
  v.mints[1] = pairQuoteMint(9, SWAP_TOKEN);
  v.atas[0] = await pairAssociatedAddress(stock, v.wallet);
  v.accounts[0] = pairWalletTokenAccount(
    stock.address,
    v.wallet,
    stock.program,
    '500000000',
    requiredPairAccountExtensions(stock),
  );
  v.orderRequest.quoteMint = SWAP_WRAPPED_SOL;
  v.orderRequest.amount = side === 'Buy' ? '0.5' : '0.1';
}
const nativeCases: {
  side: 'Buy' | 'Sell';
  existing: boolean;
  retain?: boolean;
  nullClosed?: boolean;
  bad?:
    | 'refund'
    | 'output'
    | 'cleanup'
    | 'residual'
    | 'closed-owner'
    | 'closed-executable'
    | 'closed-data'
    | 'reserve';
}[] = [
  { side: 'Buy' as const, existing: false },
  { side: 'Sell' as const, existing: false },
  { side: 'Buy' as const, existing: true },
  { side: 'Sell' as const, existing: true },
  { side: 'Buy', existing: false, retain: true },
  { side: 'Buy', existing: true, retain: true },
  { side: 'Buy', existing: true, bad: 'refund' },
  { side: 'Sell', existing: true, bad: 'output' },
  { side: 'Buy', existing: false, bad: 'cleanup' },
  { side: 'Buy', existing: true, retain: true, bad: 'residual' },
  { side: 'Buy', existing: false, nullClosed: true },
  { side: 'Buy', existing: false, bad: 'closed-owner' },
  { side: 'Buy', existing: false, bad: 'closed-executable' },
  { side: 'Buy', existing: false, bad: 'closed-data' },
  { side: 'Buy', existing: true, retain: true, bad: 'reserve' },
];
it.each(nativeCases)(
  'checks SOL simulation for $side existing=$existing retain=$retain bad=$bad',
  async ({ side, existing, retain, bad, nullClosed }) => {
    f = await pairOrderFixture(side);
    const fixture = f;
    fixture.orderState.closedAsNull = nullClosed ?? false;
    await nativeStock(fixture, side);
    if (existing) {
      const mint = {
        ...fixture.mintEvidence.mints[0],
        address: SWAP_WRAPPED_SOL,
        program: SWAP_TOKEN,
      };
      const ata = await pairAssociatedAddress(mint, fixture.wallet);
      const token = pairWalletTokenAccount(
        SWAP_WRAPPED_SOL,
        fixture.wallet,
        SWAP_TOKEN,
        '10000000',
      );
      token.lamports = '10002930';
      editToken(token, (_b, view) => {
        view.setUint32(109, 1, true);
        view.setBigUint64(113, 2930n, true);
      });
      fixture.orderState.otherAccounts.set(ata, token);
    }
    fixture.orderState.transform = (m) => {
      const system = addReadonly(m, '11111111111111111111111111111111'),
        ata = addReadonly(m, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      const target = side === 'Buy' ? 1 : 2,
        mint = side === 'Buy' ? 3 : 4,
        token = m.staticAccounts.findIndex((a) => a === SWAP_TOKEN);
      const setup = [
        {
          programAddressIndex: ata,
          accountIndices: [0, target, 0, mint, system, token],
          data: Uint8Array.from([1]),
        },
      ];
      if (side === 'Buy') {
        const data = new Uint8Array(12),
          v = new DataView(data.buffer);
        v.setUint32(0, 2, true);
        v.setBigUint64(4, 500000000n, true);
        setup.push({
          programAddressIndex: system,
          accountIndices: [0, target],
          data,
        });
        setup.push({
          programAddressIndex: token,
          accountIndices: [target],
          data: Uint8Array.from([17]),
        });
      }
      m.instructions = [
        ...setup,
        ...m.instructions,
        ...(!retain
          ? [
              {
                programAddressIndex: token,
                accountIndices: [target, 0, 0],
                data: Uint8Array.from([9]),
              },
            ]
          : []),
      ];
      return m;
    };
    if (bad) {
      const nativeKey = await pairAssociatedAddress(
        {
          ...fixture.mintEvidence.mints[0],
          address: SWAP_WRAPPED_SOL,
          program: SWAP_TOKEN,
        },
        fixture.wallet,
      );
      fixture.orderState.onSimulation = (response, keys) => {
        if (bad === 'refund' || bad === 'output') {
          const wallet = response.value.accounts[
            keys.indexOf(fixture.wallet)
          ] as PostAccount;
          wallet.lamports = (
            BigInt(wallet.lamports) - (bad === 'refund' ? 10002930n : 5001n)
          ).toString();
        } else {
          if (bad === 'reserve') {
            const token = response.value.accounts[
              keys.indexOf(nativeKey)
            ] as PostAccount;
            const wallet = response.value.accounts[
              keys.indexOf(fixture.wallet)
            ] as PostAccount;
            token.lamports = (BigInt(token.lamports) + 1n).toString();
            wallet.lamports = (BigInt(wallet.lamports) - 1n).toString();
            editToken(token, (_b, view) => view.setBigUint64(113, 2651n, true));
          } else if (bad.startsWith('closed-')) {
            const closed = response.value.accounts[
              keys.indexOf(nativeKey)
            ] as PostAccount;
            if (bad === 'closed-owner') closed.owner = SWAP_TOKEN;
            if (bad === 'closed-executable') closed.executable = true;
            if (bad === 'closed-data') closed.data[0] = 'AA==';
          } else if (bad === 'cleanup')
            response.value.accounts[keys.indexOf(nativeKey)] =
              fixture.state.walletAccount;
          else
            editToken(
              response.value.accounts[keys.indexOf(nativeKey)],
              (_b, view) => view.setBigUint64(64, 10000001n, true),
            );
        }
      };
      await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
      return;
    }
    const result = await run(fixture);
    expect(result.review.assessment).toMatchObject({
      nativeWrappingRaw: side === 'Buy' ? '500000000' : '0',
      accountCreationRentRaw: existing ? '0' : '2930',
      networkFeeRaw: '5000',
    });
    expect(
      result.review.assessment.accounts.find((a) => a.mint === SWAP_WRAPPED_SOL)
        ?.closed,
    ).toBe(!retain);
    expect(result.review.simulation).toMatchObject({
      nativeTradeDeltaRaw: side === 'Buy' ? '-500000000' : '1000000',
      retainedAccountRentRaw: retain && !existing ? '2930' : '0',
      economicSimulationVerified: true,
    });
  },
);
it('validates seeded SOL wrapping, initializer ownership and wallet-bound cleanup', async () => {
  f = await pairOrderFixture();
  const fixture = f;
  await nativeStock(fixture, 'Buy');
  const seed = new TextEncoder().encode('pair-order-test'),
    target = bs58.encode(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          Uint8Array.from([
            ...bs58.decode(fixture.wallet),
            ...seed,
            ...bs58.decode(SWAP_TOKEN),
          ]).buffer,
        ),
      ),
    );
  fixture.orderState.transform = (m) => {
    m.staticAccounts[1] = address(target);
    const system = addReadonly(m, '11111111111111111111111111111111'),
      token = m.staticAccounts.findIndex((a) => a === SWAP_TOKEN);
    const data = new Uint8Array(44 + seed.length + 48),
      v = new DataView(data.buffer),
      offset = 44 + seed.length;
    v.setUint32(0, 3, true);
    data.set(bs58.decode(fixture.wallet), 4);
    v.setBigUint64(36, BigInt(seed.length), true);
    data.set(seed, 44);
    v.setBigUint64(offset, 500002930n, true);
    v.setBigUint64(offset + 8, 165n, true);
    data.set(bs58.decode(SWAP_TOKEN), offset + 16);
    m.instructions = [
      { programAddressIndex: system, accountIndices: [0, 1], data },
      {
        programAddressIndex: token,
        accountIndices: [1, 3],
        data: Uint8Array.from([18, ...bs58.decode(fixture.wallet)]),
      },
      ...m.instructions,
      {
        programAddressIndex: token,
        accountIndices: [1, 0, 0],
        data: Uint8Array.from([9]),
      },
    ];
    return m;
  };
  const result = await run(fixture);
  expect(result.review.assessment.accounts[0]).toMatchObject({
    seeded: true,
    created: true,
    closed: true,
    address: target,
  });
  expect(result.review.assessment.nativeWrappingRaw).toBe('500000000');
});
it.each([false, true])(
  'retains synthetic legacy-program V1 route support, shared=%s',
  async (shared) => {
    f = await pairOrderFixture();
    const fixture = f,
      quote = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    fixture.orderState.v2 = false;
    fixture.orderState.shared = shared;
    fixture.orderRequest.quoteMint = quote;
    fixture.orderRequest.amount = '0.000001';
    fixture.mints[0] = pairQuoteMint(6, SWAP_TOKEN);
    fixture.mints[1] = pairQuoteMint(6, SWAP_TOKEN);
    fixture.sqlite
      .prepare(
        "UPDATE imported_token_projects SET document=json_set(document,'$.token.tokenProgram',?)",
      )
      .run(SWAP_TOKEN);
    for (const [i, mint] of [fixture.baseMint, quote].entries()) {
      const asset = {
        ...fixture.mintEvidence.mints[i],
        address: mint,
        program: SWAP_TOKEN,
      };
      fixture.atas[i] = await pairAssociatedAddress(asset, fixture.wallet);
      fixture.accounts[i] = pairWalletTokenAccount(
        mint,
        fixture.wallet,
        SWAP_TOKEN,
        '20000000',
      );
    }
    expect((await run(fixture)).review.assessment.route.status).toBe(
      'Matched fields',
    );
  },
);
it('refuses Token-2022 admission through the legacy V1 interface', async () => {
  f = await pairOrderFixture();
  f.orderState.v2 = false;
  await expect(run(f)).rejects.toMatchObject({ status: 409 });
});
it.each(['valid', 'duplicate', 'excessive-price'] as const)(
  'checks %s compute-budget instructions against the independently observed fee',
  async (mode) => {
    f = await pairOrderFixture();
    f.orderState.transform = (m) => {
      const program = addReadonly(
          m,
          'ComputeBudget111111111111111111111111111111',
        ),
        limit = new Uint8Array(5),
        price = new Uint8Array(9);
      limit[0] = 2;
      new DataView(limit.buffer).setUint32(1, 200000, true);
      price[0] = 3;
      new DataView(price.buffer).setBigUint64(
        1,
        mode === 'excessive-price' ? 1000000000n : 10n,
        true,
      );
      const instructions = [
        { programAddressIndex: program, accountIndices: [], data: limit },
        { programAddressIndex: program, accountIndices: [], data: price },
      ];
      if (mode === 'duplicate') instructions.push({ ...instructions[0] });
      m.instructions = [...instructions, ...m.instructions];
      return m;
    };
    if (mode === 'valid')
      expect((await run(f)).review.assessment.priorityFeeUpperBoundRaw).toBe(
        '2',
      );
    else
      await expect(run(f)).rejects.toMatchObject({
        status: 409,
        cause: {
          message:
            'Pair candidate instructions, accounts or raw spending limits differ.',
          pairDiagnostic: {
            check:
              mode === 'duplicate' ? 'compute-placement' : 'native-fee-budget',
          },
        },
      });
  },
);
it('refuses a block-height observation that moves backwards', async () => {
  f = await pairOrderFixture();
  const original = f.rpc.getMockImplementation()!;
  let heights = 0;
  f.rpc.mockImplementation(async (method, params) =>
    method === 'getBlockHeight' && ++heights === 2
      ? '99'
      : original(method, params),
  );
  await expect(run(f)).rejects.toMatchObject({ status: 409 });
});
it('cancels a stalled wallet-bound provider without storing approval or signed material', async () => {
  f = await pairOrderFixture();
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  f.prepare.mockImplementation(() => {
    begin();
    return new Promise(() => {});
  });
  const controller = new AbortController(),
    pending = run(f, 'alice', controller.signal);
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ status: 408 });
  expect(
    f.sqlite
      .prepare('SELECT count(*) AS n FROM imported_token_project_events')
      .get(),
  ).toMatchObject({ n: 0 });
});

type PostAccount = {
  owner: string;
  executable: boolean;
  lamports: string;
  data: string[];
};
function editToken(
  raw: unknown,
  edit: (bytes: Uint8Array, view: DataView) => void,
) {
  const a = raw as PostAccount;
  const bytes = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
  edit(bytes, new DataView(bytes.buffer));
  a.data[0] = btoa(String.fromCharCode(...bytes));
}
it.each(['Buy', 'Sell'] as const)(
  'independently verifies %s raw token amounts and SOL conservation',
  async (side) => {
    const fixture = (f = await pairOrderFixture(side));
    const result = await run(fixture);
    const simulation = result.review.simulation;
    expect(simulation.nativeTradeDeltaRaw).toBe('0');
    expect(simulation.walletLamportsBeforeRaw).toBe('1000000000');
    expect(simulation.walletLamportsAfterRaw).toBe('999995000');
    expect(
      simulation.tokenDeltas.find((a) => a.mint === result.order.inputMint)
        ?.deltaRaw,
    ).toBe('-1');
    expect(
      simulation.tokenDeltas.find((a) => a.mint === result.order.outputMint)
        ?.deltaRaw,
    ).toBe('1000000');
    expect(simulation.postAccountsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.review.sha256).toMatch(/^[a-f0-9]{64}$/);
  },
);
it.each(['Buy', 'Sell'] as const)(
  'preserves %s u64 balances beyond Number precision',
  async (side) => {
    const fixture = (f = await pairOrderFixture(side));
    for (const account of fixture.accounts)
      editToken(account, (_b, view) =>
        view.setBigUint64(64, 9007199254740993n, true),
      );
    const result = await run(fixture);
    expect(result.review.simulation.tokenDeltas[0]).toMatchObject({
      beforeRaw: '9007199254740993',
      afterRaw: '9007199254740992',
      deltaRaw: '-1',
    });
  },
);
it.each([
  'source-over',
  'source-under',
  'output-under',
  'delegate',
  'owner',
  'freeze',
  'close-authority',
  'rent',
  'extensions',
] as const)(
  'refuses simulated %s despite valid top-level instructions',
  async (mode) => {
    const fixture = (f = await pairOrderFixture());
    fixture.orderState.onSimulation = (response, keys) => {
      const sourceKey = fixture.atas[1],
        destinationKey = fixture.atas[0];
      const index = keys.indexOf(
        mode === 'output-under' ? destinationKey : sourceKey,
      );
      const token = response.value.accounts[index] as PostAccount;
      if (mode === 'owner') token.owner = '11111111111111111111111111111111';
      else if (mode === 'rent')
        token.lamports = (BigInt(token.lamports) + 1n).toString();
      else
        editToken(token, (bytes, view) => {
          if (mode === 'source-over')
            view.setBigUint64(64, view.getBigUint64(64, true) - 1n, true);
          if (mode === 'source-under')
            view.setBigUint64(64, view.getBigUint64(64, true) + 1n, true);
          if (mode === 'output-under')
            view.setBigUint64(64, 20000000n + 994999n, true);
          if (mode === 'delegate') {
            view.setUint32(72, 1, true);
            bytes.set(bs58.decode(fixture.wallet), 76);
          }
          if (mode === 'close-authority') {
            view.setUint32(129, 1, true);
            bytes.set(bs58.decode(fixture.wallet), 133);
          }
          if (mode === 'freeze') bytes[108] = 2;
          if (mode === 'extensions') bytes[170] = 0xff;
        });
    };
    await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
  },
);
it.each(['fee-drain', 'unexpected-credit'] as const)(
  'rejects %s in simulated SOL balances',
  async (mode) => {
    const fixture = (f = await pairOrderFixture());
    fixture.orderState.onSimulation = (response, keys) => {
      const wallet = response.value.accounts[
        keys.indexOf(fixture.wallet)
      ] as PostAccount;
      wallet.lamports = (
        BigInt(wallet.lamports) + (mode === 'fee-drain' ? -1n : 1n)
      ).toString();
    };
    await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
  },
);
it.each([
  'err',
  'missing',
  'null-wallet',
  'replacement',
  'compute-zero',
  'compute-excess',
  'stale-slot',
  'distant-slot',
  'encoding',
] as const)(
  'refuses incomplete or altered simulation evidence: %s',
  async (mode) => {
    const fixture = (f = await pairOrderFixture());
    fixture.orderState.onSimulation = (response, keys) => {
      if (mode === 'err') response.value.err = 'fixture error';
      if (mode === 'missing') response.value.accounts.pop();
      if (mode === 'null-wallet')
        response.value.accounts[keys.indexOf(fixture.wallet)] = null;
      if (mode === 'replacement')
        response.value.replacementBlockhash = { blockhash: 'unexpected' };
      if (mode === 'compute-zero') response.value.unitsConsumed = '0';
      if (mode === 'compute-excess') response.value.unitsConsumed = '1400001';
      if (mode === 'stale-slot') response.context.slot = '1';
      if (mode === 'distant-slot') response.context.slot = '10000000';
      if (mode === 'encoding')
        (response.value.accounts[0] as PostAccount).data = ['', 'jsonParsed'];
    };
    await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
  },
);
it('verifies creation rent and exact output for a previously missing destination ATA', async () => {
  const fixture = (f = await pairOrderFixture());
  fixture.accounts[0] = null;
  fixture.orderState.transform = (m) => {
    const system = addReadonly(m, '11111111111111111111111111111111');
    const ata = addReadonly(m, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const program = m.staticAccounts.findIndex(
      (a) => a === fixture.mints[0].owner,
    );
    m.instructions.unshift({
      programAddressIndex: ata,
      accountIndices: [0, 2, 0, 4, system, program],
      data: Uint8Array.from([1]),
    });
    return m;
  };
  const result = await run(fixture);
  expect(result.review.simulation.retainedAccountRentRaw).toBe(
    result.review.assessment.accountCreationRentRaw,
  );
  expect(
    result.review.simulation.tokenDeltas.find(
      (a) => a.mint === result.order.outputMint,
    ),
  ).toMatchObject({ beforeRaw: '0', afterRaw: '1000000' });
});
it.each(['token', 'mint'] as const)(
  'rejects newly introduced unrelated wallet %s authority in post-state',
  async (mode) => {
    const fixture = (f = await pairOrderFixture());
    const extra = bs58.encode(new Uint8Array(32).fill(33));
    fixture.orderState.transform = (m) => {
      addWritable(m, extra);
      return m;
    };
    fixture.orderState.onSimulation = (response, keys) => {
      const token = pairWalletTokenAccount(
        fixture.baseMint,
        fixture.wallet,
        SWAP_TOKEN,
        '0',
      );
      if (mode === 'mint') {
        const bytes = new Uint8Array(82);
        new DataView(bytes.buffer).setUint32(0, 1, true);
        bytes.set(bs58.decode(fixture.wallet), 4);
        token.data[0] = btoa(String.fromCharCode(...bytes));
      }
      response.value.accounts[keys.indexOf(extra)] = token;
    };
    await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
  },
);
it('rejects an expiry reached during simulation', async () => {
  const fixture = (f = await pairOrderFixture());
  fixture.orderState.onSimulation = () => {
    fixture.clock.now += 30001;
  };
  await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
});
it.each(['match', 'mismatch'] as const)(
  'checks optional simulation fee metadata: %s',
  async (mode) => {
    const fixture = (f = await pairOrderFixture());
    fixture.orderState.onSimulation = (response) => {
      response.value.fee = mode === 'match' ? '5000' : '5001';
    };
    if (mode === 'match')
      expect((await run(fixture)).review.simulation.networkFeeRaw).toBe('5000');
    else await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
  },
);
it('cancels a stalled simulation without storing approval or signature material', async () => {
  const fixture = (f = await pairOrderFixture());
  let start: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const rpc = fixture.rpc.getMockImplementation()!;
  fixture.rpc.mockImplementation(async (method, params) => {
    if (method === 'simulateTransaction') {
      start();
      return new Promise(() => {});
    }
    return rpc(method, params);
  });
  const controller = new AbortController();
  const pending = run(fixture, 'alice', controller.signal);
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ status: 408 });
  expect(
    fixture.sqlite
      .prepare('SELECT count(*) AS n FROM imported_token_project_events')
      .get(),
  ).toMatchObject({ n: 0 });
});

it('retains a private diagnostic cause without exposing it in the public candidate refusal', async () => {
  const v = (f = await pairOrderFixture());
  const cause = new Error('private diagnostic fixture');
  const error = (await inspectOwnedImportedPairOrder(
    v.db,
    'alice',
    v.orderRequest,
    new AbortController().signal,
    v.orderDependencies,
    async () => {
      throw cause;
    },
  ).catch((e: unknown) => e)) as Error & {
    status: number;
    cause: unknown;
  };
  expect(error.status).toBe(409);
  expect(error.message).toBe(
    'Unsigned pair candidate did not pass independent account, instruction, simulation, fee or lifetime review. No approval or signature was created.',
  );
  expect(error.cause).toBe(cause);
  expect(Object.keys(error)).not.toContain('cause');
  expect(JSON.stringify(error)).not.toContain('private diagnostic fixture');
});
