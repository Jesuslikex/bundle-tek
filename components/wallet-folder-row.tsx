'use client';

import { useRef } from 'react';
import { Archive, Folder, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  DEFAULT_FOLDER_COLOR,
  type WalletFolder,
} from '@/lib/wallet-workspace';

export function WalletFolderRow({
  folder,
  count,
  selected,
  busy,
  onSelect,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  folder: WalletFolder;
  count: number;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onEdit: (folder: WalletFolder, trigger: HTMLButtonElement | null) => void;
  onArchive: (folder: WalletFolder) => void;
  onRestore: (folder: WalletFolder) => void;
  onDelete: (folder: WalletFolder, trigger: HTMLButtonElement | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className={`wallet-folder-child ${selected ? 'selected' : ''}`}>
      <button
        className="wallet-folder-name"
        disabled={busy}
        aria-current={selected ? 'page' : undefined}
        onClick={onSelect}
      >
        <Folder
          size={14}
          style={{ color: folder.color ?? DEFAULT_FOLDER_COLOR }}
        />
        <p>
          <span>{folder.name}</span>
          <span className="wallet-folder-count">({count})</span>
        </p>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={trigger}
              variant="ghost"
              size="icon-sm"
              className="wallet-folder-actions-trigger"
              disabled={busy}
              aria-label={`Actions for folder ${folder.name}`}
            />
          }
        >
          <MoreHorizontal size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="wallet-folder-actions-menu"
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          collisionAvoidance={{
            side: 'flip',
            align: 'shift',
            fallbackAxisSide: 'end',
          }}
        >
          <DropdownMenuItem
            disabled={busy}
            onClick={() => onEdit(folder, trigger.current)}
          >
            <Pencil /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy}
            onClick={() =>
              folder.archived ? onRestore(folder) : onArchive(folder)
            }
          >
            <Archive /> {folder.archived ? 'Restore' : 'Archived'}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => onDelete(folder, trigger.current)}
          >
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
