import bs58 from 'bs58';
import type { getCompiledTransactionMessageDecoder } from '@solana/kit';
type Message = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']
>;
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export function reviewSwapInstructions(
  message: Message,
  resolved?: { writable: string[]; readonly: string[] },
) {
  if (message.version !== 0)
    throw new Error('Unsupported instruction review version.');
  const accounts = message.staticAccounts.map((address, index) => ({
    index,
    address: String(address),
    lookup: null as string | null,
    signer: index < message.header.numSignerAccounts,
    writable:
      index < message.header.numSignerAccounts
        ? index <
          message.header.numSignerAccounts -
            message.header.numReadonlySignerAccounts
        : index <
          message.staticAccounts.length -
            message.header.numReadonlyNonSignerAccounts,
  }));
  const lookups =
    message.version === 0 ? (message.addressTableLookups ?? []) : [];
  if (resolved)
    for (const kind of ['writable', 'readonly'] as const) {
      const count = lookups.reduce(
        (sum, t) =>
          sum +
          (kind === 'writable' ? t.writableIndexes : t.readonlyIndexes).length,
        0,
      );
      if (
        resolved[kind].length !== count ||
        resolved[kind].some((a) => bs58.decode(a).length !== 32)
      )
        throw new Error('Incomplete resolved lookup accounts.');
    }
  for (const kind of ['writable', 'readonly'] as const) {
    let resolvedIndex = 0;
    for (const table of lookups)
      for (const index of kind === 'writable'
        ? table.writableIndexes
        : table.readonlyIndexes)
        accounts.push({
          index: accounts.length,
          address: resolved ? resolved[kind][resolvedIndex++] : '',
          lookup: `${table.lookupTableAddress} · ${kind} index ${index}`,
          signer: false,
          writable: kind === 'writable',
        });
  }
  const instructions = message.instructions.map((instruction, index) => {
    const program = accounts[instruction.programAddressIndex];
    const selected = Array.from(
      instruction.accountIndices ?? [],
      (i) => accounts[i],
    );
    if (!program || selected.some((a) => !a))
      throw new Error('Invalid instruction account index.');
    const bytes = Uint8Array.from(instruction.data ?? []);
    const view = new DataView(bytes.buffer);
    let action = 'Unrecognized instruction';
    let amountRaw: string | null = null,
      decimals: number | null = null;
    let newAuthority: string | null = null,
      authorityType: number | null = null;
    let recognized = false,
      changesAuthority = false;
    let roles: string[] = [];
    if (
      program.address === SYSTEM &&
      bytes.length === 12 &&
      view.getUint32(0, true) === 2 &&
      selected.length === 2
    ) {
      action = 'Native SOL transfer';
      amountRaw = view.getBigUint64(4, true).toString();
      recognized = true;
      roles = ['Source', 'Destination'];
    } else if (program.address === TOKEN || program.address === TOKEN_2022) {
      const tag = bytes[0];
      if (
        bytes.length === 9 &&
        selected.length >= 3 &&
        (tag === 3 || tag === 4)
      ) {
        action = tag === 3 ? 'Token transfer' : 'Token delegate approval';
        amountRaw = view.getBigUint64(1, true).toString();
        recognized = true;
        changesAuthority = tag === 4;
        roles = ['Source', tag === 3 ? 'Destination' : 'Delegate', 'Authority'];
      } else if (
        bytes.length === 10 &&
        selected.length >= 4 &&
        (tag === 12 || tag === 13)
      ) {
        action =
          tag === 12
            ? 'Checked token transfer'
            : 'Checked token delegate approval';
        amountRaw = view.getBigUint64(1, true).toString();
        decimals = bytes[9];
        recognized = true;
        changesAuthority = tag === 13;
        roles = [
          'Source',
          'Mint',
          tag === 12 ? 'Destination' : 'Delegate',
          'Authority',
        ];
      } else if (
        tag === 6 &&
        selected.length >= 2 &&
        bytes[1] <= 3 &&
        ((bytes.length === 3 && bytes[2] === 0) ||
          (bytes.length === 35 && bytes[2] === 1))
      ) {
        action = 'Token authority change';
        authorityType = bytes[1];
        newAuthority = bytes[2] === 1 ? bs58.encode(bytes.slice(3)) : null;
        recognized = true;
        changesAuthority = true;
        roles = ['Account or mint', 'Current authority'];
      } else if (bytes.length === 1 && selected.length >= 3 && tag === 9) {
        action = 'Token account closure';
        recognized = true;
        roles = ['Token account', 'Rent recipient', 'Authority'];
      } else if (bytes.length === 1 && selected.length === 1 && tag === 17) {
        action = 'Wrapped SOL synchronization';
        recognized = true;
        roles = ['Token account'];
      } else if (bytes.length === 1 && selected.length >= 2 && tag === 5) {
        action = 'Token delegate revocation';
        recognized = true;
        changesAuthority = true;
        roles = ['Token account', 'Authority'];
      }
    }
    return {
      index,
      program,
      accounts: selected.map((account, position) => ({
        ...account,
        role: roles[position] ?? `Additional account ${position + 1}`,
      })),
      action,
      recognized,
      changesAuthority,
      amountRaw,
      decimals,
      authorityType,
      newAuthority,
      dataHex: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
        '',
      ),
      dataBytes: bytes.length,
    };
  });
  return {
    instructionsVerified: false as const,
    executionAllowed: false as const,
    unresolvedAccountCount: accounts.filter((a) => !a.address).length,
    unrecognizedInstructionCount: instructions.filter((i) => !i.recognized)
      .length,
    authorityActionCount: instructions.filter((i) => i.changesAuthority).length,
    instructions,
    limitations:
      (!lookups.length
        ? 'No address-table lookups. '
        : resolved
          ? 'Lookup addresses independently observed. '
          : 'Lookup addresses unresolved. ') +
      'Top-level instruction layouts only. Account ownership, invoked inner instructions, route semantics, debit limits and token extensions are not verified. Recognition is not execution clearance.',
  };
}
export type SwapInstructionReview = ReturnType<typeof reviewSwapInstructions>;
