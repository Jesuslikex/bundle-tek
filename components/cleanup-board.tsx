'use client';
import { useRef, useState } from 'react';
import {
  boardColumnOf,
  marqueeRect,
  moveBoardWallets,
  nextBoardSelection,
  rectsOverlap,
  type BoardColumn,
  type BoardFacts,
  type BoardRect,
} from '@/lib/cleanup-board';
import styles from './cleanup-board.module.css';

export type BoardWallet = {
  address: string;
  label: string;
  role: string;
  token: string;
  native: string;
};
const COLUMNS: { id: BoardColumn; title: string; hint: string }[] = [
  { id: 'pool', title: 'Wallets', hint: 'Not in this cleanup' },
  { id: 'sources', title: 'Sources (Sellers)', hint: 'Sell their tokens' },
  {
    id: 'destinations',
    title: 'Destinations (Buyers)',
    hint: 'Buy the tokens back',
  },
];
const short = (a: string) => a.slice(0, 4) + '…' + a.slice(-4);

/**
 * Proxima's Cleanup Board: drag wallet cards into Sources or Destinations.
 * Select several with a drag box, Shift-click a range or Ctrl/⌘-click, then
 * move them together. It edits the same seller/buyer lists as the form.
 */
export function CleanupBoard({
  wallets,
  inputs,
  outputs,
  facts,
  disabled,
  onChange,
}: {
  wallets: BoardWallet[];
  inputs: string[];
  outputs: string[];
  facts: BoardFacts;
  disabled?: boolean;
  onChange: (next: { inputs: string[]; outputs: string[] }) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const [refused, setRefused] = useState('');
  const [box, setBox] = useState<BoardRect | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const lists = { inputs, outputs };
  const byColumn = (column: BoardColumn) =>
    wallets.filter((w) => boardColumnOf(lists, w.address) === column);
  // Display order, column by column: Shift ranges follow what is on screen.
  const order = COLUMNS.flatMap((c) => byColumn(c.id).map((w) => w.address));
  const labelOf = (address: string) =>
    wallets.find((w) => w.address === address)?.label || short(address);

  function move(addresses: string[], to: BoardColumn) {
    if (disabled || !addresses.length) return;
    const next = moveBoardWallets(lists, addresses, to, facts);
    setRefused(
      next.refused.length
        ? next.refused
            .map((r) => `${labelOf(r.address)} ${r.reason}`)
            .join('; ') + '.'
        : '',
    );
    onChange({ inputs: next.inputs, outputs: next.outputs });
    setSelected([]);
  }

  function startMarquee(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-address],button')) return;
    const start = { x: event.clientX, y: event.clientY };
    const keep =
      event.shiftKey || event.ctrlKey || event.metaKey ? selected : [];
    const onMove = (e: PointerEvent) => {
      const rect = marqueeRect(start, { x: e.clientX, y: e.clientY });
      setBox(rect);
      const hit = [
        ...(board.current?.querySelectorAll<HTMLElement>('[data-address]') ??
          []),
      ]
        .filter((card) => rectsOverlap(rect, card.getBoundingClientRect()))
        .map((card) => card.dataset.address!);
      setSelected([...new Set([...keep, ...hit])]);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setBox(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    if (!keep.length) setSelected([]);
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span>
          {selected.length
            ? `${selected.length} selected`
            : 'Drag cards, or select and move'}
        </span>
        <button
          type="button"
          disabled={disabled || !selected.length}
          onClick={() => move(selected, 'sources')}
        >
          To Sources
        </button>
        <button
          type="button"
          disabled={disabled || !selected.length}
          onClick={() => move(selected, 'destinations')}
        >
          To Destinations
        </button>
        <button
          type="button"
          disabled={disabled || !selected.length}
          onClick={() => move(selected, 'pool')}
        >
          Remove
        </button>
      </div>
      <div
        ref={board}
        className={styles.board}
        onPointerDown={startMarquee}
        aria-label="Cleanup Board"
      >
        {COLUMNS.map((column) => {
          const cards = byColumn(column.id);
          return (
            <div
              key={column.id}
              className={styles.column}
              data-column={column.id}
              data-over={over === column.id ? 'true' : undefined}
              onDragOver={(e) => {
                if (disabled) return;
                e.preventDefault();
                setOver(column.id);
              }}
              onDragLeave={() => setOver((c) => (c === column.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const dragged = e.dataTransfer.getData('text/plain');
                move(
                  selected.length
                    ? selected
                    : dragged
                      ? dragged.split(',')
                      : [],
                  column.id,
                );
              }}
            >
              <header>
                <strong>
                  {column.title} ({cards.length})
                </strong>
                <small>{column.hint}</small>
              </header>
              <div className={styles.cards}>
                {cards.map((w) => {
                  const isSelected = selected.includes(w.address);
                  return (
                    <div
                      key={w.address}
                      // A div, not a button: Firefox cannot drag buttons.
                      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`Wallet ${w.label || short(w.address)}`}
                      className={styles.card}
                      data-address={w.address}
                      data-selected={isSelected ? 'true' : undefined}
                      draggable={!disabled}
                      onClick={(e) => {
                        setSelected(
                          nextBoardSelection(
                            selected,
                            order,
                            anchor,
                            w.address,
                            {
                              shift: e.shiftKey,
                              toggle: e.ctrlKey || e.metaKey,
                            },
                          ),
                        );
                        if (!e.shiftKey) setAnchor(w.address);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== ' ' && e.key !== 'Enter') return;
                        e.preventDefault();
                        setSelected(
                          nextBoardSelection(
                            selected,
                            order,
                            anchor,
                            w.address,
                            {
                              shift: e.shiftKey,
                              toggle: true,
                            },
                          ),
                        );
                        setAnchor(w.address);
                      }}
                      onDragStart={(e) => {
                        const moving = isSelected ? selected : [w.address];
                        if (!isSelected) setSelected(moving);
                        e.dataTransfer.setData('text/plain', moving.join(','));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                    >
                      <span className={styles.name} title={w.address}>
                        {w.label || short(w.address)}
                      </span>
                      {w.role && <em>{w.role}</em>}
                      <span className={styles.amounts}>
                        <span>{w.token}</span>
                        <span>{w.native}</span>
                      </span>
                    </div>
                  );
                })}
                {!cards.length && (
                  <p className={styles.empty}>
                    {column.id === 'pool'
                      ? 'No wallets left'
                      : 'Drop wallets here'}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        {box && (
          <div
            className={styles.marquee}
            style={{
              left: box.left,
              top: box.top,
              width: box.right - box.left,
              height: box.bottom - box.top,
            }}
          />
        )}
      </div>
      {refused && (
        <p role="alert" className={styles.refused}>
          Not moved: {refused}
        </p>
      )}
    </div>
  );
}
