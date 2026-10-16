import { stockPairRpcScope } from './pair-stock-clock';
import { readPairPartitionObservation } from './pair-partition-observation';
import bs58 from 'bs58';
import type { getCompiledTransactionMessageDecoder } from '@solana/kit';
type Message = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']
>;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
function slot(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,15})$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error('Invalid lookup observation slot.');
  return Number(value);
}
export async function readSwapLookupAccounts(
  message: Message,
  minContextSlot: number,
  rpc: Rpc,
) {
  if (message.version !== 0) throw new Error('Unsupported lookup message.');
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0)
    throw new Error('Invalid minimum lookup slot.');
  const lookups = message.addressTableLookups ?? [];
  if (!lookups.length) return null;
  if (
    lookups.length > 32 ||
    new Set(lookups.map((t) => t.lookupTableAddress)).size !== lookups.length
  )
    throw new Error('Invalid lookup table selection.');
  let result: { context?: { slot?: unknown }; value?: unknown[] },
    values: unknown;
  const scope = stockPairRpcScope(rpc);
  if (scope?.accountLimit === 5 && lookups.length > 5) {
    if (!scope.signal) throw Error('Stock lifecycle signal is missing.');
    const observation = await readPairPartitionObservation(
      lookups.map((t) => String(t.lookupTableAddress)),
      minContextSlot,
      rpc,
      scope.signal,
      scope.now,
    );
    result = observation.clockResponse;
    values = observation.values;
  } else {
    result = (await rpc('getMultipleAccounts', [
      lookups.map((t) => t.lookupTableAddress),
      { encoding: 'base64', commitment: 'confirmed', minContextSlot },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    values = result?.value;
  }
  const observedSlot = slot(result?.context?.slot);
  if (
    observedSlot < minContextSlot ||
    observedSlot - minContextSlot > 32 ||
    !Array.isArray(values) ||
    values.length !== lookups.length
  )
    throw new Error('Inconsistent lookup observations.');
  const tables = [];
  for (let i = 0; i < lookups.length; i++) {
    const account = values[i] as {
      owner?: unknown;
      executable?: unknown;
      data?: unknown;
    };
    if (
      !account ||
      account.owner !== PROGRAM ||
      account.executable !== false ||
      !Array.isArray(account.data) ||
      account.data.length !== 2 ||
      account.data[1] !== 'base64' ||
      typeof account.data[0] !== 'string' ||
      account.data[0].length > 11000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        account.data[0],
      )
    )
      throw new Error('Invalid lookup table account.');
    const bytes = Uint8Array.from(atob(account.data[0]), (c) =>
      c.charCodeAt(0),
    );
    if (
      btoa(String.fromCharCode(...bytes)) !== account.data[0] ||
      bytes.length < 56 ||
      bytes.length > 8248 ||
      (bytes.length - 56) % 32
    )
      throw new Error('Invalid lookup table bytes.');
    const view = new DataView(bytes.buffer),
      count = (bytes.length - 56) / 32;
    const extended = view.getBigUint64(12, true),
      start = bytes[20],
      authority = bytes[21];
    if (
      view.getUint32(0, true) !== 1 ||
      view.getBigUint64(4, true) !== (1n << 64n) - 1n ||
      extended > BigInt(observedSlot) ||
      start > count ||
      authority > 1 ||
      bytes.slice(authority === 1 ? 54 : 22, 56).some((v) => v !== 0)
    )
      throw new Error('Unsupported lookup table state.');
    const activeCount = extended === BigInt(observedSlot) ? start : count;
    const resolve = (indexes: readonly number[]) =>
      indexes.map((index) => {
        if (!Number.isInteger(index) || index < 0 || index >= activeCount)
          throw new Error('Lookup index is not active.');
        return bs58.encode(bytes.slice(56 + 32 * index, 88 + 32 * index));
      });
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
    tables.push({
      address: String(lookups[i].lookupTableAddress),
      sha256: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''),
      lastExtendedSlot: extended.toString(),
      writable: resolve(lookups[i].writableIndexes),
      readonly: resolve(lookups[i].readonlyIndexes),
    });
  }
  return {
    observedSlot,
    tables,
    writable: tables.flatMap((t) => t.writable),
    readonly: tables.flatMap((t) => t.readonly),
  };
}
export function assertSameSwapLookups(
  before: NonNullable<Awaited<ReturnType<typeof readSwapLookupAccounts>>>,
  after: Awaited<ReturnType<typeof readSwapLookupAccounts>>,
  loaded: unknown,
) {
  if (
    !after ||
    before.tables.length !== after.tables.length ||
    before.tables.some(
      (table, i) =>
        table.address !== after.tables[i].address ||
        table.sha256 !== after.tables[i].sha256,
    )
  )
    throw new Error('Lookup table changed during simulation.');
  if (loaded != null) {
    const value = loaded as { writable?: unknown; readonly?: unknown };
    for (const kind of ['writable', 'readonly'] as const)
      if (
        !Array.isArray(value[kind]) ||
        JSON.stringify(value[kind]) !== JSON.stringify(before[kind])
      )
        throw new Error('Simulation lookup addresses mismatch.');
  }
}
