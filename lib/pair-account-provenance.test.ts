import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { address, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { solanaTransferMessage } from './solana-funding';
import { pairAccountProvenance } from './pair-account-provenance';

function fixture() {
  const keys = Array.from({ length: 10 }, (_, i) =>
    address(bs58.encode(new Uint8Array(32).fill(i + 1))),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    Uint8Array.from([
      128,
      ...solanaTransferMessage(keys[0], keys[1], keys[2], 1n),
      0,
    ]),
  );
  if (message.version !== 0) throw Error('fixture version');
  const compiled = {
    ...message,
    header: {
      numSignerAccounts: 2,
      numReadonlySignerAccounts: 1,
      numReadonlyNonSignerAccounts: 1,
    },
    staticAccounts: keys.slice(0, 4),
    addressTableLookups: [
      {
        lookupTableAddress: keys[8],
        writableIndexes: [7],
        readonlyIndexes: [9],
      },
      {
        lookupTableAddress: keys[9],
        writableIndexes: [8],
        readonlyIndexes: [10],
      },
    ],
    instructions: [
      {
        programAddressIndex: 3,
        accountIndices: [0, 2, 4, 5, 6, 7, 4],
        data: new Uint8Array(),
      },
    ],
  };
  const lookups = {
    observedSlot: 123,
    tables: [
      {
        address: String(keys[8]),
        sha256: 'a'.repeat(64),
        lastExtendedSlot: '100',
        writable: [String(keys[4])],
        readonly: [String(keys[6])],
      },
      {
        address: String(keys[9]),
        sha256: 'b'.repeat(64),
        lastExtendedSlot: '100',
        writable: [String(keys[5])],
        readonly: [String(keys[7])],
      },
    ],
    writable: keys.slice(4, 6).map(String),
    readonly: keys.slice(6, 8).map(String),
  };
  return {
    keys,
    compiled,
    lookups,
    read: (i: number) =>
      pairAccountProvenance(compiled, lookups, i, keys[i], 'c'.repeat(64)),
  };
}
it.each([
  [0, true, true],
  [1, false, true],
  [2, true, false],
  [3, false, false],
])(
  'explains static account %s without changing privileges',
  (index, writable, signer) => {
    const { read } = fixture();
    expect(read(Number(index))).toMatchObject({
      packetScopeEvidence: 'available',
      compiledAccountSource: 'static',
      compiledAccountIndex: index,
      declaredWritable: writable,
      declaredSigner: signer,
    });
  },
);
it.each([
  [4, 'lookup-writable', 8, 7, 'a'],
  [5, 'lookup-writable', 9, 8, 'b'],
  [6, 'lookup-readonly', 8, 9, 'a'],
  [7, 'lookup-readonly', 9, 10, 'b'],
])(
  'binds loaded account %s to the correct table despite global writable/readonly ordering',
  (index, source, table, entry, hash) => {
    const { keys, read } = fixture();
    expect(read(Number(index))).toMatchObject({
      compiledAccountSource: source,
      lookupTableAddress: keys[Number(table)],
      lookupEntryIndex: entry,
      lookupTableSha256: String(hash).repeat(64),
      lookupObservedSlot: 123,
      declaredWritable: source === 'lookup-writable',
      declaredSigner: false,
    });
  },
);
it('retains exact repeated instruction positions and top-level program use without instruction bytes', () => {
  const { read } = fixture();
  const references = (index: number) => {
    const value = read(index).instructionReferences;
    if (typeof value !== 'string')
      throw Error('Missing instruction reference evidence');
    return JSON.parse(value);
  };
  expect(references(4)).toEqual([
    { instructionIndex: 0, asProgram: false, accountPositions: [2, 6] },
  ]);
  expect(references(3)).toEqual([
    { instructionIndex: 0, asProgram: true, accountPositions: [] },
  ]);
  expect(read(4).packetSha256).toBe('c'.repeat(64));
});
it('marks missing or inconsistent provenance unavailable rather than reconstructing a packet', () => {
  const { compiled, lookups, keys } = fixture();
  for (const index of [-1, 8, NaN])
    expect(
      pairAccountProvenance(compiled, lookups, index, keys[0], 'c'.repeat(64)),
    ).toEqual({ packetScopeEvidence: 'unavailable' });
  expect(
    pairAccountProvenance(compiled, lookups, 4, keys[0], 'c'.repeat(64)),
  ).toEqual({ packetScopeEvidence: 'unavailable' });
  lookups.tables[0].sha256 = 'invalid';
  expect(
    pairAccountProvenance(compiled, lookups, 4, keys[4], 'c'.repeat(64)),
  ).toEqual({ packetScopeEvidence: 'unavailable' });
});
