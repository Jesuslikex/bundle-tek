import { expect, it } from 'vitest';
import { address, getCompiledTransactionMessageDecoder } from '@solana/kit';
import bs58 from 'bs58';
import { solanaTransferMessage } from './solana-funding';
import { reviewSwapInstructions } from './swap-instruction-review';
const wallet = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const other = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function message() {
  const value = getCompiledTransactionMessageDecoder().decode(
    Uint8Array.from([
      128,
      ...solanaTransferMessage(
        wallet,
        other,
        '11111111111111111111111111111111',
        18446744073709551615n,
      ),
      0,
    ]),
  );
  if (value.version !== 0) throw new Error('Invalid fixture');
  return value;
}
function tokenMessage(tag: number, data: number[], accountCount = 3) {
  const base = message();
  return {
    ...base,
    staticAccounts: [address(wallet), address(other), address(token)],
    instructions: [
      {
        programAddressIndex: 2,
        accountIndices: Array.from({ length: accountCount }, (_, i) => i % 2),
        data: Uint8Array.from([tag, ...data]),
      },
    ],
  };
}
it('decodes exact native transfers and retains account privileges without treating them as swaps', () => {
  const result = reviewSwapInstructions(message());
  expect(result.instructions[0]).toMatchObject({
    action: 'Native SOL transfer',
    amountRaw: '18446744073709551615',
    recognized: true,
    changesAuthority: false,
    program: { address: '11111111111111111111111111111111' },
    accounts: [
      { address: wallet, signer: true, writable: true },
      { address: other, signer: false, writable: true },
    ],
  });
  expect(result).toMatchObject({
    executionAllowed: false,
    instructionsVerified: false,
    unresolvedAccountCount: 0,
  });
});
it('exposes delegate approvals, exact checked amounts, authority changes and closure recipients', () => {
  for (const tag of [3, 4, 12, 13]) {
    const result = reviewSwapInstructions(
      tokenMessage(
        tag,
        [...new Uint8Array(8).fill(255), ...(tag >= 12 ? [9] : [])],
        tag >= 12 ? 4 : 3,
      ),
    );
    expect(result.instructions[0].amountRaw).toBe('18446744073709551615');
    expect(result.instructions[0].changesAuthority).toBe(
      tag === 4 || tag === 13,
    );
    expect(result.instructions[0].decimals).toBe(tag >= 12 ? 9 : null);
  }
  const authority = reviewSwapInstructions(
    tokenMessage(6, [2, 1, ...bs58.decode(other)], 2),
  );
  expect(authority.instructions[0]).toMatchObject({
    action: 'Token authority change',
    authorityType: 2,
    newAuthority: other,
  });
  expect(authority.authorityActionCount).toBe(1);
  expect(
    reviewSwapInstructions(tokenMessage(6, [3, 0], 2)).instructions[0]
      .newAuthority,
  ).toBeNull();
  expect(
    reviewSwapInstructions(tokenMessage(9, [])).instructions[0],
  ).toMatchObject({
    action: 'Token account closure',
    accounts: [{ address: wallet }, { address: other }, { address: wallet }],
  });
  expect(
    reviewSwapInstructions(tokenMessage(5, [], 2)).authorityActionCount,
  ).toBe(1);
  expect(
    reviewSwapInstructions(tokenMessage(17, [], 1)).instructions[0].action,
  ).toBe('Wrapped SOL synchronization');
  const extended = tokenMessage(4, [...new Uint8Array(8).fill(255)]);
  expect(
    reviewSwapInstructions({
      ...extended,
      staticAccounts: [
        address(wallet),
        address(other),
        address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
      ],
    }).instructions[0].action,
  ).toBe('Token delegate approval');
});
it('does not infer lookup addresses or recognize unknown/malformed instruction layouts', () => {
  const base = message();
  const result = reviewSwapInstructions({
    ...base,
    addressTableLookups: [
      {
        lookupTableAddress: address(other),
        writableIndexes: [7],
        readonlyIndexes: [9],
      },
    ],
    instructions: [
      {
        programAddressIndex: 4,
        accountIndices: [0, 3],
        data: Uint8Array.from([2, 0, 0, 0, ...new Uint8Array(8)]),
      },
    ],
  });
  expect(result).toMatchObject({
    unresolvedAccountCount: 2,
    unrecognizedInstructionCount: 1,
  });
  expect(result.instructions[0].program).toMatchObject({
    address: '',
    lookup: `${other} · readonly index 9`,
    writable: false,
  });
  expect(result.instructions[0].accounts[1]).toMatchObject({
    address: '',
    lookup: `${other} · writable index 7`,
    writable: true,
  });
  for (const changed of [
    tokenMessage(3, [1, 2]),
    tokenMessage(6, [2, 2, ...new Uint8Array(32)], 2),
    tokenMessage(255, []),
  ])
    expect(reviewSwapInstructions(changed).unrecognizedInstructionCount).toBe(
      1,
    );
  expect(() =>
    reviewSwapInstructions({
      ...base,
      instructions: [
        { programAddressIndex: 99, accountIndices: [], data: new Uint8Array() },
      ],
    }),
  ).toThrow();
});
