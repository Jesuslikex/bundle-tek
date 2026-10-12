import { toHex } from 'viem';
import { EVM_NETWORKS, type EvmChain } from './evm-network';
import { walletAddress } from './wallet-workspace';

export type BrowserWalletProvider = {
  request: (args: {
    method:
      | 'eth_chainId'
      | 'eth_requestAccounts'
      | 'eth_accounts'
      | 'personal_sign';
    params?: unknown[];
  }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};
export function providerChain(value: unknown, chain: EvmChain) {
  if (
    typeof value !== 'string' ||
    value.length > 18 ||
    !/^0x[0-9a-f]+$/i.test(value) ||
    BigInt(value) !== BigInt(EVM_NETWORKS[chain].id)
  )
    throw new Error(
      `Switch your wallet to ${chain} (chain ${EVM_NETWORKS[chain].id}), then connect again.`,
    );
}
export function providerAccounts(value: unknown, chain: EvmChain) {
  if (!Array.isArray(value) || !value.length || value.length > 50)
    throw new Error('No wallet account is available.');
  return [...new Set(value.map((address) => walletAddress(address, chain)))];
}
export async function connectEvmWallet(
  provider: BrowserWalletProvider,
  chain: EvmChain,
  isCurrent: () => boolean = () => true,
) {
  providerChain(await provider.request({ method: 'eth_chainId' }), chain);
  if (!isCurrent()) throw new Error('Wallet connection cancelled.');
  const accounts = providerAccounts(
    await provider.request({ method: 'eth_requestAccounts' }),
    chain,
  );
  await assertAccount(provider, chain, accounts[0]);
  if (!isCurrent()) throw new Error('Wallet connection cancelled.');
  return accounts[0];
}
async function assertAccount(
  provider: BrowserWalletProvider,
  chain: EvmChain,
  address: string,
) {
  const [network, accounts] = await Promise.all([
    provider.request({ method: 'eth_chainId' }),
    provider.request({ method: 'eth_accounts' }),
  ]);
  providerChain(network, chain);
  if (!providerAccounts(accounts, chain).includes(address))
    throw new Error('The wallet account changed. Connect again.');
}
export async function signOwnershipMessage(
  provider: BrowserWalletProvider,
  chain: EvmChain,
  address: string,
  message: string,
  isCurrent: () => boolean = () => true,
) {
  await assertAccount(provider, chain, address);
  if (!isCurrent()) throw new Error('Wallet verification cancelled.');
  const signature = await provider.request({
    method: 'personal_sign',
    params: [toHex(message), address],
  });
  if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature))
    throw new Error('Wallet returned an unsupported message signature.');
  await assertAccount(provider, chain, address);
  if (!isCurrent()) throw new Error('Wallet verification cancelled.');
  return signature;
}
export function walletError(error: unknown) {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 4001
  )
    return 'Wallet request declined.';
  return error instanceof Error
    ? error.message.slice(0, 240)
    : 'Wallet request failed.';
}
