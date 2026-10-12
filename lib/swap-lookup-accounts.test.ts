import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { address, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { solanaTransferMessage } from './solana-funding';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from './swap-lookup-accounts';
import { reviewSwapInstructions } from './swap-instruction-review';
const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  other = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4',
  token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export function lookupAccount(patch?: (bytes: Uint8Array) => void) {
  const bytes = new Uint8Array(120),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, (1n << 64n) - 1n, true);
  view.setBigUint64(12, 90n, true);
  bytes.set(bs58.decode(token), 56);
  bytes.set(bs58.decode(other), 88);
  patch?.(bytes);
  return {
    owner: 'AddressLookupTab1e1111111111111111111111111',
    executable: false,
    data: [btoa(String.fromCharCode(...bytes)), 'base64'],
  };
}
function message() {
  const base = getCompiledTransactionMessageDecoder().decode(
    Uint8Array.from([
      128,
      ...solanaTransferMessage(
        wallet,
        other,
        '11111111111111111111111111111111',
        1n,
      ),
      0,
    ]),
  );
  if (base.version !== 0) throw new Error('Invalid fixture');
  return {
    ...base,
    addressTableLookups: [
      {
        lookupTableAddress: address(other),
        writableIndexes: [1],
        readonlyIndexes: [0],
      },
    ],
    instructions: [
      {
        programAddressIndex: 4,
        accountIndices: [1, 0, 0],
        data: Uint8Array.from([4, ...new Uint8Array(8).fill(255)]),
      },
    ],
  };
}
const rpc = (account: unknown = lookupAccount(), slot = '100') =>
  vi.fn(async () => ({ context: { slot }, value: [account] }));
it('resolves active table indices in global writable/readonly order and identifies a loaded program', async () => {
  const provider = rpc(),
    resolved = await readSwapLookupAccounts(message(), 100, provider);
  expect(provider).toHaveBeenCalledWith('getMultipleAccounts', [
    [other],
    { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
  ]);
  expect(resolved).toMatchObject({
    observedSlot: 100,
    writable: [other],
    readonly: [token],
  });
  expect(resolved!.tables[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  const review = reviewSwapInstructions(message(), resolved!);
  expect(review.unresolvedAccountCount).toBe(0);
  expect(review.instructions[0]).toMatchObject({
    action: 'Token delegate approval',
    amountRaw: '18446744073709551615',
    program: { address: token, writable: false },
  });
  expect(review.instructionsVerified).toBe(false);
});
it('rejects absent/wrong-owner/malformed/deactivating/future and newly appended table entries', async () => {
  for (const account of [
    null,
    { ...lookupAccount(), owner: token },
    { ...lookupAccount(), executable: true },
    { ...lookupAccount(), data: ['AA==', 'base64'] },
    lookupAccount((b) => (b[0] = 0)),
    lookupAccount((b) => (b[4] = 0)),
    lookupAccount((b) => new DataView(b.buffer).setBigUint64(12, 101n, true)),
    lookupAccount((b) => (b[20] = 3)),
    lookupAccount((b) => (b[21] = 2)),
    lookupAccount((b) => (b[55] = 1)),
    lookupAccount((b) => {
      new DataView(b.buffer).setBigUint64(12, 100n, true);
      b[20] = 1;
    }),
  ])
    await expect(
      readSwapLookupAccounts(message(), 100, rpc(account)),
    ).rejects.toThrow();
  for (const observed of ['99', '133', '100.1'])
    await expect(
      readSwapLookupAccounts(message(), 100, rpc(lookupAccount(), observed)),
    ).rejects.toThrow();
  const base = message();
  const invalidSlotProvider = rpc();
  await expect(
    readSwapLookupAccounts(base, NaN, invalidSlotProvider),
  ).rejects.toThrow();
  expect(invalidSlotProvider).not.toHaveBeenCalled();
  await expect(
    readSwapLookupAccounts(
      {
        ...base,
        addressTableLookups: [
          { ...base.addressTableLookups[0], readonlyIndexes: [2] },
        ],
      },
      100,
      rpc(),
    ),
  ).rejects.toThrow();
  await expect(
    readSwapLookupAccounts(
      {
        ...base,
        addressTableLookups: [
          ...base.addressTableLookups,
          ...base.addressTableLookups,
        ],
      },
      100,
      rpc(),
    ),
  ).rejects.toThrow();
});
it('requires unchanged table bytes and agreement with provider loaded addresses when present', async () => {
  const before = (await readSwapLookupAccounts(message(), 100, rpc()))!;
  const after = await readSwapLookupAccounts(
    message(),
    101,
    rpc(lookupAccount(), '101'),
  );
  expect(() =>
    assertSameSwapLookups(before, after, {
      writable: [other],
      readonly: [token],
    }),
  ).not.toThrow();
  expect(() => assertSameSwapLookups(before, after, undefined)).not.toThrow();
  for (const loaded of [
    { writable: [wallet], readonly: [token] },
    { writable: [], readonly: [token] },
    {},
  ])
    expect(() => assertSameSwapLookups(before, after, loaded)).toThrow();
  expect(() =>
    assertSameSwapLookups(
      before,
      { ...after!, tables: [{ ...after!.tables[0], sha256: 'changed' }] },
      undefined,
    ),
  ).toThrow();
  const noLookups = { ...message(), addressTableLookups: [] };
  const provider = rpc();
  expect(await readSwapLookupAccounts(noLookups, 100, provider)).toBeNull();
  expect(provider).not.toHaveBeenCalled();
});
