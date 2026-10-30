import { expect, it, vi, beforeEach } from 'vitest';
import bs58 from 'bs58';
import { readJitoCpmmPriceComparison } from './jito-cpmm-price-evidence';
const { bound, assets } = vi.hoisted(() => ({
  bound: {
    inputMint: 'i',
    outputMint: 'o',
    pool: 'p',
    inputRaw: '100',
    minimumOutputRaw: '98',
    transactionSha256: 'a'.repeat(64),
  },
  assets: { after: { mints: [{ decimals: 0 }, { decimals: 0 }] } },
}));
vi.mock('./jito-cpmm-unsigned-packet', () => ({
  inspectJitoCpmmUnsignedPacket: vi.fn(async () => bound),
}));
vi.mock('./jito-cpmm-asset-evidence', () => ({
  readJitoCpmmAssetEvidence: vi.fn(async () => assets),
}));
const inputPair = bs58.encode(new Uint8Array(32).fill(1)),
  outputPair = bs58.encode(new Uint8Array(32).fill(2));
const now = 1800000000000;
const packet = {} as Parameters<typeof readJitoCpmmPriceComparison>[0];
function observation(address: string) {
  return {
    chain: 'Solana',
    address,
    source: 'api.dexscreener.com' as const,
    observedAt: new Date(now).toISOString(),
    executionAllowed: false as const,
    returnedPairCount: 1,
    quoteOnlyPairCount: 0,
    pairs: [
      {
        address: address === 'i' ? inputPair : outputPair,
        dex: 'test',
        url: '',
        quoteSymbol: 'USD',
        priceUsd: '1',
        liquidityUsd: null,
        volume24hUsd: null,
        change24h: null,
        marketCapUsd: null,
      },
    ],
  };
}
function run(
  observe = vi.fn(async ({ address }: { address: string }) =>
    observation(address),
  ),
) {
  return readJitoCpmmPriceComparison(
    packet,
    { inputPair, outputPair },
    100,
    vi.fn(),
    new AbortController().signal,
    { observe, clock: () => now },
  );
}
beforeEach(() => {
  bound.inputRaw = '100';
  bound.minimumOutputRaw = '98';
  bound.pool = 'p';
  assets.after.mints = [{ decimals: 0 }, { decimals: 0 }];
});
it.each([
  ['98', false],
  ['97', true],
  ['101', false],
])('uses exact 2 percent math for minimum %s', async (min, ack) => {
  bound.minimumOutputRaw = min;
  const r = await run();
  expect(r).toMatchObject({
    available: true,
    acknowledgementRequired: ack,
    priceVerified: false,
    signingAllowed: false,
  });
});
it('normalizes raw units using observed mint decimals', async () => {
  bound.inputRaw = '1000000';
  bound.minimumOutputRaw = '980000000';
  assets.after.mints = [{ decimals: 6 }, { decimals: 9 }];
  expect(await run()).toMatchObject({
    available: true,
    minimumValueDifferenceBps: '-200',
    acknowledgementRequired: false,
  });
});
it('does not read prices from the execution pool', async () => {
  bound.pool = inputPair;
  const observe = vi.fn();
  expect(await run(observe)).toMatchObject({
    available: false,
    acknowledgementRequired: true,
  });
  expect(observe).not.toHaveBeenCalled();
});
it.each([
  'stale',
  'future',
  'wrong mint',
  'wrong source',
  'duplicate',
  'missing',
])('refuses %s observations', async (kind) => {
  const observe = vi.fn(async ({ address }: { address: string }) => {
    const o = observation(address);
    if (kind === 'stale') o.observedAt = new Date(now - 300001).toISOString();
    if (kind === 'future') o.observedAt = new Date(now + 1).toISOString();
    if (kind === 'wrong mint') o.address = 'other';
    if (kind === 'wrong source') Object.assign(o, { source: 'untrusted' });
    if (kind === 'duplicate') o.pairs.push(o.pairs[0]);
    if (kind === 'missing') o.pairs = [];
    return o;
  });
  expect(await run(observe)).toMatchObject({
    available: false,
    acknowledgementRequired: true,
    signingAllowed: false,
  });
});
it('reports provider failure without leaking provider errors', async () => {
  const observe = vi.fn(async () => {
    throw Error('private endpoint details');
  });
  const r = await run(observe);
  expect(r).toMatchObject({ available: false });
  expect(JSON.stringify(r)).not.toContain('private endpoint');
});
