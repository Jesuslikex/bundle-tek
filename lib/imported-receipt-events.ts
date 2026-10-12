import type { ImportedSwapReceipt } from './imported-approval-history';
import { finalizedReceiptChartTarget } from './imported-chart-workspace';
import bs58 from 'bs58';
export const IMPORTED_RECEIPT_SAVED = 'bundle:imported-receipt-saved';
const CHANNEL = 'bundle:finalized-receipt:v1';
type Notice = {
  id: string;
  projectId: string;
  mint: string;
  wallet: string;
  signature: string;
  side: 'Buy' | 'Sell';
};
function validNotice(value: unknown): value is Notice {
  const d = value as Notice;
  try {
    return (
      !!d &&
      Object.keys(d).sort().join(',') ===
        'id,mint,projectId,side,signature,wallet' &&
      typeof d.id === 'string' &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(d.id) &&
      typeof d.projectId === 'string' &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(d.projectId) &&
      typeof d.mint === 'string' &&
      d.mint.length <= 44 &&
      bs58.decode(d.mint).length === 32 &&
      typeof d.wallet === 'string' &&
      d.wallet.length <= 44 &&
      bs58.decode(d.wallet).length === 32 &&
      typeof d.signature === 'string' &&
      d.signature.length <= 88 &&
      bs58.decode(d.signature).length === 64 &&
      ['Buy', 'Sell'].includes(d.side)
    );
  } catch {
    return false;
  }
}
function openChannel() {
  try {
    return typeof window.BroadcastChannel === 'function'
      ? new window.BroadcastChannel(CHANNEL)
      : null;
  } catch {
    return null;
  }
}
export function notifyImportedReceiptSaved(receipt: ImportedSwapReceipt) {
  if (!finalizedReceiptChartTarget(receipt)) return;
  const { mint, wallet, signature, side } = receipt.document;
  const notice: Notice = {
    id: receipt.id,
    projectId: receipt.projectId,
    mint,
    wallet,
    signature,
    side,
  };
  if (!validNotice(notice)) return;
  window.dispatchEvent(
    new CustomEvent(IMPORTED_RECEIPT_SAVED, {
      detail: notice,
    }),
  );
  const channel = openChannel();
  if (channel)
    try {
      channel.postMessage({ format: 'bundle-receipt-notice-v1', notice });
    } catch {
      /* Same-page invalidation remains available. */
    } finally {
      channel.close();
    }
}
export function subscribeImportedReceiptSaved(
  scope: { projectId: string; mint: string; wallet?: string },
  receive: (notice: Notice) => void,
) {
  const seen = new Set<string>();
  const accept = (d: unknown) => {
    if (
      !validNotice(d) ||
      d.projectId !== scope.projectId ||
      d.mint !== scope.mint ||
      (scope.wallet && d.wallet !== scope.wallet) ||
      !['Buy', 'Sell'].includes(d.side)
    )
      return;
    const key = `${d.id}:${d.signature}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 100) seen.delete(seen.values().next().value!);
    receive(d);
  };
  const listener = (event: Event) =>
    accept((event as CustomEvent<unknown>).detail);
  const channel = openChannel();
  if (channel)
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { format?: unknown; notice?: unknown } | null;
      if (data?.format === 'bundle-receipt-notice-v1') accept(data.notice);
    };
  window.addEventListener(IMPORTED_RECEIPT_SAVED, listener);
  return () => {
    window.removeEventListener(IMPORTED_RECEIPT_SAVED, listener);
    if (channel) {
      channel.onmessage = null;
      channel.close();
    }
  };
}
