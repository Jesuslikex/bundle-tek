'use client';

import { useState, type RefObject } from 'react';
import { Folder } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { WalletFolder } from '@/lib/wallet-workspace';

export function WalletFolderDeleteDialog({
  folder,
  returnFocus,
  walletCount,
  busy,
  error,
  onClose,
  onDelete,
}: {
  folder: WalletFolder;
  returnFocus?: RefObject<HTMLElement | null>;
  walletCount: number;
  busy: boolean;
  error: string;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [submitted, setSubmitted] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="wallet-folder-editor-dialog"
        finalFocus={returnFocus}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle className="wallet-folder-archive-title">
            <Folder size={18} /> Delete folder
          </DialogTitle>
          <DialogDescription>
            Delete <strong>{folder.name}</strong>? This permanently removes the
            folder. Its {walletCount}{' '}
            {walletCount === 1 ? 'wallet stays' : 'wallets stay'} saved and
            accessible from the parent wallet list or their other folders.
          </DialogDescription>
        </DialogHeader>
        {submitted && error && (
          <p role="alert" className="tracker-error">
            {error}
          </p>
        )}
        <div className="wallet-folder-editor-actions">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (!busy) {
                setSubmitted(true);
                void onDelete();
              }
            }}
          >
            {busy ? 'Deleting…' : 'Delete folder'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
