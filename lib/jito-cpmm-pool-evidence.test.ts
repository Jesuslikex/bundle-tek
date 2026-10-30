import { address, getProgramDerivedAddress } from '@solana/kit';
import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { readJitoCpmmPoolEvidence } from './jito-cpmm-pool-evidence';
const { bound, assets } = vi.hoisted(() => ({
  bound: {
    pool: '',
    source: '',
    destination: '',
    inputVault: '',
    outputVault: '',
    inputMint: '',
    outputMint: '',
    payer: '',
    authority: '',
    config: '',
    observation: '',
    authorityBump: 254,
    inputRaw: '123',
    minimumOutputRaw: '100',
    transactionSha256: 'a'.repeat(64),
  },
  assets: {
    after: {
      slot: 101,
      mints: [{ decimals: 6 }, { decimals: 9 }],
      rent: {
        lamportsPerByte: '3480',
        exemptionThreshold: 2,
        burnPercent: 50,
        dataBase64: '',
      },
    },
  },
}));
vi.mock('./jito-cpmm-unsigned-packet', () => ({
  inspectJitoCpmmUnsignedPacket: vi.fn(async () => bound),
}));
vi.mock('./jito-cpmm-asset-evidence', () => ({
  readJitoCpmmAssetEvidence: vi.fn(async () => assets),
}));
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
async function fixture() {
  let n = 1;
  for (const k of [
    'pool',
    'source',
    'destination',
    'inputVault',
    'outputVault',
    'inputMint',
    'outputMint',
    'payer',
    'authority',
    'config',
    'observation',
  ] as const)
    bound[k] = bs58.encode(new Uint8Array(32).fill(n++));
  const configIndex = Buffer.from([0, 0]);
  const [configAddress, configBump] = await getProgramDerivedAddress({
    programAddress: address(CPMM),
    seeds: [new TextEncoder().encode('amm_config'), configIndex],
  });
  bound.config = configAddress;
  [bound.observation] = await getProgramDerivedAddress({
    programAddress: address(CPMM),
    seeds: [new TextEncoder().encode('observation'), bs58.decode(bound.pool)],
  });
  [bound.inputVault] = await getProgramDerivedAddress({
    programAddress: address(CPMM),
    seeds: [
      new TextEncoder().encode('pool_vault'),
      bs58.decode(bound.pool),
      bs58.decode(bound.inputMint),
    ],
  });
  [bound.outputVault] = await getProgramDerivedAddress({
    programAddress: address(CPMM),
    seeds: [
      new TextEncoder().encode('pool_vault'),
      bs58.decode(bound.pool),
      bs58.decode(bound.outputMint),
    ],
  });
  const p = Buffer.alloc(637);
  Buffer.from('f7ede3f5d7c3de46', 'hex').copy(p);
  for (const [offset, key] of [
    [8, bound.config],
    [72, bound.inputVault],
    [104, bound.outputVault],
    [168, bound.inputMint],
    [200, bound.outputMint],
    [232, TOKEN],
    [264, TOKEN],
    [296, bound.observation],
  ] as const)
    Buffer.from(bs58.decode(key)).copy(p, offset);
  p[328] = 254;
  p[331] = 6;
  p[332] = 9;
  const raw = (b: Uint8Array, owner: string) => ({
    owner,
    executable: false,
    lamports: String((128 + b.length) * 6960),
    data: [Buffer.from(b).toString('base64'), 'base64'],
  });
  const tokens = Array.from({ length: 4 }, (_, i) => {
    const b = Buffer.alloc(165);
    Buffer.from(
      bs58.decode(i % 2 === 0 ? bound.inputMint : bound.outputMint),
    ).copy(b);
    Buffer.from(bs58.decode(i < 2 ? bound.payer : bound.authority)).copy(b, 32);
    b[108] = 1;
    b.writeBigUInt64LE(1000000n, 64);
    return raw(b, TOKEN);
  });
  const config = Buffer.alloc(236);
  config[8] = configBump;
  Buffer.from('daf42168cbcb2b6f', 'hex').copy(config);
  config.writeBigUInt64LE(2500n, 12);
  const oracle = Buffer.alloc(4075);
  Buffer.from('7aaec5358109a584', 'hex').copy(oracle);
  Buffer.from(bs58.decode(bound.pool)).copy(oracle, 11);
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(102n, 0);
  clock.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 32);
  return {
    context: { slot: '102' },
    value: [
      raw(p, CPMM),
      ...tokens,
      raw(config, CPMM),
      raw(oracle, CPMM),
      raw(clock, 'Sysvar1111111111111111111111111111111111111'),
    ],
  };
}
const packet = {} as Parameters<typeof readJitoCpmmPoolEvidence>[0];
it('checks pool bindings and actual account rent without granting qualification', async () => {
  const result = await readJitoCpmmPoolEvidence(
    packet,
    100,
    vi.fn().mockResolvedValue(await fixture()),
    new AbortController().signal,
  );
  expect(result.coverage).toHaveLength(7);
  expect(result).toMatchObject({
    rentCoverageChecked: true,
    poolRelationshipsChecked: true,
    poolVerified: false,
    priceVerified: false,
    signingAllowed: false,
  });
});
it.each([0, 1, 2, 3, 4])(
  'refuses insufficient rent in account %s',
  async (i) => {
    const r = await fixture();
    r.value[i].lamports = '1';
    await expect(
      readJitoCpmmPoolEvidence(
        packet,
        100,
        vi.fn().mockResolvedValue(r),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
it.each([0, 8, 72, 168, 232, 296, 328, 331])(
  'refuses changed pool field %s',
  async (offset) => {
    const r = await fixture(),
      b = Buffer.from(r.value[0].data[0], 'base64');
    b[offset] ^= 1;
    r.value[0].data[0] = b.toString('base64');
    await expect(
      readJitoCpmmPoolEvidence(
        packet,
        100,
        vi.fn().mockResolvedValue(r),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
it('refuses swap-disabled pool', async () => {
  const r = await fixture(),
    b = Buffer.from(r.value[0].data[0], 'base64');
  b[329] = 4;
  r.value[0].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('refuses an observation past the original 32-slot limit', async () => {
  const r = await fixture();
  r.context.slot = '133';
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

it.each([
  [5, 0],
  [5, 9],
  [6, 0],
  [6, 8],
  [6, 11],
])('refuses config/oracle corruption %s %s', async (i, offset) => {
  const r = await fixture(),
    b = Buffer.from(r.value[i].data[0], 'base64');
  b[offset] = 255;
  r.value[i].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('refuses a trade fee equal to the entire input', async () => {
  const r = await fixture(),
    b = Buffer.from(r.value[5].data[0], 'base64');
  b.writeBigUInt64LE(1000000n, 12);
  r.value[5].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('refuses an out-of-range oracle ring index', async () => {
  const r = await fixture(),
    b = Buffer.from(r.value[6].data[0], 'base64');
  b.writeUInt16LE(100, 9);
  r.value[6].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it.each([8, 10])('refuses config PDA metadata change at %s', async (offset) => {
  const r = await fixture(),
    b = Buffer.from(r.value[5].data[0], 'base64');
  b[offset] ^= 1;
  r.value[5].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('refuses an internally linked but noncanonical oracle address', async () => {
  const r = await fixture();
  bound.observation = bs58.encode(new Uint8Array(32).fill(88));
  const p = Buffer.from(r.value[0].data[0], 'base64');
  Buffer.from(bs58.decode(bound.observation)).copy(p, 296);
  r.value[0].data[0] = p.toString('base64');
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it.each([101n, 103n])(
  'requires exact Clock/context equality, refusing Clock slot %s',
  async (slot) => {
    const r = await fixture(),
      b = Buffer.from(r.value[7].data[0], 'base64');
    b.writeBigUInt64LE(slot, 0);
    r.value[7].data[0] = b.toString('base64');
    await expect(
      readJitoCpmmPoolEvidence(
        packet,
        100,
        vi.fn().mockResolvedValue(r),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
it('refuses a pool whose open time is after the observed Clock', async () => {
  const r = await fixture(),
    b = Buffer.from(r.value[0].data[0], 'base64');
  b.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000) + 60), 373);
  r.value[0].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('excludes accrued protocol/fund fees from swap reserves', async () => {
  const r = await fixture(),
    b = Buffer.from(r.value[0].data[0], 'base64');
  b.writeBigUInt64LE(1000000n, 341);
  r.value[0].data[0] = b.toString('base64');
  await expect(
    readJitoCpmmPoolEvidence(
      packet,
      100,
      vi.fn().mockResolvedValue(r),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it.each([
  [0, 389],
  [0, 390],
  [0, 397],
  [5, 108],
  [5, 116],
  [6, 4043],
])(
  'refuses reused historical padding for account %s at %s',
  async (i, offset) => {
    const r = await fixture(),
      b = Buffer.from(r.value[i].data[0], 'base64');
    b[offset] = 1;
    r.value[i].data[0] = b.toString('base64');
    await expect(
      readJitoCpmmPoolEvidence(
        packet,
        100,
        vi.fn().mockResolvedValue(r),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);
