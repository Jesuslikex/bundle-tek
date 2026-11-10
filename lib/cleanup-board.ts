/**
 * Cleanup Board (Proxima "Cleanup Board"): wallet cards are dragged into
 * Sources (sellers) or Destinations (buyers). This is the pure part: which
 * moves are allowed and how card selection behaves. It only edits the two
 * wallet lists of the existing cleanup form; nothing here signs or sends.
 */
export type BoardColumn = 'pool' | 'sources' | 'destinations';
export type BoardLists = { inputs: string[]; outputs: string[] };
export type BoardFacts = {
  /** Token balances by wallet, or null while they are still loading. */
  tokenRaw: Record<string, string | undefined> | null;
  /** Native balances by wallet, or null while they are still loading. */
  nativeRaw: Record<string, string | undefined> | null;
  max: number;
};
export type BoardRefusal = { address: string; reason: string };

const positive = (raw: string | undefined) =>
  !!raw && /^\d+$/.test(raw) && BigInt(raw) > 0n;

export function boardColumnOf(lists: BoardLists, address: string): BoardColumn {
  return lists.inputs.includes(address)
    ? 'sources'
    : lists.outputs.includes(address)
      ? 'destinations'
      : 'pool';
}

/**
 * Move cards to a column. A wallet is only ever in one column. Wallets
 * without tokens cannot be Sources and wallets without native balance cannot
 * be Destinations (both only enforced once the balances are known).
 */
export function moveBoardWallets(
  lists: BoardLists,
  addresses: string[],
  to: BoardColumn,
  facts: BoardFacts,
): BoardLists & { refused: BoardRefusal[] } {
  const refused: BoardRefusal[] = [];
  let inputs = lists.inputs.slice(),
    outputs = lists.outputs.slice();
  for (const address of new Set(addresses)) {
    if (boardColumnOf({ inputs, outputs }, address) === to) continue;
    if (to === 'sources') {
      if (facts.tokenRaw && !positive(facts.tokenRaw[address])) {
        refused.push({ address, reason: 'holds no tokens to sell' });
        continue;
      }
      if (inputs.length >= facts.max) {
        refused.push({ address, reason: `over the ${facts.max} wallet limit` });
        continue;
      }
    }
    if (to === 'destinations') {
      if (facts.nativeRaw && !positive(facts.nativeRaw[address])) {
        refused.push({ address, reason: 'holds no SOL to buy with' });
        continue;
      }
      if (outputs.length >= facts.max) {
        refused.push({ address, reason: `over the ${facts.max} wallet limit` });
        continue;
      }
    }
    inputs = inputs.filter((a) => a !== address);
    outputs = outputs.filter((a) => a !== address);
    if (to === 'sources') inputs.push(address);
    if (to === 'destinations') outputs.push(address);
  }
  return { inputs, outputs, refused };
}

/**
 * Card click selection: plain click selects one, Ctrl/⌘-click toggles one,
 * Shift-click selects the range from the last clicked card in display order.
 */
export function nextBoardSelection(
  current: string[],
  order: string[],
  anchor: string | null,
  target: string,
  keys: { shift: boolean; toggle: boolean },
): string[] {
  if (
    keys.shift &&
    anchor &&
    order.includes(anchor) &&
    order.includes(target)
  ) {
    const a = order.indexOf(anchor),
      b = order.indexOf(target);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return keys.toggle ? [...new Set([...current, ...range])] : range;
  }
  if (keys.toggle)
    return current.includes(target)
      ? current.filter((a) => a !== target)
      : [...current, target];
  return [target];
}

export type BoardRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
/** Rectangle between two pointer positions, for the drag-box selection. */
export function marqueeRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
): BoardRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}
export function rectsOverlap(a: BoardRect, b: BoardRect) {
  return (
    a.left <= b.right &&
    a.right >= b.left &&
    a.top <= b.bottom &&
    a.bottom >= b.top
  );
}
