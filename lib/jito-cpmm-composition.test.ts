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
import { JITO_TIP_PAYMENT_OWNER } from './jito-tip-account-evidence';
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RENT = 'SysvarRent111111111111111111111111111111111';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR = 'Sysvar1111111111111111111111111111111111111';
const pub = (i: number) => bs58.encode(new Uint8Array(32).fill(i));
async function fixture(reverse = false, payerByte = 1) {
  const now = Date.now(),
    payer = pub(payerByte),
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

async function bundleFixture(
  reverse = false,
  count = 1,
  distinctWallets = false,
  emptyFirstDestination = false,
) {
  const kit = await import('@solana/kit');
  const { PUMP_GROUP_JITO_TIP_ACCOUNTS } =
    await import('./pump-group-broadcast');
  const f = await fixture(reverse),
    bound = await inspectJitoCpmmUnsignedPacket(f.packet);
  if (emptyFirstDestination) {
    const account = f.accounts.get(bound.destination)!;
    const data = Buffer.from(account.data[0], 'base64');
    const amount = data.readBigUInt64LE(64);
    data.writeBigUInt64LE(0n, 64);
    if (bound.outputMint === WSOL)
      account.lamports = (BigInt(account.lamports) - amount).toString();
    account.data[0] = data.toString('base64');
  }
  const system = '11111111111111111111111111111111',
    recipient = PUMP_GROUP_JITO_TIP_ACCOUNTS[0];
  const ordinary = (lamports: string) => ({
    owner: system,
    executable: false,
    lamports,
    data: ['', 'base64'],
  });
  const executable = (key = system) => ({
    owner:
      key === system
        ? 'NativeLoader1111111111111111111111111111111'
        : 'BPFLoaderUpgradeab1e11111111111111111111111',
    executable: true,
    lamports: '1',
    data: [
      key === system
        ? Buffer.from('solana_system_program').toString('base64')
        : Buffer.concat([
            Buffer.from([2, 0, 0, 0]),
            Buffer.from(
              bs58.decode(
                key === CPMM
                  ? 'DMawCQzbgNTmbzaESc7o6pvL1KAeetY8zA7jNpzntHhU'
                  : '3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2',
              ),
            ),
          ]).toString('base64'),
      'base64',
    ],
  });
  const swaps = [],
    packets = [],
    transactionResults = [];
  let payerLamports = 10000000n;
  const balances = new Map<string, bigint>();
  for (let i = 0; i < count; i++) {
    const template = distinctWallets && i ? await fixture(reverse, i + 1) : f;
    const bound = await inspectJitoCpmmUnsignedPacket(template.packet);
    if (distinctWallets && i)
      for (const key of [bound.source, bound.destination])
        f.accounts.set(key, structuredClone(template.accounts.get(key)!));
    payerLamports = balances.get(bound.payer) ?? 10000000n;
    const originalTx = kit
      .getTransactionDecoder()
      .decode(Buffer.from(template.packet.transaction, 'base64'));
    const originalMessage = kit
      .getCompiledTransactionMessageDecoder()
      .decode(originalTx.messageBytes);
    if (originalMessage.version !== 0) throw Error('Fixture needs v0');
    const inputRaw = (BigInt(bound.inputRaw) + BigInt(i)).toString();
    const data = Buffer.from(originalMessage.instructions[0].data!);
    data.writeBigUInt64LE(BigInt(inputRaw), 8);
    const messageBytes = kit.getCompiledTransactionMessageEncoder().encode({
      ...originalMessage,
      instructions: [{ ...originalMessage.instructions[0], data }],
    });
    const transaction = Buffer.from(
      kit.getTransactionEncoder().encode({
        ...originalTx,
        messageBytes: messageBytes as typeof originalTx.messageBytes,
      }),
    ).toString('base64');
    const swap = {
      transaction,
      expected: { ...template.packet.expected, inputRaw },
    };
    const quote = (
      await readJitoCpmmCurrentPoolEvidence(
        swap,
        100,
        f.rpc,
        new AbortController().signal,
      )
    ).curve;
    const keys = originalMessage.staticAccounts.map(String);
    const read = (key: string) =>
      key === bound.payer
        ? ordinary(payerLamports.toString())
        : key === CPMM || key === TOKEN
          ? executable(key)
          : structuredClone(f.accounts.get(key) ?? null);
    const preExecutionAccounts = keys.map(read);
    for (const [key, delta] of [
      [bound.source, -BigInt(inputRaw)],
      [bound.destination, BigInt(quote.expectedOutputRaw)],
      [bound.inputVault, BigInt(inputRaw)],
      [bound.outputVault, -BigInt(quote.expectedOutputRaw)],
    ] as const) {
      const a = f.accounts.get(key)!,
        b = Buffer.from(a.data[0], 'base64');
      b.writeBigUInt64LE(b.readBigUInt64LE(64) + delta, 64);
      if (b.readUInt32LE(109) === 1)
        a.lamports = (BigInt(a.lamports) + delta).toString();
      a.data[0] = b.toString('base64');
    }
    const o = f.accounts.get(f.oracle)!,
      ob = Buffer.from(o.data[0], 'base64');
    if (!ob[8]) {
      ob[8] = 1;
      const timestamp = BigInt(Math.floor(f.now / 1000));
      ob.writeBigUInt64LE(timestamp, 43);
      ob.writeBigUInt64LE(timestamp, 4043);
      o.data[0] = ob.toString('base64');
    }
    payerLamports -= 5000n;
    balances.set(bound.payer, payerLamports);
    transactionResults.push({
      err: null,
      preExecutionAccounts,
      postExecutionAccounts: keys.map(read),
      fee: '5000',
      unitsConsumed: 1000,
      loadedAccountsDataSize: '10000',
    });
    swaps.push(swap);
    packets.push({
      transaction,
      loadedAddresses: null,
      maximumFeeLamports: '10000',
      expectedFeeLamports: '5000',
    });
  }
  payerLamports = balances.get(bound.payer)!;
  const transfer = Buffer.alloc(12);
  transfer.writeUInt32LE(2);
  transfer.writeBigUInt64LE(1000n, 4);
  const wire = Buffer.from([
    1,
    ...new Uint8Array(64),
    128,
    1,
    0,
    1,
    3,
    ...[bound.payer, recipient, system].flatMap((k) =>
      Array.from(bs58.decode(k)),
    ),
    ...bs58.decode(bound.blockhash),
    1,
    2,
    2,
    0,
    1,
    12,
    ...transfer,
    0,
  ]);
  const transaction = wire.toString('base64');
  packets.push({
    transaction,
    loadedAddresses: null,
    maximumFeeLamports: '10000',
    expectedFeeLamports: '5000',
  });
  transactionResults.push({
    err: null,
    preExecutionAccounts: [
      ordinary(payerLamports.toString()),
      {
        ...ordinary('1000000'),
        owner: JITO_TIP_PAYMENT_OWNER,
        data: ['ySH0dOBEYSg=', 'base64'],
      },
      executable(),
    ],
    postExecutionAccounts: [
      ordinary((payerLamports - 6000n).toString()),
      {
        ...ordinary('1001000'),
        owner: JITO_TIP_PAYMENT_OWNER,
        data: ['ySH0dOBEYSg=', 'base64'],
      },
      executable(),
    ],
    fee: '5000',
    unitsConsumed: 100,
    loadedAccountsDataSize: '0',
  });
  const extra = [CLOCK, RENT].map((address) => {
    const a = f.accounts.get(address)!;
    return {
      address,
      owner: a.owner,
      executable: a.executable,
      lamports: a.lamports,
      dataBase64: a.data[0],
    };
  });
  return {
    swaps,
    tip: { transaction, recipient, amountRaw: '1000' },
    walletReserves: [...balances.keys()].map((wallet) => ({
      wallet,
      reserveLamports: '1000000',
    })),
    packets,
    minimumSlot: 100,
    simulationBankSlot: 102,
    result: {
      context: { slot: 102 },
      value: { summary: 'succeeded', transactionResults },
    },
    bankAccounts: { slot: 102, before: extra, after: structuredClone(extra) },
  };
}

it.each([
  { reverse: false, count: 1 },
  { reverse: true, count: 1 },
  { reverse: false, count: 4 },
  { reverse: true, count: 4 },
])(
  'replays $count direct swaps and exact tip as complete sequential frames (reverse=$reverse)',
  async ({ reverse, count }) => {
    const { replayJitoCpmmBundleSettlement } =
      await import('./jito-cpmm-bundle-replay');
    const request = await bundleFixture(reverse, count);
    const proof = await replayJitoCpmmBundleSettlement(
      request,
      new AbortController().signal,
    );
    expect(proof).toMatchObject({
      feeTipSettlementChecked: true,
      crossFrameContinuityChecked: true,
      fullAccountVectorsChecked: true,
      feeBankVerified: false,
      bankVerified: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(proof.swaps).toHaveLength(count);
    expect(proof.transactionSha256s).toHaveLength(count + 1);
    expect(proof.walletBalances[0]).toMatchObject({
      initialLamports: '10000000',
      finalLamports: String(10000000 - (count + 1) * 5000 - 1000),
      networkFeeLamports: String((count + 1) * 5000),
      tipLamports: '1000',
      reserveLamports: '1000000',
    });
  },
);

it('refuses changed direct bundle fees, accounts, tip consent, reserve, bank, message and continuity', async () => {
  const { replayJitoCpmmBundleSettlement } =
    await import('./jito-cpmm-bundle-replay');
  const original = await bundleFixture();
  const cases: ((r: typeof original) => void)[] = [
    (r) => {
      r.tip.amountRaw = '1001';
    },
    (r) => {
      r.tip.recipient = pub(90) as typeof r.tip.recipient;
    },
    (r) => {
      r.walletReserves[0].reserveLamports = '10000000';
    },
    (r) => {
      r.packets[0].expectedFeeLamports = '5001';
    },
    (r) => {
      r.packets[0].maximumFeeLamports = '4999';
    },
    (r) => {
      r.result.value.transactionResults[0].fee = '5001';
    },
    (r) => {
      r.result.value.transactionResults[1].preExecutionAccounts[0]!.lamports =
        '9994999';
    },
    (r) => {
      r.result.value.transactionResults[1].postExecutionAccounts[1]!.lamports =
        '51001';
    },
    (r) => {
      r.result.value.transactionResults[0].postExecutionAccounts.pop();
    },
    (r) => {
      r.bankAccounts.slot = 103;
    },
    (r) => {
      r.simulationBankSlot = 103;
    },
    (r) => {
      r.minimumSlot = 69;
    },
    (r) => {
      r.swaps[0].expected.inputRaw = '1000001';
    },
    (r) => {
      r.tip.transaction = r.swaps[0].transaction;
    },
    (r) => {
      r.bankAccounts.after[0].dataBase64 = '';
    },
    (r) => {
      r.bankAccounts.before.reverse();
    },
    (r) => {
      r.result.value.summary = 'failed';
    },
  ];
  for (const mutate of cases) {
    const request = structuredClone(original);
    mutate(request);
    await expect(
      replayJitoCpmmBundleSettlement(request, new AbortController().signal),
    ).rejects.toThrow();
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    replayJitoCpmmBundleSettlement(original, cancelled.signal),
  ).rejects.toThrow();
  const pending = replayJitoCpmmBundleSettlement(
    original,
    new AbortController().signal,
  );
  original.tip.amountRaw = '9999999';
  expect(await pending).toMatchObject({ tipLamports: '1000' });
});

it.each([false, true])(
  'checks four distinct payers and a shared pool sequentially (reverse=%s)',
  async (reverse) => {
    const { replayJitoCpmmBundleSettlement } =
      await import('./jito-cpmm-bundle-replay');
    const request = await bundleFixture(reverse, 4, true);
    const proof = await replayJitoCpmmBundleSettlement(
      request,
      new AbortController().signal,
    );
    expect(proof.walletBalances).toHaveLength(4);
    expect(proof.walletBalances.map((w) => w.networkFeeLamports)).toEqual([
      '10000',
      '5000',
      '5000',
      '5000',
    ]);
    expect(proof.walletBalances.map((w) => w.tipLamports)).toEqual([
      '1000',
      '0',
      '0',
      '0',
    ]);
    const missing = structuredClone(request);
    missing.walletReserves.pop();
    await expect(
      replayJitoCpmmBundleSettlement(missing, new AbortController().signal),
    ).rejects.toThrow();
    const funding = structuredClone(request);
    funding.walletReserves[3].reserveLamports = '9996000';
    await expect(
      replayJitoCpmmBundleSettlement(funding, new AbortController().signal),
    ).rejects.toThrow();
  },
);

it('refuses a signed, differently-lived or non-transfer tip even with balanced frame accounts', async () => {
  const { replayJitoCpmmBundleSettlement } =
    await import('./jito-cpmm-bundle-replay');
  const original = await bundleFixture();
  const mutations = [
    (b: ReturnType<typeof Buffer.from>) => {
      b[1] = 1;
    },
    (b: ReturnType<typeof Buffer.from>) => {
      b[166] ^= 1;
    },
    (b: ReturnType<typeof Buffer.from>) => {
      b[b.length - 13] = 3;
    },
  ];
  for (const mutate of mutations) {
    const request = structuredClone(original),
      bytes = Buffer.from(request.tip.transaction, 'base64');
    mutate(bytes);
    request.tip.transaction = bytes.toString('base64');
    request.packets.at(-1)!.transaction = request.tip.transaction;
    await expect(
      replayJitoCpmmBundleSettlement(request, new AbortController().signal),
    ).rejects.toThrow();
  }
  const alien = structuredClone(original);
  for (const accounts of [
    alien.result.value.transactionResults.at(-1)!.preExecutionAccounts,
    alien.result.value.transactionResults.at(-1)!.postExecutionAccounts,
  ])
    accounts[1]!.owner = TOKEN;
  await expect(
    replayJitoCpmmBundleSettlement(alien, new AbortController().signal),
  ).rejects.toThrow();
});

it('uses actual Rent bytes for the payer and eight-byte tip receiver even with a zero declared reserve', async () => {
  const { replayJitoCpmmBundleSettlement } =
    await import('./jito-cpmm-bundle-replay');
  const request = await bundleFixture();
  request.walletReserves[0].reserveLamports = '0';
  const exactTip = request.result.value.transactionResults.at(-1)!;
  exactTip.preExecutionAccounts[1]!.lamports = '946560';
  exactTip.postExecutionAccounts[1]!.lamports = '947560';
  // Two 5,000-lamport fees plus a 1,000-lamport tip, leaving exactly the
  // 890,880-lamport minimum derived from this fixture's actual Rent account.
  const shift = 10000000n - (890880n + 11000n);
  for (const f of request.result.value.transactionResults)
    for (const accounts of [f.preExecutionAccounts, f.postExecutionAccounts])
      accounts[0]!.lamports = (
        BigInt(accounts[0]!.lamports) - shift
      ).toString();
  expect(
    (
      await replayJitoCpmmBundleSettlement(
        request,
        new AbortController().signal,
      )
    ).walletBalances[0],
  ).toMatchObject({
    finalLamports: '890880',
    requiredSystemRentLamports: '890880',
  });
  const below = structuredClone(request);
  for (const f of below.result.value.transactionResults)
    for (const accounts of [f.preExecutionAccounts, f.postExecutionAccounts])
      accounts[0]!.lamports = (BigInt(accounts[0]!.lamports) - 1n).toString();
  await expect(
    replayJitoCpmmBundleSettlement(below, new AbortController().signal),
  ).rejects.toThrow();
  const recipient = structuredClone(request),
    last = recipient.result.value.transactionResults.at(-1)!;
  last.preExecutionAccounts[1]!.lamports = '946559';
  last.postExecutionAccounts[1]!.lamports = '947559';
  await expect(
    replayJitoCpmmBundleSettlement(recipient, new AbortController().signal),
  ).rejects.toThrow();
});

it('rejects a synthetic empty System tip receiver that the old replay accepted', async () => {
  const { replayJitoCpmmBundleSettlement } =
    await import('./jito-cpmm-bundle-replay');
  const request = await bundleFixture();
  const last = request.result.value.transactionResults.at(-1)!;
  for (const vector of [
    last.preExecutionAccounts,
    last.postExecutionAccounts,
  ]) {
    vector[1]!.owner = '11111111111111111111111111111111';
    vector[1]!.data = ['', 'base64'];
  }
  await expect(
    replayJitoCpmmBundleSettlement(request, new AbortController().signal),
  ).rejects.toThrow();
});

async function setupBundleFixture(
  reverse = false,
  count = 1,
  distinctWallets = false,
) {
  const base = await bundleFixture(reverse, count, distinctWallets, true);
  const kit = await import('@solana/kit');
  const sdk = await import('@solana-program/token');
  const bound = await inspectJitoCpmmUnsignedPacket(base.swaps[0]);
  const payer = kit.createNoopSigner(address(bound.payer));
  const message = kit.compileTransactionMessage(
    kit.appendTransactionMessageInstructions(
      [
        sdk.getCreateAssociatedTokenIdempotentInstruction({
          payer,
          ata: address(bound.destination),
          owner: payer.address,
          mint: address(bound.outputMint),
        }),
      ],
      kit.setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: kit.blockhash(bound.blockhash),
          lastValidBlockHeight: 999n,
        },
        kit.setTransactionMessageFeePayer(
          payer.address,
          kit.createTransactionMessage({ version: 0 }),
        ),
      ),
    ),
  );
  const messageBytes = kit
    .getCompiledTransactionMessageEncoder()
    .encode(message) as import('@solana/kit').TransactionMessageBytes;
  const transaction = Buffer.from(
    kit.getTransactionEncoder().encode({
      messageBytes,
      signatures: Object.fromEntries([[payer.address, null]]),
    }),
  ).toString('base64');
  const firstMessage = kit
    .getCompiledTransactionMessageDecoder()
    .decode(
      kit
        .getTransactionDecoder()
        .decode(Buffer.from(base.swaps[0].transaction, 'base64')).messageBytes,
    );
  const firstKeys = firstMessage.staticAccounts.map(String);
  const first = base.result.value.transactionResults[0];
  type Raw = NonNullable<(typeof first.preExecutionAccounts)[number]>;
  const source = (key: string): Raw => {
    if (key === '11111111111111111111111111111111') {
      const account =
        base.result.value.transactionResults.at(-1)!.preExecutionAccounts[2];
      if (!account) throw Error('Fixture System account missing');
      return structuredClone(account);
    }
    if (key === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
      return {
        owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
        executable: true,
        lamports: '1',
        data: [
          Buffer.concat([
            Buffer.from([2, 0, 0, 0]),
            Buffer.from(bs58.decode(pub(77))),
          ]).toString('base64'),
          'base64',
        ],
      };
    const account = first.preExecutionAccounts[firstKeys.indexOf(key)];
    if (!account) throw Error('Fixture setup account missing');
    return structuredClone(account);
  };
  const keys = message.staticAccounts.map(String);
  const post = keys.map(source);
  const pre: (Raw | null)[] = structuredClone(post);
  pre[1] = null;
  const rent = BigInt(post[1].lamports);
  pre[0]!.lamports = (BigInt(post[0].lamports) + rent + 5000n).toString();
  const prefix = {
    err: null,
    preExecutionAccounts: pre,
    postExecutionAccounts: post,
    fee: '5000',
    unitsConsumed: 25000,
    loadedAccountsDataSize: '0',
  };
  const frames = [prefix, ...base.result.value.transactionResults];
  return {
    setup: {
      transaction,
      expected: {
        payer: bound.payer,
        mint: bound.outputMint,
        destination: bound.destination,
        blockhash: bound.blockhash,
      },
    },
    bundle: {
      ...base,
      packets: [
        {
          transaction,
          loadedAddresses: null,
          maximumFeeLamports: '10000',
          expectedFeeLamports: '5000',
        },
        ...base.packets,
      ],
      result: {
        ...base.result,
        value: { ...base.result.value, transactionResults: frames },
      },
    },
  };
}

it.each([
  { reverse: false, count: 1, distinct: false },
  { reverse: true, count: 3, distinct: false },
  { reverse: false, count: 3, distinct: true },
])(
  'checks every setup/swap/tip frame and original invariants for %j',
  async (options) => {
    const { replayJitoCpmmSetupBundle } =
      await import('./jito-cpmm-setup-bundle-replay');
    const f = await setupBundleFixture(
      options.reverse,
      options.count,
      options.distinct,
    );
    const proof = await replayJitoCpmmSetupBundle(
      f,
      new AbortController().signal,
    );
    expect(proof).toMatchObject({
      setupFrameChecked: true,
      allSuppliedFramesChecked: true,
      sourceAuthenticated: false,
      bankVerified: false,
      signingAllowed: false,
      setup: {
        createdRentLamports: '2039280',
        emptyCanonicalAccountChecked: true,
      },
    });
    expect(proof.transactionSha256s).toHaveLength(options.count + 2);
    expect(
      BigInt(proof.walletBalances[0].initialLamports) -
        BigInt(proof.walletBalances[0].finalLamports),
    ).toBe(
      2039280n + BigInt(proof.walletBalances[0].networkFeeLamports) + 1000n,
    );
  },
);

it('keeps five-packet capacity, continuity, exact fees, setup context and full readonly vectors', async () => {
  const { replayJitoCpmmSetupBundle } =
    await import('./jito-cpmm-setup-bundle-replay');
  await expect(
    replayJitoCpmmSetupBundle(
      await setupBundleFixture(false, 4),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const original = await setupBundleFixture();
  for (const kind of [
    'continuity',
    'payer',
    'mint',
    'hash',
    'fee',
    'readonly',
    'missing',
    'reserve',
  ]) {
    const f = structuredClone(original);
    if (kind === 'continuity')
      f.bundle.result.value.transactionResults[1].preExecutionAccounts[0]!.lamports =
        '10000001';
    if (kind === 'payer') f.setup.expected.payer = pub(90);
    if (kind === 'mint') f.setup.expected.mint = WSOL;
    if (kind === 'hash') f.setup.expected.blockhash = pub(90);
    if (kind === 'fee')
      f.bundle.result.value.transactionResults[0].fee = '5001';
    if (kind === 'readonly')
      f.bundle.result.value.transactionResults[0].postExecutionAccounts[2]!.lamports =
        '0';
    if (kind === 'missing')
      f.bundle.result.value.transactionResults[0].postExecutionAccounts.pop();
    if (kind === 'reserve')
      f.bundle.walletReserves[0].reserveLamports = '999999999';
    await expect(
      replayJitoCpmmSetupBundle(f, new AbortController().signal),
    ).rejects.toThrow();
  }
});

it('composes immutable owned code and lifetime captures with real packet/frame replay on one reader', async () => {
  const identityModule = await import('./pump-group-code-identity');
  const { CPMM_MATCHED_SOURCE_IDENTITY } =
    await import('./jito-cpmm-source-identity');
  const { PAIR_TRUSTED_PROGRAMS } = await import('./pair-trusted-programs');
  const { SOLANA_MAINNET_GENESIS } = await import('./wallet-balances');
  const { collectJitoCpmmResearchRuntimeEvidence } =
    await import('./jito-runtime-evidence');
  const { captureJitoCpmmLifetime } = await import('./jito-cpmm-lifetime');
  const { verifyJitoCpmmOwnedResearchBracket } =
    await import('./jito-cpmm-owned-research-bracket');
  const { verifyJitoBundleSimulationFrames } =
    await import('./jito-bundle-simulation-frames');
  const request = await bundleFixture();
  const frames = await verifyJitoBundleSimulationFrames({
    packets: request.packets,
    minimumSlot: request.minimumSlot,
    simulationBankSlot: request.simulationBankSlot,
    result: request.result,
  });
  const keys = [...new Set(frames.frames.flatMap((f) => f.keys))];
  const initial = new Map<
    string,
    (typeof frames.frames)[0]['preAccounts'][number]
  >();
  for (const f of frames.frames)
    f.keys.forEach((k, i) => {
      if (!initial.has(k)) initial.set(k, f.preAccounts[i]);
    });
  for (const a of request.bankAccounts.before)
    initial.set(a.address, {
      owner: a.owner,
      lamports: a.lamports,
      executable: a.executable,
      data: Buffer.from(a.dataBase64, 'base64'),
    });
  // The scanner alone is mocked: this test checks owned capture composition,
  // not full binary hashing. The real two-scan probe covers that separately.
  const scanner = vi
    .spyOn(identityModule, 'collectPumpProgramIdentities')
    .mockImplementation(async () => {
      const standard = [...initial]
        .filter(
          ([k]) => k === TOKEN || k === '11111111111111111111111111111111',
        )
        .map(([address, a]) => {
          const p = PAIR_TRUSTED_PROGRAMS.find((p) => p.address === address)!;
          return {
            address,
            loader: p.loader,
            identityKind:
              address === TOKEN
                ? ('elf-code' as const)
                : ('native-system' as const),
            programData:
              address === TOKEN
                ? '3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2'
                : null,
            deploymentSlot: address === TOKEN ? '419472000' : null,
            upgradeAuthority: p.upgradeAuthority,
            codeSha256: p.codeSha256[0],
            codeBytes: a!.data.length === 21 ? 21 : 108600,
          };
        });
      return {
        format: 'pump-program-code-identities-v1',
        network: 'mainnet',
        minimumSlot: 100,
        maximumSlot: 103,
        programs: [...standard, { ...CPMM_MATCHED_SOURCE_IDENTITY }],
        reads: 1,
        totalCodeBytes: 902445,
        observedAt: new Date().toISOString(),
        codeIdentityVerified: true,
        semanticAuditEstablished: false,
        signingAllowed: false,
        executionAllowed: false,
      };
    });
  let at = 100,
    valid = true;
  let onHeight: () => void = () => {};
  type FreshAccount = {
    owner: string;
    lamports: string;
    executable: boolean;
    data: string[];
  } | null;
  let mutateFresh: (
    keys: string[],
    response: { context: { slot: string }; value: FreshAccount[] },
  ) => void = () => {};
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: PumpLaunchRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getLatestBlockhash')
      return {
        context: { slot: String(at) },
        value: {
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: '900',
        },
      };
    if (method === 'isBlockhashValid')
      return { context: { slot: '104' }, value: valid };
    if (method === 'getBlockHeight') {
      onHeight();
      return '890';
    }
    if (method !== 'getMultipleAccounts') throw Error('unexpected method');
    const slice = (
      params[1] as { dataSlice?: { offset: number; length: number } }
    ).dataSlice;
    const selected = params[0] as string[];
    const response = {
      context: { slot: String(at) },
      value: selected.map((k) => {
        const a = initial.get(k);
        const bytes = a ? Buffer.from(a.data) : null;
        if (bytes && k === CLOCK && !slice) bytes.writeBigUInt64LE(BigInt(at));
        return a
          ? {
              owner: a.owner,
              lamports: a.lamports,
              executable: a.executable,
              data: [
                (slice
                  ? bytes!.subarray(slice.offset, slice.offset + slice.length)
                  : bytes!
                ).toString('base64'),
                'base64',
              ],
            }
          : null;
      }),
    };
    if (!slice) mutateFresh(selected, response);
    return response;
  };
  try {
    const signal = new AbortController().signal,
      lifetime = await captureJitoCpmmLifetime(100, rpc, signal);
    at = 101;
    const before = await collectJitoCpmmResearchRuntimeEvidence(
      keys,
      100,
      100,
      signal,
      rpc,
    );
    at = 103;
    const after = await collectJitoCpmmResearchRuntimeEvidence(
      keys,
      100,
      102,
      signal,
      rpc,
    );
    const proof = await verifyJitoCpmmOwnedResearchBracket(
      request,
      lifetime,
      before,
      after,
      rpc,
      signal,
    );
    expect(proof).toMatchObject({
      originalMinimumSlot: 100,
      maximumObservedContextSlot: 104,
      sameRpcDependencyChecked: true,
      ownedCapturesChecked: true,
      transportRequestBound: false,
      liveSimulationVerified: false,
      bankVerified: false,
      signingAllowed: false,
    });
    expect(proof.custody).toMatchObject({
      slot: 103,
      minimumReadSlot: 103,
      walletAccountsChecked: 1,
      tokenAccountsChecked: 2,
      mintPoliciesChecked: 2,
      rentPolicyUnchanged: true,
    });
    expect(proof.lifetime).toMatchObject({
      remainingBlocks: '10',
      validitySlot: 104,
    });
    expect(calls.find((c) => c.method === 'isBlockhashValid')?.params).toEqual([
      '11111111111111111111111111111111',
      { commitment: 'confirmed', minContextSlot: 103 },
    ]);
    // Change the public slot precisely after settlement and restore it during
    // the height read. Only the retained private snapshot may set the floor.
    const settlementModule = await import('./jito-cpmm-bundle-replay');
    const originalReplay = settlementModule.replayJitoCpmmBundleSettlement;
    const race = vi
      .spyOn(settlementModule, 'replayJitoCpmmBundleSettlement')
      .mockImplementation(async (...args) => {
        const result = await originalReplay(...args);
        after.maximumSlot = 102;
        return result;
      });
    onHeight = () => {
      after.maximumSlot = 103;
    };
    calls.length = 0;
    try {
      await verifyJitoCpmmOwnedResearchBracket(
        request,
        lifetime,
        before,
        after,
        rpc,
        signal,
      );
      expect(race).toHaveBeenCalledOnce();
      expect(
        calls.find(
          (c) =>
            c.method === 'getMultipleAccounts' &&
            !(c.params[1] as { dataSlice?: unknown }).dataSlice,
        )?.params[1],
      ).toMatchObject({ minContextSlot: 103 });
      expect(
        calls.find((c) => c.method === 'isBlockhashValid')?.params,
      ).toEqual([
        '11111111111111111111111111111111',
        { commitment: 'confirmed', minContextSlot: 103 },
      ]);
    } finally {
      race.mockRestore();
      onHeight = () => {};
      after.maximumSlot = 103;
    }
    const firstBound = await inspectJitoCpmmUnsignedPacket(request.swaps[0]);
    const mutateBytes =
      (key: string, change: (b: ReturnType<typeof Buffer.from>) => void) =>
      (
        keys: string[],
        r: { context: { slot: string }; value: FreshAccount[] },
      ) => {
        const a = r.value[keys.indexOf(key)]!,
          b = Buffer.from(a.data[0], 'base64');
        change(b);
        a.data[0] = b.toString('base64');
      };
    const refusals: (typeof mutateFresh)[] = [
      (keys, r) => {
        const a = r.value[keys.indexOf(firstBound.payer)]!;
        a.lamports = (BigInt(a.lamports) + 1n).toString();
      },
      mutateBytes(firstBound.source, (b) => {
        b[129] = 1;
      }),
      mutateBytes(USDC, (b) => {
        b[44] = 7;
      }),
      mutateBytes(RENT, (b) => {
        b.writeBigUInt64LE(3481n);
      }),
      mutateBytes(CLOCK, (b) => {
        b.writeBigUInt64LE(104n);
      }),
      (_keys, r) => {
        r.context.slot = '102';
      },
      (_keys, r) => {
        r.context.slot = '133';
      },
      (_keys, r) => {
        r.value.pop();
      },
      (keys, r) => {
        r.value[keys.indexOf(firstBound.destination)] = null;
      },
      (keys, r) => {
        r.value[keys.indexOf(USDC)]!.lamports = '0';
      },
      (keys, r) => {
        const index = keys.indexOf(firstBound.payer);
        keys.splice(index, 1);
        r.value.splice(index, 1);
      },
    ];
    for (const mutate of refusals) {
      mutateFresh = mutate;
      await expect(
        verifyJitoCpmmOwnedResearchBracket(
          request,
          lifetime,
          before,
          after,
          rpc,
          signal,
        ),
      ).rejects.toThrow();
    }
    mutateFresh = refusals[0];
    await expect(
      verifyJitoCpmmOwnedResearchBracket(
        request,
        lifetime,
        before,
        after,
        rpc,
        signal,
      ),
    ).rejects.toMatchObject({
      pairDiagnostic: {
        check: 'cpmm-final-custody',
        address: firstBound.payer,
        role: 'wallet',
        comparisons: expect.arrayContaining([
          { field: 'lamports', before: '10000000', after: '10000001' },
        ]),
      },
    });
    mutateFresh = mutateBytes(USDC, (b) => {
      b.writeBigUInt64LE(b.readBigUInt64LE(36) + 1n, 36);
    });
    // Normal mint/burn supply changes preserve the pre-existing mint-policy rule.
    await expect(
      verifyJitoCpmmOwnedResearchBracket(
        request,
        lifetime,
        before,
        after,
        rpc,
        signal,
      ),
    ).resolves.toMatchObject({ custody: { mintPoliciesChecked: 2 } });
    mutateFresh = () => {};
    const wrongReader: PumpLaunchRpc = (...args) => rpc(...args);
    await expect(
      verifyJitoCpmmOwnedResearchBracket(
        request,
        lifetime,
        before,
        after,
        wrongReader,
        signal,
      ),
    ).rejects.toThrow();
    await expect(
      verifyJitoCpmmOwnedResearchBracket(
        request,
        { ...lifetime },
        before,
        after,
        rpc,
        signal,
      ),
    ).rejects.toThrow();
    await expect(
      verifyJitoCpmmOwnedResearchBracket(
        request,
        lifetime,
        { ...before },
        after,
        rpc,
        signal,
      ),
    ).rejects.toThrow();
    const changedFloor = { ...request, minimumSlot: 99 };
    await expect(
      verifyJitoCpmmOwnedResearchBracket(
        changedFloor,
        lifetime,
        before,
        after,
        rpc,
        signal,
      ),
    ).rejects.toThrow();
    valid = false;
    await expect(
      verifyJitoCpmmOwnedResearchBracket(
        request,
        lifetime,
        before,
        after,
        rpc,
        signal,
      ),
    ).rejects.toThrow();
  } finally {
    scanner.mockRestore();
  }
});
