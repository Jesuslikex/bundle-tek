import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { DEVNET_GENESIS_HASH } from './devnet-intent';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { transactionSignature } from './tracked-wallet-transaction';
export type SignatureCursor = {
  signature: string;
  slot: number;
  anchor: number;
};
export type SignaturePage = {
  address: string;
  network: 'mainnet' | 'devnet';
  source: string;
  observedAt: string;
  anchor: number;
  signatures: Array<{
    signature: string;
    slot: number;
    blockTime: number | null;
    failed: boolean;
  }>;
  nextCursor: string | null;
};
function uint(value: unknown): number {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error('Invalid integer.');
  return Number(value);
}
export function signatureCursor(raw: string | null): SignatureCursor | null {
  if (raw === null) return null;
  if (raw.length > 220) throw new Error('Invalid cursor.');
  const value = JSON.parse(raw) as SignatureCursor;
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < 0 ||
    !Number.isSafeInteger(value.anchor) ||
    value.anchor < value.slot
  )
    throw new Error('Invalid cursor.');
  return {
    signature: transactionSignature(value.signature),
    slot: value.slot,
    anchor: value.anchor,
  };
}
export async function observeSignaturePage(
  address: string,
  network: 'mainnet' | 'devnet',
  cursor: SignatureCursor | null,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SignaturePage> {
  const endpoint = getSolanaRpcEndpoint(network);
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
  if (
    (await rpc('getGenesisHash', [])) !==
    (network === 'mainnet' ? SOLANA_MAINNET_GENESIS : DEVNET_GENESIS_HASH)
  )
    throw new Error('Wrong network.');
  const current = uint(await rpc('getSlot', [{ commitment: 'finalized' }]));
  const anchor = cursor?.anchor ?? current;
  if (current < anchor) throw new Error('Provider behind retained context.');
  const raw = await rpc('getSignaturesForAddress', [
    address,
    {
      commitment: 'finalized',
      limit: 25,
      minContextSlot: anchor,
      ...(cursor ? { before: cursor.signature } : {}),
    },
  ]);
  if (!Array.isArray(raw) || raw.length > 25)
    throw new Error('Invalid signature page.');
  let previous = cursor?.slot ?? anchor;
  const signatures = raw.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid signature.');
    const signature = transactionSignature(row.signature),
      slot = uint(row.slot);
    if (
      slot > previous ||
      slot > anchor ||
      signature === cursor?.signature ||
      row.err === undefined
    )
      throw new Error('Invalid signature boundary.');
    previous = slot;
    const blockTime = row.blockTime === null ? null : uint(row.blockTime);
    if (blockTime !== null && blockTime > Date.now() / 1000 + 60)
      throw new Error('Invalid time.');
    return { signature, slot, blockTime, failed: row.err !== null };
  });
  if (new Set(signatures.map((r) => r.signature)).size !== signatures.length)
    throw new Error('Duplicate signatures.');
  const last = signatures.at(-1);
  return {
    address,
    network,
    source: new URL(endpoint).hostname,
    observedAt: new Date().toISOString(),
    anchor,
    signatures,
    nextCursor:
      signatures.length === 25 && last
        ? JSON.stringify({ signature: last.signature, slot: last.slot, anchor })
        : null,
  };
}
