import { funderInTransaction, type BubbleFunder } from './bubble-map';
import { walletAddress } from './wallet-workspace';
import bs58 from 'bs58';

export type BubbleRpc = <T>(method: string, params: unknown[]) => Promise<T>;
type SignatureRow = { signature: string; slot: number; err: unknown };

const PAGE = 1000;
const MAX_PAGES = 3;
type Lookup = {
  funder: BubbleFunder | null;
  reason?: 'history-too-long' | 'history-unavailable' | 'funding-unavailable';
};
const validSignature = (value: unknown): value is string => {
  try {
    return (
      typeof value === 'string' &&
      value.length <= 90 &&
      bs58.decode(value).length === 64
    );
  } catch {
    return false;
  }
};

/**
 * Examines the oldest transaction in a bounded provider history. An empty
 * terminal page is required, but does not prove the provider has full history.
 * Missing or unsupported evidence stays unknown; never substitute a later tx.
 */
export async function findFirstFunder(
  address: string,
  rpc: BubbleRpc,
): Promise<Lookup> {
  if (walletAddress(address, 'Solana') !== address)
    throw new Error('Wallet address differs.');
  let before: string | undefined;
  let oldest: SignatureRow | undefined;
  let prior: SignatureRow | undefined;
  let previousSlot = Number.MAX_SAFE_INTEGER;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    const rows = await rpc<SignatureRow[]>('getSignaturesForAddress', [
      address,
      { limit: PAGE, commitment: 'finalized', ...(before ? { before } : {}) },
    ]);
    if (!Array.isArray(rows) || rows.length > PAGE)
      throw new Error('Signature history differs.');
    if (!rows.length) break;
    if (page >= MAX_PAGES) return { funder: null, reason: 'history-too-long' };
    for (const row of rows) {
      if (
        !row ||
        !validSignature(row.signature) ||
        !Number.isSafeInteger(row.slot) ||
        row.slot < 0 ||
        row.slot > previousSlot ||
        seen.has(row.signature) ||
        !(
          row.err === null ||
          typeof row.err === 'string' ||
          (typeof row.err === 'object' && !Array.isArray(row.err))
        )
      )
        throw new Error('Signature history differs.');
      seen.add(row.signature);
      previousSlot = row.slot;
      prior = oldest;
      oldest = row;
    }
    before = rows[rows.length - 1].signature;
  }
  if (!oldest) return { funder: null, reason: 'history-unavailable' };
  // Without a transaction index, equal oldest slots cannot prove tx ordering.
  if (oldest.err !== null || prior?.slot === oldest.slot)
    return { funder: null, reason: 'funding-unavailable' };
  const tx = await rpc<Parameters<typeof funderInTransaction>[0]>(
    'getTransaction',
    [
      oldest.signature,
      {
        encoding: 'jsonParsed',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      },
    ],
  );
  if (
    !tx ||
    tx.slot !== oldest.slot ||
    tx.transaction?.signatures?.[0] !== oldest.signature
  )
    return { funder: null, reason: 'funding-unavailable' };
  const funder = funderInTransaction(tx, address);
  return funder ? { funder } : { funder: null, reason: 'funding-unavailable' };
}

export async function findFunders(
  addresses: string[],
  rpc: BubbleRpc,
  concurrency = 4,
) {
  if (
    !Array.isArray(addresses) ||
    addresses.length < 1 ||
    addresses.length > 50 ||
    new Set(addresses).size !== addresses.length ||
    addresses.some((a) => walletAddress(a, 'Solana') !== a) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4
  )
    throw new Error('Funding lookup scope differs.');
  const out: Record<string, Lookup> = {};
  let next = 0;
  let stopped = false;
  let failure: unknown;
  const guardedRpc: BubbleRpc = (method, params) => {
    if (stopped) return Promise.reject(new Error('Funding lookup stopped.'));
    return rpc(method, params);
  };
  await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, addresses.length) },
      async () => {
        while (!stopped && next < addresses.length) {
          const address = addresses[next++];
          try {
            const result = await findFirstFunder(address, guardedRpc);
            if (!stopped) out[address] = result;
          } catch (error) {
            if (!stopped) {
              stopped = true;
              failure = error;
            }
          }
        }
      },
    ),
  );
  if (stopped) throw failure;
  return out;
}
