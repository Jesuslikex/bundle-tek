import {
  address,
  getAddressDecoder,
  type AddressesByLookupTableAddress,
} from '@solana/kit';
import type { PumpLaunchAccount } from './pump-launch-config';
const PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
/** Parses supplied observations only; the RPC collector must independently read and recheck them. */
export async function pumpLaunchLookupTables(
  tables: PumpLaunchAccount[],
  configurationSlots: number[],
) {
  if (
    !Array.isArray(tables) ||
    tables.length > 4 ||
    new Set(tables.map((t) => t.address)).size !== tables.length
  )
    throw new Error('Select at most four distinct launch address tables.');
  const slots = [...configurationSlots, ...tables.map((t) => t.slot)];
  if (
    !slots.length ||
    slots.some((s) => !Number.isSafeInteger(s) || s < 0) ||
    Math.max(...slots) - Math.min(...slots) > 32
  )
    throw new Error('Read consistent launch address table slots.');
  const mappings: AddressesByLookupTableAddress = {},
    observations = [];
  for (const table of tables) {
    const key = address(table.address),
      bytes = table.data;
    if (
      table.owner !== PROGRAM ||
      table.executable !== false ||
      !(bytes instanceof Uint8Array) ||
      bytes.length < 56 ||
      bytes.length > 8248 ||
      (bytes.length - 56) % 32
    )
      throw new Error('Launch address table account differs.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      count = (bytes.length - 56) / 32;
    const extended = view.getBigUint64(12, true),
      start = bytes[20],
      authority = bytes[21];
    if (
      view.getUint32(0, true) !== 1 ||
      view.getBigUint64(4, true) !== (1n << 64n) - 1n ||
      extended > BigInt(table.slot) ||
      start > count ||
      authority > 1 ||
      bytes.slice(authority === 1 ? 54 : 22, 56).some((b) => b !== 0)
    )
      throw new Error('Launch address table is not active or canonical.');
    const activeCount = extended === BigInt(table.slot) ? start : count;
    const decode = getAddressDecoder();
    mappings[key] = Array.from({ length: activeCount }, (_, n) =>
      decode.decode(bytes.subarray(56 + n * 32, 88 + n * 32)),
    );
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
    );
    observations.push({
      address: key,
      sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(
        '',
      ),
      slot: table.slot,
      lastExtendedSlot: extended.toString(),
      activeCount,
    });
  }
  return { mappings, observations };
}
