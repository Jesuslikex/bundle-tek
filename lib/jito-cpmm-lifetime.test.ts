import { expect, it, vi } from 'vitest';
import {
  captureJitoCpmmLifetime,
  recheckJitoCpmmLifetime,
} from './jito-cpmm-lifetime';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
const hash = '11111111111111111111111111111111';
vi.mock('./jito-cpmm-unsigned-packet', () => ({
  inspectJitoCpmmUnsignedPacket: vi.fn(async () => ({
    blockhash: '11111111111111111111111111111111',
    transactionSha256: 'a'.repeat(64),
  })),
}));
const packet = {} as Parameters<typeof recheckJitoCpmmLifetime>[0];
function rpc(height = '590', validitySlot = '103', valid = true) {
  return vi.fn(
    async (method: string, _params: unknown[], _signal: AbortSignal) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getLatestBlockhash')
        return {
          context: { slot: '101' },
          value: { blockhash: hash, lastValidBlockHeight: '600' },
        };
      if (method === 'isBlockhashValid')
        return { context: { slot: validitySlot }, value: valid };
      if (method === 'getBlockHeight') return height;
      throw Error('Unexpected method');
    },
  );
}
it('binds an issued hash and preserves the existing ten-block margin and RPC floors', async () => {
  const call = rpc(),
    signal = new AbortController().signal,
    capture = await captureJitoCpmmLifetime(100, call, signal);
  const result = await recheckJitoCpmmLifetime(packet, capture, 102, signal);
  expect(result).toMatchObject({
    blockhash: hash,
    remainingBlocks: '10',
    signingAllowed: false,
    bankVerified: false,
  });
  expect(call.mock.calls.find((v) => v[0] === 'getBlockHeight')?.[1]).toEqual([
    { commitment: 'confirmed', minContextSlot: 103 },
  ]);
  expect(call.mock.calls.find((v) => v[0] === 'isBlockhashValid')?.[1]).toEqual(
    [hash, { commitment: 'confirmed', minContextSlot: 102 }],
  );
});
it.each([
  ['591', '103', true],
  ['590', '99', true],
  ['590', '133', true],
  ['590', '103', false],
] as const)(
  'refuses expired/invalid/stale lifetime %s %s %s',
  async (h, s, valid) => {
    const call = rpc(h, s, valid),
      signal = new AbortController().signal,
      capture = await captureJitoCpmmLifetime(100, call, signal);
    await expect(
      recheckJitoCpmmLifetime(packet, capture, 102, signal),
    ).rejects.toThrow();
  },
);
it('refuses serialized or mutated captures before rechecking the provider', async () => {
  const call = rpc(),
    signal = new AbortController().signal,
    capture = await captureJitoCpmmLifetime(100, call, signal);
  call.mockClear();
  await expect(
    recheckJitoCpmmLifetime(packet, structuredClone(capture), 102, signal),
  ).rejects.toThrow();
  capture.lastValidBlockHeight = '999';
  await expect(
    recheckJitoCpmmLifetime(packet, capture, 102, signal),
  ).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});
it('refuses a wrong network', async () => {
  await expect(
    captureJitoCpmmLifetime(
      100,
      vi.fn(async () => 'wrong-network'),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('honors cancellation without requesting provider data', async () => {
  const control = new AbortController();
  control.abort();
  const call = rpc();
  await expect(
    captureJitoCpmmLifetime(100, call, control.signal),
  ).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});
