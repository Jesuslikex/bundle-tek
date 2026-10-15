import { it, expect, vi } from 'vitest';
import { getExtensionEncoder } from '@solana-program/token-2022';
import { address, none, some } from '@solana/kit';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { simulateImportedSwap } from './imported-swap-simulation';
import {
  swapTokenBytes,
  readSwapMintEvidence,
  assertSameSwapMintEvidence,
  swapToken2022Programs,
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const pair = { inputMint: SWAP_WRAPPED_SOL, outputMint: mint };
const wire = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function rawMint(
  program: string,
  decimals: number,
  extensions: Uint8Array[] = [],
) {
  const bytes = new Uint8Array(
    extensions.length ? 166 + extensions.reduce((n, b) => n + b.length, 0) : 82,
  );
  bytes[44] = decimals;
  bytes[45] = 1;
  if (extensions.length) {
    bytes[165] = 1;
    let offset = 166;
    for (const e of extensions) {
      bytes.set(e, offset);
      offset += e.length;
    }
  }
  return { owner: program, executable: false, data: [wire(bytes), 'base64'] };
}
const encode = getExtensionEncoder();
it('reads and rechecks canonical metadata-only Token-2022 mint evidence at bounded confirmed slots', async () => {
  const modern = rawMint(SWAP_TOKEN_2022, 6, [
    Uint8Array.from(
      encode.encode({
        __kind: 'MetadataPointer',
        authority: none(),
        metadataAddress: some(address(mint)),
      }),
    ),
  ]);
  const rpc = vi.fn(async () => ({
    context: { slot: '101' },
    value: [rawMint(SWAP_TOKEN, 9), modern],
  }));
  const first = await readSwapMintEvidence(pair, 100, rpc);
  expect(first.mints.map((m) => m.program)).toEqual([
    SWAP_TOKEN,
    SWAP_TOKEN_2022,
  ]);
  expect(first.mints[1].policySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(rpc.mock.calls[0]).toEqual([
    'getMultipleAccounts',
    [
      [pair.inputMint, pair.outputMint],
      { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
    ],
  ]);
  expect(() =>
    assertSameSwapMintEvidence(first, { ...first, slot: 102 }),
  ).not.toThrow();
  const mintedSupply = structuredClone(modern);
  const supplyBytes = Uint8Array.from(atob(mintedSupply.data[0]), (c) =>
    c.charCodeAt(0),
  );
  supplyBytes[36] = 1;
  mintedSupply.data[0] = wire(supplyBytes);
  const afterMint = await readSwapMintEvidence(pair, 101, async () => ({
    context: { slot: '102' },
    value: [rawMint(SWAP_TOKEN, 9), mintedSupply],
  }));
  expect(() => assertSameSwapMintEvidence(first, afterMint)).not.toThrow();
  const proof = {
    ...first,
    format: 'swap-token-2022-evidence-v1' as const,
    recheckSlot: 102,
    accountSize: 170 as const,
    rentLamports: '2074080',
  };
  expect(swapToken2022Programs(proof, pair, 102).get(mint)).toBe(
    SWAP_TOKEN_2022,
  );
  for (const changed of [
    { ...first, slot: 100 },
    { ...first, slot: 134 },
    {
      ...first,
      mints: first.mints.map((m) => ({ ...m, policySha256: 'a'.repeat(64) })),
    },
  ])
    expect(() => assertSameSwapMintEvidence(first, changed)).toThrow();
});
it('rejects fee, hook, malformed and duplicate extensions instead of treating them as plain token accounts', () => {
  const pointer = Uint8Array.from(
    encode.encode({
      __kind: 'MetadataPointer',
      authority: none(),
      metadataAddress: some(address(mint)),
    }),
  );
  for (const raw of [
    rawMint(SWAP_TOKEN, 6, [pointer]),
    rawMint(SWAP_TOKEN_2022, 6, [pointer, pointer]),
    rawMint(SWAP_TOKEN_2022, 6, [
      Uint8Array.from(
        encode.encode({
          __kind: 'TransferHook',
          authority: address('11111111111111111111111111111111'),
          programId: address('11111111111111111111111111111111'),
        }),
      ),
    ]),
    rawMint(SWAP_TOKEN_2022, 6, [Uint8Array.from([1, 0, 2, 0, 0])]),
  ])
    expect(() => swapTokenBytes(raw, true)).toThrow();
  const bytes = new Uint8Array(178);
  bytes[165] = 2;
  bytes.set(
    encode.encode({ __kind: 'TransferFeeAmount', withheldAmount: 0n }),
    166,
  );
  expect(() =>
    swapTokenBytes(
      {
        owner: SWAP_TOKEN_2022,
        executable: false,
        data: [wire(bytes), 'base64'],
      },
      false,
    ),
  ).toThrow();
});
it('rejects missing, stale, malformed, wrong-program and invalid native mint observations', async () => {
  for (const result of [
    {
      context: { slot: '99' },
      value: [rawMint(SWAP_TOKEN, 9), rawMint(SWAP_TOKEN_2022, 6)],
    },
    {
      context: { slot: '133' },
      value: [rawMint(SWAP_TOKEN, 9), rawMint(SWAP_TOKEN_2022, 6)],
    },
    {
      context: { slot: 101 },
      value: [rawMint(SWAP_TOKEN, 9), rawMint(SWAP_TOKEN_2022, 6)],
    },
    { context: { slot: '101' }, value: [null, rawMint(SWAP_TOKEN_2022, 6)] },
    {
      context: { slot: '101' },
      value: [rawMint(SWAP_TOKEN_2022, 9), rawMint(SWAP_TOKEN_2022, 6)],
    },
    { context: { slot: '101' }, value: [rawMint(SWAP_TOKEN, 9)] },
    {
      context: { slot: '101' },
      value: [
        rawMint(SWAP_TOKEN, 9),
        rawMint('11111111111111111111111111111111', 6),
      ],
    },
  ])
    await expect(
      readSwapMintEvidence(pair, 100, async () => result),
    ).rejects.toThrow();
});
it('requires unchanged independent mint bytes across the actual signing simulation and exact route program declarations', async () => {
  const f = await nativeWarmupFixture({ token2022: true, v2: true });
  for (const mode of [
    'changed',
    'wrong-program',
    'unsupported-hook',
  ] as const) {
    let mintReads = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (typeof init?.body !== 'string')
        throw new Error('Fixture requires JSON RPC text.');
      const body = JSON.parse(init.body);
      const response = await f.fetcher(url, init);
      if (
        body.method !== 'getMultipleAccounts' ||
        body.params[0][0] !== f.order.inputMint
      )
        return response;
      mintReads++;
      const json = (await response.json()) as {
        result: { value: { owner: string; data: string[] }[] };
      };
      if (mode === 'wrong-program') json.result.value[1].owner = SWAP_TOKEN;
      else if (mode === 'unsupported-hook')
        json.result.value[1] = rawMint(SWAP_TOKEN_2022, 6, [
          Uint8Array.from(
            encode.encode({
              __kind: 'TransferHook',
              authority: address('11111111111111111111111111111111'),
              programId: address('11111111111111111111111111111111'),
            }),
          ),
        ]);
      else if (mintReads === 2) {
        const raw = json.result.value[1];
        const bytes = Uint8Array.from(atob(raw.data[0]), (c) =>
          c.charCodeAt(0),
        );
        bytes[44] = 7;
        raw.data[0] = wire(bytes);
      }
      return Response.json(json);
    };
    await expect(
      simulateImportedSwap(
        f.order,
        new AbortController().signal,
        fetcher,
        true,
      ),
    ).rejects.toThrow();
  }
});
it.each([false, true])(
  'reads mint owners for legacy token declarations too (V2 %s)',
  async (v2) => {
    const f = await nativeWarmupFixture({ v2 });
    const fetcher: typeof fetch = async (url, init) => {
      if (typeof init?.body !== 'string')
        throw new Error('Fixture requires JSON RPC text.');
      const body = JSON.parse(init.body),
        response = await f.fetcher(url, init);
      if (
        body.method !== 'getMultipleAccounts' ||
        body.params[0][0] !== f.order.inputMint
      )
        return response;
      const json = (await response.json()) as {
        result: { value: { owner: string }[] };
      };
      json.result.value[1].owner = SWAP_TOKEN_2022;
      return Response.json(json);
    };
    await expect(
      simulateImportedSwap(
        f.order,
        new AbortController().signal,
        fetcher,
        true,
      ),
    ).rejects.toThrow('Route token programs differ');
  },
);
