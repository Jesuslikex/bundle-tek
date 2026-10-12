import bs58 from 'bs58';
import { getAddress, isAddress } from 'viem';
import { EVM_NETWORKS, type EvmChain } from './evm-network';
export type TrackerNetwork = 'mainnet' | 'devnet' | EvmChain;

export type TrackedWallet = {
  address: string;
  network: TrackerNetwork;
  label: string;
  group: string;
  icon: string;
  favorite: boolean;
  archived: boolean;
  updatedAt: string;
};
export const MAX_TRACKED_WALLETS = 100;
export const WALLET_ICONS = ['⭐', '👀', '🐋', '🚀', '🌱', '🔬'] as const;
export type SolanaTrackedWallet = TrackedWallet & {
  network: 'mainnet' | 'devnet';
};
export function isSolanaTrackedWallet(
  wallet: TrackedWallet,
): wallet is SolanaTrackedWallet {
  return wallet.network === 'mainnet' || wallet.network === 'devnet';
}
export const trackerNetworkLabel = (network: TrackerNetwork) =>
  network === 'mainnet' || network === 'devnet'
    ? `Solana ${network}`
    : `${network} mainnet`;
export function validateSolanaTrackedWallet(value: unknown) {
  const wallet = validateTrackedWallet(value);
  if (wallet.network !== 'mainnet' && wallet.network !== 'devnet')
    throw new Error('Choose a Solana tracker network.');
  return { ...wallet, network: wallet.network };
}

export function validateTrackedWallet(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid wallet.');
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.network !== 'string' ||
    !(
      raw.network === 'mainnet' ||
      raw.network === 'devnet' ||
      Object.hasOwn(EVM_NETWORKS, raw.network)
    )
  )
    throw new Error('Choose a supported tracker network.');
  if (typeof raw.address !== 'string' || raw.address.length > 44)
    throw new Error('Enter a public address for the selected network.');
  let address = raw.address.trim();
  if (raw.network === 'mainnet' || raw.network === 'devnet') {
    try {
      if (bs58.decode(address).length !== 32) throw new Error();
    } catch {
      throw new Error('Enter a Solana public address.');
    }
  } else {
    if (!isAddress(address, { strict: true }))
      throw new Error('Enter a valid EVM address with a correct checksum.');
    address = getAddress(address);
  }
  if (
    typeof raw.label !== 'string' ||
    raw.label.trim().length > 60 ||
    raw.label.split('').some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error(
      'Label must be under 61 characters and contain no control characters.',
    );
  const group = raw.group ?? '';
  const icon = raw.icon ?? '⭐';
  const favorite = raw.favorite ?? false;
  if (
    typeof group !== 'string' ||
    group.trim().length > 40 ||
    group.split('').some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error(
      'Group must be under 41 characters without control characters.',
    );
  if (typeof icon !== 'string' || !WALLET_ICONS.some((i) => i === icon))
    throw new Error('Choose a supported wallet icon.');
  if (typeof favorite !== 'boolean')
    throw new Error('Favorite must be true or false.');
  return {
    address,
    network: raw.network,
    label: raw.label.trim(),
    group: group.trim(),
    icon,
    favorite,
  } as Pick<
    TrackedWallet,
    'address' | 'network' | 'label' | 'group' | 'icon' | 'favorite'
  >;
}

export function validateWalletBatch(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_TRACKED_WALLETS
  )
    throw new Error('Add between 1 and 100 public addresses.');
  const wallets = value.map(validateTrackedWallet);
  if (
    new Set(wallets.map((w) => `${w.network}:${w.address}`)).size !==
    wallets.length
  )
    throw new Error('Remove duplicate addresses from this batch.');
  return wallets;
}

export type WalletObservation = {
  address: string;
  network: 'mainnet' | 'devnet';
  observedAt: string;
  slot: number;
  balanceSol: number;
  signatures: Array<{
    signature: string;
    slot: number;
    blockTime: number | null;
    failed: boolean;
  }>;
};
