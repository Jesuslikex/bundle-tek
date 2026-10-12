import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { observeSignaturePage, signatureCursor } from './tracked-signatures';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { DEVNET_GENESIS_HASH } from './devnet-intent';
const address = bs58.encode(new Uint8Array(32).fill(1));
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
function provider(rows: unknown, genesis = SOLANA_MAINNET_GENESIS, slot = 100) {
  return vi.fn(async (_: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result:
        body.method === 'getGenesisHash'
          ? genesis
          : body.method === 'getSlot'
            ? slot
            : rows,
    });
  }) as unknown as typeof fetch;
}
it('binds a finalized cursor page to an anchor and forwards an exact exclusive signature', async () => {
  const fetcher = provider(
    Array.from({ length: 25 }, (_, i) => ({
      signature: sig(i + 1),
      slot: 100 - i,
      blockTime: null,
      err: i === 2 ? {} : null,
    })),
  );
  const first = await observeSignaturePage(
    address,
    'mainnet',
    null,
    new AbortController().signal,
    fetcher,
  );
  expect(first.signatures).toHaveLength(25);
  expect(first.signatures[2].failed).toBe(true);
  const cursor = signatureCursor(first.nextCursor)!;
  expect(cursor).toEqual({ signature: sig(25), slot: 76, anchor: 100 });
  const older = provider([
    { signature: sig(26), slot: 76, blockTime: 1, err: null },
  ]);
  const second = await observeSignaturePage(
    address,
    'mainnet',
    cursor,
    new AbortController().signal,
    older,
  );
  expect(second.nextCursor).toBeNull();
  expect(second.anchor).toBe(100);
  expect(
    JSON.parse(vi.mocked(older).mock.calls[2][1]?.body as string).params[1],
  ).toEqual({
    commitment: 'finalized',
    limit: 25,
    minContextSlot: 100,
    before: sig(25),
  });
});
it('rejects wrong genesis and a provider behind the retained anchor', async () => {
  await expect(
    observeSignaturePage(
      address,
      'mainnet',
      null,
      new AbortController().signal,
      provider([], DEVNET_GENESIS_HASH),
    ),
  ).rejects.toThrow('network');
  await expect(
    observeSignaturePage(
      address,
      'devnet',
      null,
      new AbortController().signal,
      provider([], DEVNET_GENESIS_HASH),
    ),
  ).resolves.toMatchObject({ signatures: [], nextCursor: null });
  await expect(
    observeSignaturePage(
      address,
      'mainnet',
      { signature: sig(1), slot: 90, anchor: 101 },
      new AbortController().signal,
      provider([]),
    ),
  ).rejects.toThrow('behind');
});
it('rejects malformed, duplicated, unordered and cursor-repeating signature records', async () => {
  const row = { signature: sig(1), slot: 90, blockTime: null, err: null };
  for (const rows of [
    [row, row],
    [{ ...row, signature: 'bad' }],
    [row, { ...row, signature: sig(2), slot: 91 }],
    [{ ...row, slot: 101 }],
    [{ ...row, err: undefined }],
    [{ ...row, blockTime: -1 }],
    Array(26).fill(row),
  ])
    await expect(
      observeSignaturePage(
        address,
        'mainnet',
        null,
        new AbortController().signal,
        provider(rows),
      ),
    ).rejects.toThrow();
  await expect(
    observeSignaturePage(
      address,
      'mainnet',
      { signature: sig(1), slot: 90, anchor: 100 },
      new AbortController().signal,
      provider([row]),
    ),
  ).rejects.toThrow();
});
it('validates public history cursors without coercion', () => {
  expect(signatureCursor(null)).toBeNull();
  for (const raw of [
    'bad',
    'null',
    JSON.stringify({ signature: sig(1), slot: 1, anchor: 0 }),
    JSON.stringify({ signature: sig(1), slot: '1', anchor: 2 }),
    JSON.stringify({ signature: 'bad', slot: 1, anchor: 2 }),
    JSON.stringify({
      signature: sig(1),
      slot: 1,
      anchor: Number.MAX_SAFE_INTEGER + 1,
    }),
  ])
    expect(() => signatureCursor(raw)).toThrow();
});
