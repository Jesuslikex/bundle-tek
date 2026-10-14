import bs58 from 'bs58';
import { address } from '@solana/kit';
import {
  buildPumpCreateMessage,
  type PumpCreateInput,
} from './pump-launch-message';
import { pumpLaunchLookupTables } from './pump-launch-lookups';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import type { PumpLaunchAccount } from './pump-launch-config';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
const integer = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,15})$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error('Launch lookup observation slot differs.');
  return Number(value);
};
/** Bounded public-history discovery. A candidate is not an execution approval. */
export async function discoverPumpLaunchLookups(
  create: PumpCreateInput,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const built = await buildPumpCreateMessage(create),
    minimum = built.configurationSlotMax;
  let calls = 0;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  async function call(method: string, params: unknown[]) {
    deadline.throwIfAborted();
    if (++calls > 8) throw new Error('Launch lookup read budget exceeded.');
    const result = await new Promise<unknown>((resolve, reject) => {
      const abort = () =>
        reject(new Error('Launch lookup was cancelled or timed out.'));
      if (deadline.aborted) {
        abort();
        return;
      }
      deadline.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => rpc(method, params, deadline))
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener('abort', abort));
    });
    deadline.throwIfAborted();
    return result;
  }
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Launch lookup RPC is not mainnet.');
  const recent = await call('getSignaturesForAddress', [
    built.instruction.accounts![4].address,
    { limit: 8, commitment: 'confirmed', minContextSlot: minimum },
  ]);
  if (!Array.isArray(recent) || recent.length > 8)
    throw new Error('Launch lookup history is unavailable.');
  const signatures: string[] = [];
  for (const item of recent) {
    if (
      !item ||
      typeof item !== 'object' ||
      item.err !== null ||
      typeof item.signature !== 'string'
    )
      continue;
    try {
      if (bs58.decode(item.signature).length !== 64) continue;
    } catch {
      continue;
    }
    if (!signatures.includes(item.signature)) signatures.push(item.signature);
    if (signatures.length === 4) break;
  }
  const candidates: string[] = [];
  let unavailableTransactions = 0;
  for (const signature of signatures) {
    let transaction: unknown;
    try {
      transaction = await call('getTransaction', [
        signature,
        {
          encoding: 'json',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 1,
        },
      ]);
    } catch {
      deadline.throwIfAborted();
      unavailableTransactions++;
      continue;
    }
    const tx = transaction as {
      version?: unknown;
      meta?: { err?: unknown };
      transaction?: {
        signatures?: unknown[];
        message?: { addressTableLookups?: Array<{ accountKey?: unknown }> };
      };
    };
    if (
      !tx ||
      !['legacy', '0', '1', 0, 1].includes(tx.version as string | number) ||
      tx.meta?.err !== null ||
      tx.transaction?.signatures?.[0] !== signature
    ) {
      unavailableTransactions++;
      continue;
    }
    const lookups = tx.transaction.message?.addressTableLookups;
    if (lookups === undefined || lookups === null) continue;
    if (!Array.isArray(lookups) || lookups.length > 32) {
      unavailableTransactions++;
      continue;
    }
    for (const lookup of lookups) {
      if (
        !lookup ||
        typeof lookup !== 'object' ||
        typeof lookup.accountKey !== 'string'
      )
        continue;
      try {
        address(lookup.accountKey);
      } catch {
        continue;
      }
      if (!candidates.includes(lookup.accountKey) && candidates.length < 8)
        candidates.push(lookup.accountKey);
    }
  }
  const tables: PumpLaunchAccount[] = [];
  let observedSlot = minimum,
    rejectedTables = 0;
  if (candidates.length) {
    const snapshot = (await call('getMultipleAccounts', [
      candidates,
      { encoding: 'base64', commitment: 'confirmed', minContextSlot: minimum },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    observedSlot = integer(snapshot?.context?.slot);
    if (
      observedSlot < minimum ||
      observedSlot - minimum > 32 ||
      !Array.isArray(snapshot.value) ||
      snapshot.value.length !== candidates.length
    )
      throw new Error('Launch lookup snapshot differs.');
    for (const [index, value] of snapshot.value.entries()) {
      const a = value as {
        owner?: unknown;
        executable?: unknown;
        data?: unknown;
      };
      if (
        !a ||
        typeof a.owner !== 'string' ||
        a.executable !== false ||
        !Array.isArray(a.data) ||
        a.data.length !== 2 ||
        a.data[1] !== 'base64' ||
        typeof a.data[0] !== 'string' ||
        a.data[0].length > 11000
      ) {
        rejectedTables++;
        continue;
      }
      try {
        const data = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
        if (btoa(String.fromCharCode(...data)) !== a.data[0])
          throw new Error('Noncanonical table bytes.');
        const table = {
          address: candidates[index],
          owner: a.owner,
          executable: false,
          data,
          slot: observedSlot,
        };
        await pumpLaunchLookupTables(
          [table],
          [built.configurationSlotMin, minimum],
        );
        tables.push(table);
      } catch {
        rejectedTables++;
      }
    }
  }
  // Prefer tables that compress the stable create accounts; the packet builder enforces its final byte limit.
  const wanted = new Set(
    built.instruction
      .accounts!.map((a) => String(a.address))
      .filter((key) => key !== create.payer && key !== create.mint),
  );
  const ranked = await Promise.all(
    tables.map(async (table) => {
      const parsed = await pumpLaunchLookupTables(
        [table],
        [built.configurationSlotMin, minimum],
      );
      return {
        table,
        score: parsed.mappings[address(table.address)].filter((key) =>
          wanted.has(key),
        ).length,
      };
    }),
  );
  ranked.sort(
    (a, b) =>
      b.score - a.score || a.table.address.localeCompare(b.table.address),
  );
  return {
    tables: ranked
      .filter((r) => r.score >= 2)
      .slice(0, 4)
      .map((r) => r.table),
    observedSlot,
    reads: calls,
    historyLimit: 8,
    transactionsInspected: signatures.length,
    unavailableTransactions,
    candidates: candidates.length,
    rejectedTables,
    coverage: 'bounded-public-history' as const,
    executionAllowed: false as const,
  };
}
