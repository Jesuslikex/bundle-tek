import { walletAddress } from './wallet-workspace';
import bs58 from 'bs58';
export function validMovementBlockTime(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 8640000000000
  );
}
export const SUPPLY_ALERT_CHART = 'bundle:supply-alert-chart';
export type SupplyAlertChartRequest = {
  projectId: string;
  revision: number;
  mint: string;
  wallet: string;
  from: string;
  to: string;
  transaction?: { signature: string; slot: number; blockTime: number };
};
function valid(value: unknown): value is SupplyAlertChartRequest {
  const r = value as SupplyAlertChartRequest;
  try {
    return (
      !!r &&
      typeof r.projectId === 'string' &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(r.projectId) &&
      Number.isSafeInteger(r.revision) &&
      r.revision > 0 &&
      walletAddress(r.mint, 'Solana') === r.mint &&
      walletAddress(r.wallet, 'Solana') === r.wallet &&
      typeof r.from === 'string' &&
      typeof r.to === 'string' &&
      r.from.length <= 40 &&
      r.to.length <= 40 &&
      Number.isFinite(Date.parse(r.from)) &&
      Number.isFinite(Date.parse(r.to)) &&
      Date.parse(r.from) < Date.parse(r.to) &&
      (r.transaction === undefined ||
        (!!r.transaction &&
          typeof r.transaction.signature === 'string' &&
          r.transaction.signature.length <= 88 &&
          bs58.decode(r.transaction.signature).length === 64 &&
          Number.isSafeInteger(r.transaction.slot) &&
          r.transaction.slot > 0 &&
          validMovementBlockTime(r.transaction.blockTime)))
    );
  } catch {
    return false;
  }
}
type Detail = { request: SupplyAlertChartRequest; result?: string | null };
export function requestSupplyAlertChart(request: SupplyAlertChartRequest) {
  if (!valid(request))
    return 'Invalid movement observation. Reload supply history.';
  const detail: Detail = { request };
  window.dispatchEvent(new CustomEvent(SUPPLY_ALERT_CHART, { detail }));
  return detail.result === undefined
    ? 'Open this token project with loaded pool candles to inspect the alert.'
    : detail.result;
}
export function subscribeSupplyAlertChart(
  scope: { projectId: string; revision: number; mint: string },
  receive: (request: SupplyAlertChartRequest) => string | null,
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
  window.addEventListener(SUPPLY_ALERT_CHART, listener);
  return () => window.removeEventListener(SUPPLY_ALERT_CHART, listener);
}
