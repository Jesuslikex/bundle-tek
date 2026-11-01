'use client';

import { useState, type RefObject } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Captured Proxima asks "Are you sure you want to delete these wallets?" before
// dropping funded wallets and warns that the action cannot be undone. Deletion
// here archives the wallet, and nothing withdraws its funds, so the text says so
// rather than borrowing the reference's "Withdraw and Delete" label.
export function WalletDeleteDialog({
  label,
  count,
  returnFocus,
  busy,
  error,
  onClose,
  onDelete,
}: {
  label: string;
  count: number;
  returnFocus?: RefObject<HTMLElement | null>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onDelete: () => Promise<boolean>;
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
            <Trash2 size={18} />{' '}
            {count === 1 ? 'Delete wallet' : 'Delete wallets'}
          </DialogTitle>
          <DialogDescription>
            {count === 1 ? (
              <>
                Are you sure you want to delete <strong>{label}</strong>?
              </>
            ) : (
              <>Are you sure you want to delete these {count} wallets?</>
            )}{' '}
            They move to Deleted wallets and can be restored.
          </DialogDescription>
        </DialogHeader>
        <p className="wallet-delete-caution">
          Deleting does not withdraw anything. Funds stay in the wallet, so
          empty it first if these wallets still hold SOL or tokens.
        </p>
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
              if (busy) return;
              setSubmitted(true);
              void onDelete().then((ok) => {
                if (ok) onClose();
              });
            }}
          >
            {busy ? 'Deleting…' : count === 1 ? 'Delete' : `Delete ${count}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
