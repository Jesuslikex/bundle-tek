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
import {
  prepareOwnedImportedPairOrder,
  importedPairOrderRequest,
} from './imported-pair-order-candidate';
import { SWAP_TOKEN, SWAP_WRAPPED_SOL } from './swap-token-program-evidence';
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
      economicSimulationVerified: false,
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
    expect(f.prepare).toHaveBeenCalledOnce();
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
it.each(['Buy', 'Sell'] as const)(
  'checks canonical automatic SOL wrapping/unwrapping for %s with captured TSLAX extensions',
  async (side) => {
    f = await pairOrderFixture(side);
    const fixture = f;
    await nativeStock(fixture, side);
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
        {
          programAddressIndex: token,
          accountIndices: [target, 0, 0],
          data: Uint8Array.from([9]),
        },
      ];
      return m;
    };
    const result = await run(fixture);
    expect(result.review.assessment).toMatchObject({
      nativeWrappingRaw: side === 'Buy' ? '500000000' : '0',
      accountCreationRentRaw: '2650',
      networkFeeRaw: '5000',
    });
    expect(
      result.review.assessment.accounts.find((a) => a.mint === SWAP_WRAPPED_SOL)
        ?.closed,
    ).toBe(true);
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
    v.setBigUint64(offset, 500002650n, true);
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
    else await expect(run(f)).rejects.toMatchObject({ status: 409 });
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
