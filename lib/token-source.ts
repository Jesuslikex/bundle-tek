import bs58 from 'bs58';
import { EVM_NETWORKS, type EvmChain } from './evm-network';
import { getAddress, isAddress } from 'viem';
export type TokenSource = { chain: 'Solana' | EvmChain; address: string };
export function validateTokenSource(value: unknown): TokenSource {
  if (!value || typeof value !== 'object')
    throw new Error('Choose a token network and address.');
  const body = value as Record<string, unknown>;
  if (typeof body.address !== 'string' || body.address.length > 44)
    throw new Error('Invalid token address.');
  if (
    typeof body.chain === 'string' &&
    Object.hasOwn(EVM_NETWORKS, body.chain) &&
    /^0x[0-9a-fA-F]{40}$/.test(body.address)
  ) {
    try {
      if (!isAddress(body.address, { strict: true })) throw new Error();
      return {
        chain: body.chain as EvmChain,
        address: getAddress(body.address),
      };
    } catch {
      throw new Error('Invalid contract address checksum.');
    }
  }
  if (body.chain === 'Solana') {
    try {
      if (bs58.decode(body.address).length === 32)
        return { chain: 'Solana', address: body.address };
    } catch {
      /* Invalid base58. */
    }
  }
  throw new Error(
    'Choose Solana with a valid mint or a supported EVM network with a valid contract address.',
  );
}
