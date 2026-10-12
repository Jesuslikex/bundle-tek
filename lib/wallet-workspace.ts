import bs58 from 'bs58';
import { getAddress, isAddress } from 'viem';
import { CHAINS, type LaunchChain } from './launch-plan';
import type { WalletBalance } from './wallet-balances';

export const WALLET_ROLES = ['Recipient', 'Deployer', 'Funder'] as const;
export type WalletRole = (typeof WALLET_ROLES)[number];
export type WalletFolder = {
  id: string;
  name: string;
  color?: string;
  chain: LaunchChain;
  archived: boolean;
  revision: number;
  updatedAt: string;
};
export const FOLDER_COLORS = [
  '#A6B1FF',
  '#CD7F32',
  '#4EA8A5',
  '#7E4EA8',
  '#4FA671',
  '#F0B90B',
  '#ED5B5E',
] as const;
export const DEFAULT_FOLDER_COLOR = FOLDER_COLORS[0];
export function walletFolderColor(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
    throw new Error('Choose a six-digit folder color.');
  return value.toUpperCase();
}
export type WorkspaceWallet = {
  chain: LaunchChain;
  address: string;
  folderId: string;
  folderIds?: string[];
  label: string;
  tags?: string[];
  role: WalletRole;
  archived: boolean;
  revision: number;
  updatedAt: string;
};
export type WalletWorkspace = {
  folders: WalletFolder[];
  wallets: WorkspaceWallet[];
  balances?: WalletBalance[];
  proofs?: { chain: LaunchChain; address: string; verifiedAt: string }[];
};
export const MAX_WORKSPACE_WALLETS = 500;
export function walletFolderIds(
  wallet: Pick<WorkspaceWallet, 'folderId' | 'folderIds'>,
) {
  return wallet.folderIds ?? (wallet.folderId ? [wallet.folderId] : []);
}
export function activeWalletFolders(
  wallet: WorkspaceWallet,
  folders: WalletFolder[],
) {
  const ids = walletFolderIds(wallet);
  return folders.filter(
    (folder) =>
      folder.chain === wallet.chain &&
      !folder.archived &&
      ids.includes(folder.id),
  );
}
export const MAX_WALLET_FOLDERS = 100;
export function walletChain(value: unknown): LaunchChain {
  if (typeof value !== 'string' || !CHAINS.some((chain) => chain === value))
    throw new Error('Choose a supported network.');
  return value as LaunchChain;
}
export function walletAddress(value: unknown, chain: LaunchChain) {
  if (typeof value !== 'string' || value.length > 44)
    throw new Error('Enter a public wallet address.');
  const address = value.trim();
  if (chain === 'Solana') {
    try {
      if (bs58.decode(address).length === 32) return address;
    } catch {
      /* invalid base58 */
    }
  } else if (isAddress(address) && !/^0x0{40}$/i.test(address))
    return getAddress(address);
  throw new Error(`Enter a valid ${chain} public address.`);
}
export function walletText(
  value: unknown,
  label: string,
  max: number,
  required = false,
) {
  if (
    typeof value !== 'string' ||
    value.trim().length > max ||
    value
      .split('')
      .some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
    (required && !value.trim())
  )
    throw new Error(
      `${label} must ${required ? 'have 1 to' : 'have at most'} ${max} characters without control characters.`,
    );
  return value.trim();
}
export function folderId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
    throw new Error('Invalid folder.');
  return value;
}
export function walletTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10)
    throw new Error('Use up to 10 wallet tags.');
  const seen = new Set<string>();
  return value
    .map((tag) => walletText(tag, 'Tag', 30, true))
    .filter((tag) => {
      if (tag.includes(',')) throw new Error('Tags cannot contain commas.');
      const normalized = tag.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}
export function walletRole(value: unknown): WalletRole {
  if (!WALLET_ROLES.some((role) => role === value))
    throw new Error('Choose a wallet role.');
  return value as WalletRole;
}
export function walletRevision(value: unknown) {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('Invalid wallet revision.');
  return value as number;
}
export function workspaceWalletBatch(value: unknown, chain: LaunchChain) {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new Error('Add between 1 and 100 public addresses.');
  const entries = value.map(
    (raw: {
      address?: unknown;
      label?: unknown;
      role?: unknown;
      tags?: unknown;
    }) => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid wallet.');
      return {
        address: walletAddress(raw.address, chain),
        label: walletText(raw.label ?? '', 'Label', 60),
        tags: walletTags(raw.tags ?? []),
        role: walletRole(raw.role ?? 'Recipient'),
      };
    },
  );
  if (new Set(entries.map((entry) => entry.address)).size !== entries.length)
    throw new Error('Remove duplicate addresses from this batch.');
  return entries;
}
