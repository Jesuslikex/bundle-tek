import {
  walletAddress,
  walletRevision,
  walletRole,
  walletText,
  walletTags,
  folderId,
  MAX_WORKSPACE_WALLETS,
  type WorkspaceWallet,
} from './wallet-workspace';
export const FUNDING_SOURCE_UNAVAILABLE =
  'Saved funding source could not be loaded. Try loading it again.';
export const FUNDING_SOURCE_RECHECK_UNAVAILABLE =
  'Saved source details are no longer confirmed. Keep this transfer review for recovery, then reopen the funding plan to load the updated source.';
/** Public metadata only. Select exactly the requested active canonical wallet. */
export function mainnetFundingSource(
  value: unknown,
  address: string,
): WorkspaceWallet[] {
  try {
    if (walletAddress(address, 'Solana') !== address) throw Error();
    const wallets = (value as { wallets?: unknown } | null)?.wallets;
    if (!Array.isArray(wallets) || wallets.length > MAX_WORKSPACE_WALLETS)
      throw Error();
    const matches = wallets.filter(
      (w: unknown) =>
        w &&
        typeof w === 'object' &&
        (w as Record<string, unknown>).chain === 'Solana' &&
        (w as Record<string, unknown>).address === address,
    );
    if (matches.length !== 1) throw Error();
    const row = matches[0] as Record<string, unknown>;
    if (
      row.archived !== false ||
      typeof row.updatedAt !== 'string' ||
      new Date(row.updatedAt).toISOString() !== row.updatedAt
    )
      throw Error();
    const folders = row.folderIds;
    if (
      folders !== undefined &&
      (!Array.isArray(folders) ||
        folders.length > 100 ||
        new Set(folders).size !== folders.length)
    )
      throw Error();
    return [
      {
        chain: 'Solana',
        address,
        revision: walletRevision(row.revision),
        archived: false,
        role: walletRole(row.role),
        label: walletText(row.label, 'Wallet label', 200),
        folderId: row.folderId === '' ? '' : folderId(row.folderId),
        ...(folders !== undefined
          ? { folderIds: (folders as unknown[]).map(folderId) }
          : {}),
        ...(row.tags !== undefined ? { tags: walletTags(row.tags) } : {}),
        updatedAt: row.updatedAt,
      },
    ];
  } catch {
    throw new Error(FUNDING_SOURCE_UNAVAILABLE);
  }
}
