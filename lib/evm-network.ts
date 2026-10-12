export const EVM_NETWORKS = {
  Robinhood: {
    id: 4663,
    currency: 'ETH',
    endpoint: 'https://rpc.mainnet.chain.robinhood.com',
  },
  BNB: {
    id: 56,
    currency: 'BNB',
    endpoint: 'https://bsc-dataseed.bnbchain.org',
  },
  Arc: { id: 5042, currency: 'USDC', endpoint: 'https://rpc.mainnet.arc.io' },
  Ethereum: {
    id: 1,
    currency: 'ETH',
    endpoint: 'https://ethereum.reth.rs/rpc',
  },
  Base: { id: 8453, currency: 'ETH', endpoint: 'https://mainnet.base.org' },
} as const;
export type EvmChain = keyof typeof EVM_NETWORKS;
export function evmChain(value: unknown): EvmChain {
  if (typeof value !== 'string' || !Object.hasOwn(EVM_NETWORKS, value))
    throw new Error('Choose a supported EVM network.');
  return value as EvmChain;
}
