import bs58 from 'bs58';
export const IMPORTED_WALLET_REVIEW = 'bundle:imported-wallet-review';
export type ImportedWalletReview = {
  projectId: string;
  revision: number;
  mint: string;
  wallet: string;
  side: 'Buy' | 'Sell';
};
function valid(value: unknown): value is ImportedWalletReview {
  const r = value as ImportedWalletReview;
  try {
    return (
      !!r &&
      typeof r.projectId === 'string' &&
      /^[a-zA-Z0-9-]{1,64}$/.test(r.projectId) &&
      Number.isSafeInteger(r.revision) &&
      r.revision > 0 &&
      ['Buy', 'Sell'].includes(r.side) &&
      typeof r.mint === 'string' &&
      typeof r.wallet === 'string' &&
      bs58.decode(r.mint).length === 32 &&
      bs58.decode(r.wallet).length === 32
    );
  } catch {
    return false;
  }
}
type Detail = { request: ImportedWalletReview; result?: string | null };
export function requestImportedWalletReview(request: ImportedWalletReview) {
  if (!valid(request))
    return 'This wallet review context is invalid. Reload the project.';
  const detail: Detail = { request };
  window.dispatchEvent(new CustomEvent(IMPORTED_WALLET_REVIEW, { detail }));
  return detail.result === undefined
    ? 'Open this token project to review the wallet.'
    : detail.result;
}
export function subscribeImportedWalletReview(
  scope: { projectId: string; revision: number; mint: string },
  receive: (review: ImportedWalletReview) => string | null,
) {
  const listener = (event: Event) => {
    const d = (event as CustomEvent<Detail>).detail;
    if (
      !d ||
      !valid(d.request) ||
      d.request.projectId !== scope.projectId ||
      d.request.revision !== scope.revision ||
      d.request.mint !== scope.mint
    )
      return;
    d.result = receive(d.request);
  };
  window.addEventListener(IMPORTED_WALLET_REVIEW, listener);
  return () => window.removeEventListener(IMPORTED_WALLET_REVIEW, listener);
}
