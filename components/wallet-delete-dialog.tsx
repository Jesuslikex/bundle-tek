'use client';

import { useId, useState, type RefObject } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Captured Proxima asks "Are you sure you want to delete these wallets?" before
// dropping funded wallets and warns that the action cannot be undone. Deletion
// here archives the wallet. Withdrawing inline is optional: the caller may offer
// it, in which case the wallet is emptied first and only then archived, matching
// the reference's withdraw-then-delete order.
export function WalletDeleteDialog({
  label,
  count,
  returnFocus,
  busy,
  error,
  onClose,
  onDelete,
  onWithdraw,
  onWithdrawAndDelete,
}: {
  label: string;
  count: number;
  returnFocus?: RefObject<HTMLElement | null>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onDelete: () => Promise<boolean>;
  onWithdraw?: () => void;
  /** Empty the wallet to this address, then archive it. */
  onWithdrawAndDelete?: (
    destination: string,
    password: string,
  ) => Promise<boolean>;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [destination, setDestination] = useState('');
  const [password, setPassword] = useState('');
  const id = useId();
  const canWithdraw =
    !!onWithdrawAndDelete && !!destination.trim() && !!password && !busy;
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
        {onWithdrawAndDelete && count === 1 && (
          <div className="wallet-delete-withdraw">
            <label htmlFor={`${id}-destination`}>
              Withdraw to public address
              <Input
                id={`${id}-destination`}
                aria-label="Withdraw destination address"
                value={destination}
                disabled={busy}
                onChange={(e) => setDestination(e.target.value)}
              />
            </label>
            <label htmlFor={`${id}-password`}>
              Vault password
              <Input
                id={`${id}-password`}
                aria-label="Vault password"
                type="password"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <Button
              variant="outline"
              disabled={!canWithdraw}
              onClick={() => {
                if (!canWithdraw) return;
                setSubmitted(true);
                void onWithdrawAndDelete!(destination.trim(), password).then(
                  (ok) => {
                    if (ok) {
                      setPassword('');
                      onClose();
                    }
                  },
                );
              }}
            >
              Withdraw and delete
            </Button>
          </div>
        )}
        {submitted && error && (
          <p role="alert" className="tracker-error">
            {error}
          </p>
        )}
        <div className="wallet-folder-editor-actions">
          {onWithdraw && (
            <Button variant="outline" disabled={busy} onClick={onWithdraw}>
              Withdraw first
            </Button>
          )}
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
