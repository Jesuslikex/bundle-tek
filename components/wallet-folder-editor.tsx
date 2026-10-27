'use client';

import { useId, useState, type RefObject } from 'react';
import { Folder } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { WalletFolderColorPicker } from '@/components/wallet-folder-color-picker';
import {
  DEFAULT_FOLDER_COLOR,
  type WalletFolder,
} from '@/lib/wallet-workspace';

export function WalletFolderEditor({
  folder,
  returnFocus,
  folders,
  busy,
  error,
  onClose,
  onSave,
}: {
  folder: WalletFolder | 'new';
  returnFocus?: RefObject<HTMLElement | null>;
  folders: WalletFolder[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (name: string, color: string) => Promise<boolean>;
}) {
  const inputId = useId();
  const [name, setName] = useState(folder === 'new' ? '' : folder.name);
  const [color, setColor] = useState<string>(
    folder === 'new'
      ? DEFAULT_FOLDER_COLOR
      : (folder.color ?? DEFAULT_FOLDER_COLOR),
  );
  const [submitted, setSubmitted] = useState(false);
  const duplicate = folders.some(
    (existing) =>
      existing.id !== (folder === 'new' ? undefined : folder.id) &&
      existing.name.toLowerCase() === name.trim().toLowerCase(),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className={
          folder === 'new'
            ? 'wallet-folder-editor-dialog is-create'
            : 'wallet-folder-editor-dialog'
        }
        finalFocus={returnFocus}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle className="wallet-folder-archive-title">
            <Folder size={18} />{' '}
            {folder === 'new' ? 'Create New Folder' : 'Edit folder'}
          </DialogTitle>
          <DialogDescription>
            {folder === 'new' ? (
              <>
                Folders help you structure your wallets into clear groups.
                <br />
                They make it easier to manage your wallets.
              </>
            ) : (
              'Group your wallets into folders so they are easier to find and manage.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (
              busy ||
              duplicate ||
              !name.trim() ||
              !/^#[0-9A-F]{6}$/.test(color)
            )
              return;
            setSubmitted(true);
            void onSave(name, color);
          }}
        >
          <label htmlFor={inputId}>Folder Name</label>
          <Input
            id={inputId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Wallets list #1"
            maxLength={40}
            required
            disabled={busy}
            autoComplete="off"
            aria-invalid={duplicate}
          />
          <WalletFolderColorPicker
            color={color}
            onChange={setColor}
            disabled={busy}
          />
          {duplicate && (
            <p role="alert" className="tracker-error">
              A folder with this name already exists.
            </p>
          )}
          {submitted && error && (
            <p role="alert" className="tracker-error">
              {error}
            </p>
          )}
          <div
            className={
              folder === 'new'
                ? 'wallet-folder-editor-actions is-create'
                : 'wallet-folder-editor-actions'
            }
          >
            {folder !== 'new' && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              disabled={
                busy ||
                duplicate ||
                !name.trim() ||
                !/^#[0-9A-F]{6}$/.test(color)
              }
            >
              {busy
                ? folder === 'new'
                  ? 'Creating…'
                  : 'Saving…'
                : folder === 'new'
                  ? '+ Create New Folder'
                  : 'Save changes'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
