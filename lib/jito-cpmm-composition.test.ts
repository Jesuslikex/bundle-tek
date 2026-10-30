import { address, getProgramDerivedAddress } from '@solana/kit';
import bs58 from 'bs58';
import { expect, it, vi } from 'vitest';
import {
  readJitoCpmmPoolEvidence,
  readJitoCpmmCurrentPoolEvidence,
} from './jito-cpmm-pool-evidence';
import { readJitoCpmmPriceComparison } from './jito-cpmm-price-evidence';
import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import type { TokenMarket } from './token-market';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RENT = 'SysvarRent111111111111111111111111111111111';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR = 'Sysvar1111111111111111111111111111111111111';
const pub = (i: number) => bs58.encode(new Uint8Array(32).fill(i));
async function fixture(reverse = false) {
  const now = Date.now(),
    payer = pub(1),
    pool = pub(5);
  const inputMint = reverse ? USDC : WSOL,
    outputMint = reverse ? WSOL : USDC;
  const pda = (seeds: Uint8Array[], program = CPMM) =>
    getProgramDerivedAddress({ programAddress: address(program), seeds });
  const text = (s: string) => new TextEncoder().encode(s);
  const [authority, bump] = await pda([text('vault_and_lp_mint_auth_seed')]);
  const [config, configBump] = await pda([
    text('amm_config'),
    new Uint8Array([0, 1]),
  ]);
  const [oracle] = await pda([text('observation'), bs58.decode(pool)]);
  const [source] = await pda(
    [bs58.decode(payer), bs58.decode(TOKEN), bs58.decode(inputMint)],
    ATA,
  );
  const [destination] = await pda(
    [bs58.decode(payer), bs58.decode(TOKEN), bs58.decode(outputMint)],
    ATA,
  );
  const [inputVault] = await pda([
    text('pool_vault'),
    bs58.decode(pool),
    bs58.decode(inputMint),
  ]);
  const [outputVault] = await pda([
    text('pool_vault'),
    bs58.decode(pool),
    bs58.decode(outputMint),
  ]);
  const metas = [
    payer,
    authority,
    config,
    pool,
    source,
    destination,
    inputVault,
    outputVault,
    TOKEN,
    TOKEN,
    inputMint,
    outputMint,
    oracle,
  ].map((address, i) => ({
    address,
    signer: i === 0,
    writable: [0, 3, 4, 5, 6, 7, 12].includes(i),
  }));
  const writable = metas.filter((m) => m.writable).map((m) => m.address),
    readonly = [
      ...new Set(metas.filter((m) => !m.writable).map((m) => m.address)),
      CPMM,
    ],
    keys = [...writable, ...readonly];
  const data = Buffer.alloc(24);
  Buffer.from('8fbe5adac41e33de', 'hex').copy(data);
  data.writeBigUInt64LE(reverse ? 100000n : 1000000n, 8);
  data.writeBigUInt64LE(reverse ? 990000n : 99000n, 16);
  const wire = Buffer.from([
    1,
    ...new Uint8Array(64),
    128,
    1,
    0,
    readonly.length,
    keys.length,
    ...keys.flatMap((k) => Array.from(bs58.decode(k))),
    ...new Uint8Array(32),
    1,
    keys.indexOf(CPMM),
    13,
    ...metas.map((m) => keys.indexOf(m.address)),
    24,
    ...data,
    0,
  ]);
  const packet = {
    transaction: wire.toString('base64'),
    expected: {
      payer,
      inputMint,
      outputMint,
      inputRaw: reverse ? '100000' : '1000000',
      minimumOutputRaw: reverse ? '990000' : '99000',
    },
  };
  const raw = (
    b: Uint8Array,
    owner: string,
    lamports = BigInt((128 + b.length) * 6960),
  ) => ({
    owner,
    executable: false,
    lamports: lamports.toString(),
    data: [Buffer.from(b).toString('base64'), 'base64'],
  });
  const accounts = new Map<string, ReturnType<typeof raw>>();
  const mint = (decimals: number) => {
    const b = Buffer.alloc(82);
    b[44] = decimals;
    b[45] = 1;
    return raw(b, TOKEN);
  };
  accounts.set(WSOL, mint(9));
  accounts.set(USDC, mint(6));
  const rent = Buffer.alloc(17);
  rent.writeBigUInt64LE(3480n);
  rent.writeDoubleLE(2, 8);
  rent[16] = 50;
  accounts.set(RENT, raw(rent, SYSVAR, 1n));
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(102n);
  clock.writeBigInt64LE(BigInt(Math.floor(now / 1000)), 32);
  accounts.set(CLOCK, raw(clock, SYSVAR, 1n));
  const token = (mint: string, owner: string, amount: bigint) => {
    const b = Buffer.alloc(165);
    Buffer.from(bs58.decode(mint)).copy(b);
    Buffer.from(bs58.decode(owner)).copy(b, 32);
    b.writeBigUInt64LE(amount, 64);
    b[108] = 1;
    if (mint === WSOL) {
      b.writeUInt32LE(1, 109);
      b.writeBigUInt64LE(2039280n, 113);
    }
    return raw(b, TOKEN, 2039280n + (mint === WSOL ? amount : 0n));
  };
  accounts.set(source, token(inputMint, payer, 5000000n));
  accounts.set(destination, token(outputMint, payer, 500000n));
  accounts.set(
    inputVault,
    token(inputMint, authority, reverse ? 100000000000n : 1000000000000n),
  );
  accounts.set(
    outputVault,
    token(outputMint, authority, reverse ? 1000000000000n : 100000000000n),
  );
  const poolData = Buffer.alloc(637);
  Buffer.from('f7ede3f5d7c3de46', 'hex').copy(poolData);
  for (const [offset, key] of [
    [8, config],
    [72, reverse ? outputVault : inputVault],
    [104, reverse ? inputVault : outputVault],
    [168, WSOL],
    [200, USDC],
    [232, TOKEN],
    [264, TOKEN],
    [296, oracle],
  ] as const)
    Buffer.from(bs58.decode(key)).copy(poolData, offset);
  poolData[328] = bump;
  poolData[331] = 9;
  poolData[332] = 6;
  poolData.writeBigUInt64LE(BigInt(Math.floor(now / 1000) - 1), 373);
  accounts.set(pool, raw(poolData, CPMM));
  const configData = Buffer.alloc(236);
  Buffer.from('daf42168cbcb2b6f', 'hex').copy(configData);
  configData[8] = configBump;
  configData.writeUInt16LE(1, 10);
  configData.writeBigUInt64LE(2500n, 12);
  accounts.set(config, raw(configData, CPMM));
  const oracleData = Buffer.alloc(4075);
  Buffer.from('7aaec5358109a584', 'hex').copy(oracleData);
  Buffer.from(bs58.decode(pool)).copy(oracleData, 11);
  accounts.set(oracle, raw(oracleData, CPMM));
  const reads: { keys: string[]; floor: number }[] = [];
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    signal.throwIfAborted();
    expect(method).toBe('getMultipleAccounts');
    const selected = params[0] as string[],
      options = params[1] as {
        minContextSlot: number;
        commitment: string;
        encoding: string;
      };
    expect(options.commitment).toBe('confirmed');
    expect(options.encoding).toBe('base64');
    reads.push({ keys: selected.slice(), floor: options.minContextSlot });
    return {
      context: { slot: '102' },
      value: selected.map((k) => structuredClone(accounts.get(k) ?? null)),
    };
  };
  const selection = { inputPair: pub(20), outputPair: pub(21) };
  const observe = vi.fn(
    async ({ address }: { address: string }): Promise<TokenMarket> => ({
      chain: 'Solana',
      address,
      source: 'api.dexscreener.com',
      observedAt: new Date(now).toISOString(),
      executionAllowed: false,
      returnedPairCount: 1,
      quoteOnlyPairCount: 0,
      pairs: [
        {
          address:
            address === inputMint ? selection.inputPair : selection.outputPair,
          dex: 'reference',
          url: '',
          quoteSymbol: 'USD',
          priceUsd: address === WSOL ? '100' : '1',
          liquidityUsd: null,
          volume24hUsd: null,
          change24h: null,
          marketCapUsd: null,
        },
      ],
    }),
  );
  return {
    packet,
    rpc,
    reads,
    accounts,
    now,
    selection,
    observe,
    pool,
    source,
    config,
    oracle,
  };
}
it('composes real packet bytes, canonical PDAs, native rent, raw accounts and independent-price units', async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  const bound = await inspectJitoCpmmUnsignedPacket(f.packet);
  const pool = await readJitoCpmmPoolEvidence(f.packet, 100, f.rpc, signal);
  const prices = await readJitoCpmmPriceComparison(
    f.packet,
    f.selection,
    100,
    f.rpc,
    signal,
    { observe: f.observe, clock: () => f.now },
  );
  expect(pool.transactionSha256).toBe(bound.transactionSha256);
  expect(pool).toMatchObject({
    poolRelationshipsChecked: true,
    rentCoverageChecked: true,
    configOracleVaultPdasChecked: true,
    poolOpenAtObservedClock: true,
    bankVerified: false,
    signingAllowed: false,
  });
  expect(pool.coverage).toHaveLength(7);
  expect(pool.assets.after.mintRentCoverage).toHaveLength(2);
  expect(prices).toMatchObject({
    available: true,
    transactionSha256: bound.transactionSha256,
    minimumValueDifferenceBps: '-100',
    acknowledgementRequired: false,
    priceVerified: false,
    executionAllowed: false,
  });
  expect(f.reads).toHaveLength(5);
  expect(f.reads[2].keys).toHaveLength(8);
  expect(f.reads[2].floor).toBe(102);
});
it('refuses a real wrapped SOL account with insufficient token backing', async () => {
  const f = await fixture();
  f.accounts.get(f.source)!.lamports = '2039280';
  await expect(
    readJitoCpmmPoolEvidence(
      f.packet,
      100,
      f.rpc,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('binds every collector to the original encoded minimum and refuses a changed review', async () => {
  const f = await fixture();
  f.packet.expected.minimumOutputRaw = '99999';
  await expect(
    readJitoCpmmPoolEvidence(
      f.packet,
      100,
      f.rpc,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.reads).toHaveLength(0);
});
it('refuses a packet minimum that its own pool reserves and fees cannot deliver', async () => {
  const f = await fixture(),
    wire = Buffer.from(f.packet.transaction, 'base64');
  wire.writeBigUInt64LE(100000n, wire.length - 9);
  f.packet.transaction = wire.toString('base64');
  f.packet.expected.minimumOutputRaw = '100000';
  await expect(
    readJitoCpmmPoolEvidence(
      f.packet,
      100,
      f.rpc,
      new AbortController().signal,
    ),
  ).rejects.toThrow('constant-product');
});
it('refuses a source account that cannot cover the encoded input', async () => {
  const f = await fixture(),
    raw = f.accounts.get(f.source)!,
    bytes = Buffer.from(raw.data[0], 'base64');
  bytes.writeBigUInt64LE(999999n, 64);
  raw.data[0] = bytes.toString('base64');
  raw.lamports = (2039280n + 999999n).toString();
  await expect(
    readJitoCpmmPoolEvidence(
      f.packet,
      100,
      f.rpc,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it.each(
  [false, true].flatMap((reverse) =>
    [0, 1, 2].map((mode) => ({ reverse, mode })),
  ),
)(
  'handles current creator-fee mode $mode with reverse=$reverse',
  async ({ reverse, mode }) => {
    const f = await fixture(reverse),
      p = f.accounts.get(f.pool)!,
      c = f.accounts.get(f.config)!;
    const poolBytes = Buffer.from(p.data[0], 'base64');
    poolBytes[389] = mode;
    poolBytes[390] = 1;
    p.data[0] = poolBytes.toString('base64');
    const configBytes = Buffer.from(c.data[0], 'base64');
    configBytes.writeBigUInt64LE(1000n, 108);
    c.data[0] = configBytes.toString('base64');
    const result = await readJitoCpmmCurrentPoolEvidence(
      f.packet,
      100,
      f.rpc,
      new AbortController().signal,
    );
    const onInput =
      mode === 0 || (mode === 1 && !reverse) || (mode === 2 && reverse);
    expect(result).toMatchObject({
      format: 'jito-cpmm-current-pool-observation-v1',
      poolVerified: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(result.curve).toMatchObject({
      creatorFeeOnInput: onInput,
      creatorFeeRaw: onInput
        ? reverse
          ? '100'
          : '1000'
        : reverse
          ? '998'
          : '100',
    });
    await expect(
      readJitoCpmmPoolEvidence(
        f.packet,
        100,
        f.rpc,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
it('excludes current accrued creator fees from both reserve sides', async () => {
  const f = await fixture(),
    p = f.accounts.get(f.pool)!,
    b = Buffer.from(p.data[0], 'base64');
  b.writeBigUInt64LE(100000000000n, 397);
  b.writeBigUInt64LE(1000000000n, 405);
  p.data[0] = b.toString('base64');
  const r = await readJitoCpmmCurrentPoolEvidence(
    f.packet,
    100,
    f.rpc,
    new AbortController().signal,
  );
  expect(BigInt(r.curve.expectedOutputRaw) > 99749n).toBe(true);
});
it.each([
  [389, 3],
  [390, 2],
  [391, 1],
  [413, 1],
])(
  'refuses current-profile unknown pool bytes at %s',
  async (offset, value) => {
    const f = await fixture(),
      p = f.accounts.get(f.pool)!,
      b = Buffer.from(p.data[0], 'base64');
    b[offset] = value;
    p.data[0] = b.toString('base64');
    await expect(
      readJitoCpmmCurrentPoolEvidence(
        f.packet,
        100,
        f.rpc,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
it('refuses a future current oracle last-update timestamp', async () => {
  const f = await fixture(),
    o = f.accounts.get(f.oracle)!,
    b = Buffer.from(o.data[0], 'base64');
  b.writeBigUInt64LE(BigInt(Math.floor(f.now / 1000) + 60), 4043);
  o.data[0] = b.toString('base64');
  await expect(
    readJitoCpmmCurrentPoolEvidence(
      f.packet,
      100,
      f.rpc,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

it.each([false, true])(
  'binds real packet bytes to all four raw token transitions (reverse=%s)',
  async (reverse) => {
    const { inspectJitoCpmmPacketBalanceTransition } =
      await import('./jito-cpmm-unsigned-packet');
    const f = await fixture(reverse);
    const bound = await inspectJitoCpmmUnsignedPacket(f.packet);
    const before = [
      bound.source,
      bound.destination,
      bound.inputVault,
      bound.outputVault,
    ].map((address) => {
      const a = f.accounts.get(address)!;
      return {
        address,
        owner: a.owner,
        executable: a.executable,
        lamports: a.lamports,
        dataBase64: a.data[0],
      };
    });
    const after = structuredClone(before);
    const input = BigInt(bound.inputRaw),
      output = BigInt(bound.minimumOutputRaw);
    for (const [i, delta] of [
      [0, -input],
      [1, output],
      [2, input],
      [3, -output],
    ] as const) {
      const a = after[i],
        bytes = Buffer.from(a.dataBase64, 'base64');
      bytes.writeBigUInt64LE(bytes.readBigUInt64LE(64) + delta, 64);
      if (bytes.readUInt32LE(109) === 1)
        a.lamports = (BigInt(a.lamports) + delta).toString();
      a.dataBase64 = bytes.toString('base64');
    }
    const request = { packet: f.packet, before, after };
    expect(await inspectJitoCpmmPacketBalanceTransition(request)).toMatchObject(
      {
        transactionSha256: bound.transactionSha256,
        inputRaw: input.toString(),
        outputRaw: output.toString(),
        instructionBoundToPacket: true,
        bankVerified: false,
        economicOutputVerified: false,
        signingAllowed: false,
      },
    );
    const swapped = structuredClone(request);
    swapped.before.reverse();
    await expect(
      inspectJitoCpmmPacketBalanceTransition(swapped),
    ).rejects.toThrow();
    const changed = structuredClone(request);
    changed.packet.expected.inputRaw = (input + 1n).toString();
    await expect(
      inspectJitoCpmmPacketBalanceTransition(changed),
    ).rejects.toThrow();
    const injected = { ...request, instruction: {} };
    await expect(
      inspectJitoCpmmPacketBalanceTransition(injected),
    ).rejects.toThrow();
    const pending = inspectJitoCpmmPacketBalanceTransition(request);
    request.after[1].dataBase64 = '';
    expect(await pending).toMatchObject({ outputRaw: output.toString() });
    await expect(
      inspectJitoCpmmPacketBalanceTransition(request),
    ).rejects.toThrow();
  },
);

it.each([
  {
    reverse: false,
    initialized: false,
    index: 0,
    elapsed: 0,
    legacy: false,
    wrap: false,
  },
  {
    reverse: true,
    initialized: false,
    index: 99,
    elapsed: 0,
    legacy: false,
    wrap: false,
  },
  {
    reverse: false,
    initialized: true,
    index: 3,
    elapsed: 0,
    legacy: false,
    wrap: false,
  },
  {
    reverse: true,
    initialized: true,
    index: 3,
    elapsed: 14,
    legacy: true,
    wrap: false,
  },
  {
    reverse: false,
    initialized: true,
    index: 3,
    elapsed: 15,
    legacy: false,
    wrap: false,
  },
  {
    reverse: true,
    initialized: true,
    index: 99,
    elapsed: 23,
    legacy: false,
    wrap: true,
  },
])(
  'replays pool fees, epoch, rent and oracle bytes for $reverse/$initialized/$index/$elapsed',
  async (scenario) => {
    const { replayJitoCpmmSwapState } =
      await import('./jito-cpmm-state-replay');
    const f = await fixture(scenario.reverse),
      signal = new AbortController().signal;
    const bound = await inspectJitoCpmmUnsignedPacket(f.packet);
    const mutate = (
      key: string,
      action: (b: ReturnType<typeof Buffer.from>) => void,
    ) => {
      const a = f.accounts.get(key)!,
        b = Buffer.from(a.data[0], 'base64');
      action(b);
      a.data[0] = b.toString('base64');
    };
    mutate(f.pool, (b) => {
      b[390] = 1;
      b[389] = scenario.reverse ? 1 : 0;
    });
    mutate(f.config, (b) => {
      b.writeBigUInt64LE(500n, 108);
      b.writeBigUInt64LE(100000n, 20);
      b.writeBigUInt64LE(200000n, 28);
    });
    const timestamp = BigInt(Math.floor(f.now / 1000)),
      offset = 43 + scenario.index * 40;
    const initial0 = scenario.wrap ? (1n << 128n) - 2n : 100n,
      initial1 = 200n;
    const put128 = (
      b: ReturnType<typeof Buffer.from>,
      o: number,
      n: bigint,
    ) => {
      b.writeBigUInt64LE(n & ((1n << 64n) - 1n), o);
      b.writeBigUInt64LE(n >> 64n, o + 8);
    };
    mutate(f.oracle, (b) => {
      b[8] = Number(scenario.initialized);
      b.writeUInt16LE(scenario.index, 9);
      b.writeBigUInt64LE(timestamp - BigInt(scenario.elapsed), offset);
      put128(b, offset + 8, initial0);
      put128(b, offset + 24, initial1);
      b.writeBigUInt64LE(
        scenario.legacy ? 0n : timestamp - BigInt(scenario.elapsed),
        4043,
      );
    });
    const quote = (
      await readJitoCpmmCurrentPoolEvidence(f.packet, 100, f.rpc, signal)
    ).curve;
    if (!('creatorFeeRaw' in quote)) throw Error('current quote required');
    const before = [...f.accounts].map(([address, a]) => ({
      address,
      owner: a.owner,
      executable: a.executable,
      lamports: a.lamports,
      dataBase64: a.data[0],
    }));
    const after = structuredClone(before),
      byKey = new Map(after.map((a) => [a.address, a]));
    for (const [key, delta] of [
      [bound.source, -BigInt(quote.inputRaw)],
      [bound.destination, BigInt(quote.expectedOutputRaw)],
      [bound.inputVault, BigInt(quote.inputRaw)],
      [bound.outputVault, -BigInt(quote.expectedOutputRaw)],
    ] as const) {
      const a = byKey.get(key)!,
        b = Buffer.from(a.dataBase64, 'base64');
      b.writeBigUInt64LE(b.readBigUInt64LE(64) + delta, 64);
      if (b.readUInt32LE(109) === 1)
        a.lamports = (BigInt(a.lamports) + delta).toString();
      a.dataBase64 = b.toString('base64');
    }
    const p = byKey.get(f.pool)!,
      pb = Buffer.from(p.dataBase64, 'base64'),
      protocol = scenario.reverse ? 349 : 341;
    pb.writeBigUInt64LE(BigInt(quote.protocolFeeRaw), protocol);
    pb.writeBigUInt64LE(BigInt(quote.fundFeeRaw), protocol + 16);
    // Both scenarios charge creator fees in token0, on input forward and output reverse.
    pb.writeBigUInt64LE(BigInt(quote.creatorFeeRaw), 397);
    pb.writeBigUInt64LE(
      Buffer.from(f.accounts.get(CLOCK)!.data[0], 'base64').readBigUInt64LE(16),
      381,
    );
    p.dataBase64 = pb.toString('base64');
    const o = byKey.get(f.oracle)!,
      ob = Buffer.from(o.dataBase64, 'base64');
    if (!scenario.initialized) {
      ob[8] = 1;
      ob.writeBigUInt64LE(timestamp, offset);
      put128(ob, offset + 8, 0n);
      put128(ob, offset + 24, 0n);
      ob.writeBigUInt64LE(timestamp, 4043);
    } else {
      if (scenario.legacy)
        ob.writeBigUInt64LE(timestamp - BigInt(scenario.elapsed), 4043);
      if (scenario.elapsed) {
        const next =
            scenario.elapsed < 15 ? scenario.index : (scenario.index + 1) % 100,
          target = 43 + next * 40;
        if (next !== scenario.index) {
          ob.writeUInt16LE(next, 9);
          ob.writeBigUInt64LE(timestamp, target);
        }
        put128(
          ob,
          target + 8,
          (initial0 + 429496729n * BigInt(scenario.elapsed)) &
            ((1n << 128n) - 1n),
        );
        put128(
          ob,
          target + 24,
          (initial1 + 42949672960n * BigInt(scenario.elapsed)) &
            ((1n << 128n) - 1n),
        );
        ob.writeBigUInt64LE(timestamp, 4043);
      }
    }
    o.dataBase64 = ob.toString('base64');
    const request = {
      packet: f.packet,
      minimumSlot: 100,
      slot: 102,
      before,
      after,
    };
    expect(await replayJitoCpmmSwapState(request, signal)).toMatchObject({
      poolTransitionChecked: true,
      oracleTransitionChecked: true,
      rentCoverageChecked: true,
      outputRaw: quote.expectedOutputRaw,
      bankVerified: false,
      signingAllowed: false,
    });
    for (const [key, offset] of [
      [f.pool, 333],
      [f.pool, protocol],
      [f.pool, 381],
      [f.oracle, 43],
      [f.oracle, 4043],
      [f.config, 12],
      [bound.inputMint, 44],
      [RENT, 0],
      [CLOCK, 0],
    ] as const) {
      const bad = structuredClone(request),
        a = bad.after.find((a) => a.address === key)!,
        b = Buffer.from(a.dataBase64, 'base64');
      b[offset] ^= 1;
      a.dataBase64 = b.toString('base64');
      await expect(replayJitoCpmmSwapState(bad, signal)).rejects.toThrow();
    }
    const rentLoss = structuredClone(request);
    rentLoss.after.find((a) => a.address === f.pool)!.lamports = '0';
    await expect(replayJitoCpmmSwapState(rentLoss, signal)).rejects.toThrow();
  },
);
