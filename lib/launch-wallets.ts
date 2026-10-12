import {
  walletAddress,
  walletChain,
  walletRevision,
  folderId,
  walletFolderIds,
  activeWalletFolders,
  type WalletWorkspace,
  type WorkspaceWallet,
} from './wallet-workspace';
import type { LaunchChain } from './launch-plan';
export type LaunchWalletRef = {
  address: string;
  revision: number;
  folderRevision: number;
  folderId?: string;
  root?: true;
};
export type LaunchWalletAssignments = {
  chain: LaunchChain;
  deployer?: LaunchWalletRef;
  recipients: LaunchWalletRef[];
};
export function parseLaunchWalletAssignments(
  value: unknown,
): LaunchWalletAssignments | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid launch wallet selection.');
  const raw = value as LaunchWalletAssignments;
  const chain = walletChain(raw.chain);
  const ref = (v: LaunchWalletRef): LaunchWalletRef => {
    if (!v || typeof v !== 'object')
      throw new Error('Invalid launch wallet reference.');
    if (
      v.root !== undefined &&
      (v.root !== true || v.folderId !== undefined || v.folderRevision !== 0)
    )
      throw new Error('Invalid parent wallet reference.');
    return {
      address: walletAddress(v.address, chain),
      revision: walletRevision(v.revision),
      folderRevision:
        v.folderRevision === 0 && v.folderId === undefined
          ? 0
          : walletRevision(v.folderRevision),
      ...(v.folderId === undefined ? {} : { folderId: folderId(v.folderId) }),
      ...(v.root ? { root: true as const } : {}),
    };
  };
  if (!Array.isArray(raw.recipients) || raw.recipients.length > 200)
    throw new Error('Select at most 200 launch recipients.');
  const recipients = raw.recipients.map(ref),
    deployer = raw.deployer === undefined ? undefined : ref(raw.deployer);
  const addresses = recipients.map((r) => r.address);
  if (deployer) addresses.push(deployer.address);
  if (new Set(addresses).size !== addresses.length)
    throw new Error('Launch wallet addresses must be unique across roles.');
  return { chain, ...(deployer ? { deployer } : {}), recipients };
}
export function validateLaunchWalletSelection(
  selection: LaunchWalletAssignments | undefined,
  chain: LaunchChain,
  holderCount: number,
) {
  if (!selection) return;
  if (selection.chain !== chain)
    throw new Error('Launch wallets must use the selected launch network.');
  if (selection.recipients.length > holderCount)
    throw new Error('Selected recipients exceed the planned holder count.');
}
export function assignmentEntries(
  selection: LaunchWalletAssignments | undefined,
) {
  return selection
    ? [
        ...(selection.deployer
          ? [{ ...selection.deployer, role: 'Deployer' }]
          : []),
        ...selection.recipients.map((r) => ({ ...r, role: 'Recipient' })),
      ]
    : [];
}
export function activeLaunchWallets(
  workspace: WalletWorkspace,
  chain: LaunchChain,
) {
  return workspace.wallets.filter((w) => w.chain === chain && !w.archived);
}
export function referenceForWallet(
  wallet: WorkspaceWallet,
  workspace: WalletWorkspace,
  selectedFolder?: string,
): LaunchWalletRef {
  if (!wallet.archived && !selectedFolder)
    return {
      address: wallet.address,
      revision: wallet.revision,
      folderRevision: 0,
      root: true,
    };
  const active = activeWalletFolders(wallet, workspace.folders);
  const folder = selectedFolder
    ? active.find((f) => f.id === selectedFolder)
    : (active.find((f) => f.id === wallet.folderId) ?? active[0]);
  if (!folder || wallet.archived)
    throw new Error('Restore the wallet and folder before selecting it.');
  return {
    address: wallet.address,
    revision: wallet.revision,
    folderRevision: folder.revision,
    folderId: folder.id,
  };
}

export function walletReferenceFolderMatches(
  ref: LaunchWalletRef,
  wallet: WorkspaceWallet,
  workspace: WalletWorkspace,
) {
  if (ref.root === true)
    return ref.folderRevision === 0 && ref.folderId === undefined;
  if (ref.folderRevision === 0 && ref.folderId === undefined)
    return walletFolderIds(wallet).length === 0;
  return activeWalletFolders(wallet, workspace.folders).some(
    (f) =>
      f.id === (ref.folderId ?? wallet.folderId) &&
      f.revision === ref.folderRevision,
  );
}
