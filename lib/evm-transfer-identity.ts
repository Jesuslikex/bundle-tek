import { inspectEvmTokenIdentityAtBlock } from './evm-token-identity';
import { formatNativeBalance } from './wallet-balance-format';
import type { EvmTransactionObservation } from './tracked-evm-transaction';
export type TransferTokenIdentity = {
  contract: string;
  name: string;
  symbol: string;
  decimals: number;
  blockNumber: number;
  blockHash: string;
  observedAt: string;
  source: string;
};
export type TransferIdentityReport = {
  identities: TransferTokenIdentity[];
  unavailable: string[];
  observedAt: string;
};
export function transferEventAmount(
  raw: string,
  identity: TransferTokenIdentity,
) {
  if (
    !/^(0|[1-9]\d{0,77})$/.test(raw) ||
    BigInt(raw) > (1n << 256n) - 1n ||
    !Number.isInteger(identity.decimals) ||
    identity.decimals < 0 ||
    identity.decimals > 255
  )
    throw new Error('Invalid token event amount.');
  return formatNativeBalance(raw, identity.decimals);
}
export async function observeTransferIdentities(
  transaction: EvmTransactionObservation,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TransferIdentityReport> {
  if (
    !Array.isArray(transaction.transferEvents) ||
    transaction.transferEvents.length < 1 ||
    transaction.transferEvents.length > 100
  )
    throw new Error('Inspect token transfer events first.');
  const contracts = [
    ...new Set(transaction.transferEvents.map((e) => e.contract)),
  ];
  if (contracts.length > 20)
    throw new Error(
      'At most 20 distinct token identities can be inspected per transaction.',
    );
  const identities: TransferTokenIdentity[] = [],
    unavailable: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, contracts.length) }, async () => {
      while (next < contracts.length && !signal.aborted) {
        const contract = contracts[next++];
        try {
          const token = await inspectEvmTokenIdentityAtBlock(
            { chain: transaction.chain, address: contract },
            transaction,
            signal,
            fetcher,
          );
          identities.push({
            contract,
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals,
            blockNumber: token.blockNumber,
            blockHash: token.blockHash.toLowerCase(),
            observedAt: token.observedAt,
            source: token.source,
          });
        } catch {
          unavailable.push(contract);
        }
      }
    }),
  );
  signal.throwIfAborted();
  return {
    identities: contracts.flatMap((c) =>
      identities.filter((t) => t.contract === c),
    ),
    unavailable,
    observedAt: new Date().toISOString(),
  };
}
