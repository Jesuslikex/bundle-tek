export const WARMUP_RECEIPT_SAVED = 'bundle:warmup-receipt-saved';
export function notifyWarmupReceiptSaved(planId: string, side: 'Buy' | 'Sell') {
  window.dispatchEvent(
    new CustomEvent(WARMUP_RECEIPT_SAVED, { detail: { planId, side } }),
  );
}
