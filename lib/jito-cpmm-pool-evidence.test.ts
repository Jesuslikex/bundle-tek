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
function fixture() {
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
    return raw(b, TOKEN);
  });
  return { context: { slot: '102' }, value: [raw(p, CPMM), ...tokens] };
}
const packet = {} as Parameters<typeof readJitoCpmmPoolEvidence>[0];
it('checks pool bindings and actual account rent without granting qualification', async () => {
  const result = await readJitoCpmmPoolEvidence(
    packet,
    100,
    vi.fn().mockResolvedValue(fixture()),
    new AbortController().signal,
  );
  expect(result.coverage).toHaveLength(5);
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
    const r = fixture();
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
    const r = fixture(),
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
  const r = fixture(),
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
  const r = fixture();
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
