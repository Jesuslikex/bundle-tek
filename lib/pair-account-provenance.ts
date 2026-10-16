import type { getCompiledTransactionMessageDecoder } from '@solana/kit';
import type { readSwapLookupAccounts } from './swap-lookup-accounts';
import type { PairDiagnosticDetails } from './pair-review-diagnostic';

type Message = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']
>;
type Lookups = Awaited<ReturnType<typeof readSwapLookupAccounts>>;

/** Private diagnosis only. Never supplies privileges, alters a packet or grants account acceptance. */
export function pairAccountProvenance(
  message: Message,
  lookups: Lookups,
  index: number,
  expectedAddress: string,
  packetSha256: string,
): PairDiagnosticDetails {
  try {
    const statics = message.staticAccounts.map(String),
      writable = lookups?.writable ?? [],
      readonly = lookups?.readonly ?? [];
    const keys = [...statics, ...writable, ...readonly],
      header = message.header;
    if (
      message.version !== 0 ||
      !/^[a-f0-9]{64}$/.test(packetSha256) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= keys.length ||
      keys.length > 256 ||
      keys[index] !== expectedAddress ||
      new Set(keys).size !== keys.length ||
      header.numSignerAccounts > statics.length ||
      header.numReadonlySignerAccounts > header.numSignerAccounts ||
      header.numReadonlyNonSignerAccounts >
        statics.length - header.numSignerAccounts ||
      message.instructions.length > 256
    )
      throw Error();
    const source =
      index < statics.length
        ? 'static'
        : index < statics.length + writable.length
          ? 'lookup-writable'
          : 'lookup-readonly';
    const signer = index < header.numSignerAccounts;
    const declaredWritable =
      source === 'static'
        ? signer
          ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
          : index < statics.length - header.numReadonlyNonSignerAccounts
        : source === 'lookup-writable';
    const references = message.instructions.flatMap((ix, instructionIndex) => {
      const positions = (ix.accountIndices ?? []).flatMap(
        (accountIndex, position) => (accountIndex === index ? [position] : []),
      );
      return ix.programAddressIndex === index || positions.length
        ? [
            {
              instructionIndex,
              asProgram: ix.programAddressIndex === index,
              accountPositions: positions,
            },
          ]
        : [];
    });
    const referenceText = JSON.stringify(references);
    if (referenceText.length > 16384) throw Error();
    const result: PairDiagnosticDetails = {
      packetScopeEvidence: 'available',
      packetSha256,
      compiledAccountIndex: index,
      compiledAccountSource: source,
      declaredWritable,
      declaredSigner: signer,
      staticAccountCount: statics.length,
      loadedWritableCount: writable.length,
      loadedReadonlyCount: readonly.length,
      instructionReferences: referenceText,
    };
    if (source !== 'static') {
      const kind = source === 'lookup-writable' ? 'writable' : 'readonly';
      let offset =
        index - statics.length - (kind === 'readonly' ? writable.length : 0);
      const declared = message.addressTableLookups ?? [];
      if (
        !lookups ||
        declared.length !== lookups.tables.length ||
        JSON.stringify(lookups.tables.flatMap((t) => t[kind])) !==
          JSON.stringify(lookups[kind])
      )
        throw Error();
      let found = false;
      for (const [tableIndex, table] of lookups.tables.entries()) {
        const indexes =
          kind === 'writable'
            ? declared[tableIndex].writableIndexes
            : declared[tableIndex].readonlyIndexes;
        if (
          String(declared[tableIndex].lookupTableAddress) !== table.address ||
          indexes.length !== table[kind].length
        )
          throw Error();
        if (!found && offset < table[kind].length) {
          if (
            table[kind][offset] !== expectedAddress ||
            !/^[a-f0-9]{64}$/.test(table.sha256)
          )
            throw Error();
          Object.assign(result, {
            lookupTableAddress: table.address,
            lookupTableSha256: table.sha256,
            lookupEntryIndex: indexes[offset],
            lookupObservedSlot: lookups.observedSlot,
          });
          found = true;
        } else if (!found) offset -= table[kind].length;
      }
      if (!found) throw Error();
    }
    return result;
  } catch {
    // A missing diagnosis must never replace the original refusal or invent history.
    return { packetScopeEvidence: 'unavailable' };
  }
}
