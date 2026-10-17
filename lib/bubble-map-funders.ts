import { funderInTransaction, type BubbleFunder } from './bubble-map';

export type BubbleRpc = <T>(method: string, params: unknown[]) => Promise<T>;
type SignatureRow = { signature: string; slot: number; err: unknown };

const PAGE = 1000;
const MAX_PAGES = 3;
const OLDEST_TRIES = 4;

/**
 * Walks a wallet's history back to its oldest signatures and returns the first
 * wallet that sent it SOL. Wallets with more than 3000 transactions are reported
 * as unknown rather than guessed.
 */
export async function findFirstFunder(
  address: string,
  rpc: BubbleRpc,
): Promise<{ funder: BubbleFunder | null; reason?: 'history-too-long' }> {
  let before: string | undefined;
  let oldest: SignatureRow[] = [];
  for (let page = 0; ; page++) {
    const rows = await rpc<SignatureRow[]>('getSignaturesForAddress', [
      address,
      { limit: PAGE, commitment: 'finalized', ...(before ? { before } : {}) },
    ]);
    if (!Array.isArray(rows) || rows.length > PAGE)
      throw new Error('Signature history differs.');
    if (rows.length) oldest = rows;
    if (rows.length < PAGE) break;
    if (page + 1 >= MAX_PAGES)
      return { funder: null, reason: 'history-too-long' };
    before = rows[rows.length - 1].signature;
  }
  const candidates = oldest
    .filter((r) => !r.err)
    .slice(-OLDEST_TRIES)
    .reverse();
  for (const row of candidates) {
    const tx = await rpc<Parameters<typeof funderInTransaction>[0]>(
      'getTransaction',
      [
        row.signature,
        {
          encoding: 'jsonParsed',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        },
      ],
    );
    const funder = funderInTransaction(tx, address);
    if (funder) return { funder };
  }
  return { funder: null };
}

export async function findFunders(
  addresses: string[],
  rpc: BubbleRpc,
  concurrency = 4,
) {
  const out: Record<
    string,
    { funder: BubbleFunder | null; reason?: 'history-too-long' }
  > = {};
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, addresses.length) },
      async () => {
        while (next < addresses.length) {
          const address = addresses[next++];
          out[address] = await findFirstFunder(address, rpc);
        }
      },
    ),
  );
  return out;
}
