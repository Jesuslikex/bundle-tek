'use client';

import { useState } from 'react';
import { Archive, Folder, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  walletFolderIds,
  DEFAULT_FOLDER_COLOR,
  type WalletFolder,
  type WorkspaceWallet,
} from '@/lib/wallet-workspace';

export function ArchivedWalletFolders({
  folders,
  wallets,
  busy,
  loading,
  error,
  onRestore,
}: {
  folders: WalletFolder[];
  wallets: WorkspaceWallet[];
  busy: boolean;
  loading: boolean;
  error: string;
  onRestore: (folder: WalletFolder) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const archived = folders.filter((folder) => folder.archived);
  const counts = new Map<string, number>();
  for (const wallet of wallets) {
    if (wallet.archived) continue;
    for (const id of walletFolderIds(wallet))
      counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  async function restore(folder: WalletFolder) {
    setRestoring(folder.id);
    try {
      await onRestore(folder);
    } finally {
      setRestoring(null);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!restoring) setOpen(value);
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" disabled={busy || loading} />}
      >
        <Archive size={16} /> Archived folders
      </DialogTrigger>
      <DialogContent className="wallet-folder-archive-dialog">
        <DialogHeader>
          <DialogTitle className="wallet-folder-archive-title">
            <Archive size={18} /> Archived folders
          </DialogTitle>
          <DialogDescription>
            Archived folders are hidden from the sidebar.
            <br />
            Their wallets stay accessible from the parent wallet list.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="tracker-error">
            {error}
          </p>
        )}
        {archived.length === 0 ? (
          <p className="wallet-folder-archive-empty">No archived folders</p>
        ) : (
          <ul className="wallet-folder-archive-list">
            {archived.map((folder) => (
              <li key={folder.id}>
                <div>
                  <Folder
                    size={16}
                    style={{ color: folder.color ?? DEFAULT_FOLDER_COLOR }}
                  />
                  <span>{folder.name}</span>
                  <small>({counts.get(folder.id) ?? 0})</small>
                </div>
                <Button
                  variant="outline"
                  disabled={busy || restoring !== null}
                  aria-label={`Restore folder ${folder.name}`}
                  onClick={() => void restore(folder)}
                >
                  <RotateCcw size={14} />{' '}
                  {restoring === folder.id ? 'Restoring…' : 'Restore'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
