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
  onDelete,
}: {
  folder: WalletFolder;
  count: number;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onEdit: (folder: WalletFolder, trigger: HTMLButtonElement | null) => void;
  onArchive: (folder: WalletFolder) => void;
  onDelete: (folder: WalletFolder, trigger: HTMLButtonElement | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className={`wallet-folder-row ${selected ? 'selected' : ''}`}>
      <button
        className="wallet-folder-select"
        disabled={busy}
        aria-current={selected ? 'page' : undefined}
        onClick={onSelect}
      >
        <Folder
          size={16}
          style={{ color: folder.color ?? DEFAULT_FOLDER_COLOR }}
        />
        <span>{folder.name}</span>
        <b>{count}</b>
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
            <Pencil /> Edit folder
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onClick={() => onArchive(folder)}>
            <Archive /> Archive folder
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => onDelete(folder, trigger.current)}
          >
            <Trash2 /> Delete folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
