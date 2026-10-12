import { evmChain, EVM_NETWORKS, type EvmChain } from './evm-network';
import { walletAddress } from './wallet-workspace';
import { balanceRpc } from './wallet-balances';
import { formatNativeBalance } from './wallet-balance-format';

export type EvmHoldingsSnapshot = {
  chain: EvmChain;
  address: string;
  holdings: {
    contract: string;
    raw: string;
    decimals: number;
    amount: string;
  }[];
  blockNumber: number;
  blockHash: string;
  observedAt: string;
  source: string;
};
export function validateEvmHoldingsRequest(value: unknown) {
  if (!value || typeof value !== 'object')
    throw new Error('Choose a wallet and token contracts.');
  const body = value as Record<string, unknown>;
  const chain = evmChain(body.chain);
  const address = walletAddress(body.address, chain);
  if (
    !Array.isArray(body.contracts) ||
    body.contracts.length < 1 ||
    body.contracts.length > 20
  )
    throw new Error('Choose between 1 and 20 token contracts.');
  const contracts = body.contracts.map((contract) =>
    walletAddress(contract, chain),
  );
  if (new Set(contracts).size !== contracts.length)
    throw new Error('Remove duplicate token contracts.');
  return { chain, address, contracts };
}
function quantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,13})$/.test(value) ||
    BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Invalid holdings block quantity.');
  return Number(BigInt(value));
}
function abiUint(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('Incomplete ERC-20 response.');
  return BigInt(value);
}
export async function observeEvmHoldings(
  value: unknown,
  signal: AbortSignal = AbortSignal.timeout(25000),
  fetcher: typeof fetch = fetch,
): Promise<EvmHoldingsSnapshot> {
  const { chain, address, contracts } = validateEvmHoldingsRequest(value);
  const network = EVM_NETWORKS[chain];
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(network.endpoint, method, params, signal, fetcher);
  if (quantity(await rpc('eth_chainId', [])) !== network.id)
    throw new Error('Holdings provider network mismatch.');
  const header = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
    number?: unknown;
    hash?: unknown;
    timestamp?: unknown;
  };
  const blockNumber = quantity(header?.number);
  if (
    typeof header?.hash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(header.hash)
  )
    throw new Error('Invalid holdings block hash.');
  const blockHash = header.hash;
  const timestamp = quantity(header.timestamp) * 1000;
  if (timestamp < Date.now() - 900000 || timestamp > Date.now() + 300000)
    throw new Error('Holdings provider block is stale.');
  const reference = { blockHash, requireCanonical: true };
  const holdings: EvmHoldingsSnapshot['holdings'] = Array(contracts.length);
  let next = 0;
  // Four contract workers; every read uses the same canonical block hash.
  await Promise.all(
    Array.from({ length: Math.min(4, contracts.length) }, async () => {
      while (next < contracts.length) {
        const index = next++;
        const contract = contracts[index];
        const raw = abiUint(
          await rpc('eth_call', [
            {
              to: contract,
              data:
                '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0'),
              gas: '0x186a0',
            },
            reference,
          ]),
        ).toString();
        const decimals = abiUint(
          await rpc('eth_call', [
            { to: contract, data: '0x313ce567', gas: '0x186a0' },
            reference,
          ]),
        );
        if (decimals > 255n) throw new Error('Invalid ERC-20 decimals.');
        holdings[index] = {
          contract,
          raw,
          decimals: Number(decimals),
          amount: formatNativeBalance(raw, Number(decimals)),
        };
      }
    }),
  );
  const finalHeader = (await rpc('eth_getBlockByNumber', [
    header.number,
    false,
  ])) as { hash?: unknown };
  if (finalHeader?.hash !== blockHash)
    throw new Error('Holdings block changed.');
  return {
    chain,
    address,
    holdings,
    blockNumber,
    blockHash,
    observedAt: new Date().toISOString(),
    source: new URL(network.endpoint).hostname,
  };
}
