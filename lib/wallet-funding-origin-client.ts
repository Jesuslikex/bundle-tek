import {
  walletFundingSelection,
  type WalletFundingSelection,
} from './wallet-funding-time';
import {
  decodeFundingOriginBatch,
  type FundingOriginBatch,
} from './wallet-funding-origin-view';
import { readBoundedPanelJson } from './read-bounded-panel-json';
export type FundingOriginProgress = {
  completed: number;
  total: number;
  phase: 'reading' | 'waiting' | 'complete';
};
export class FundingOriginClientError extends Error {
  constructor(
    readonly status: number,
    completed = 0,
    total = 0,
  ) {
    super(
      (status === 429
        ? 'Provider history is cooling down. Wait at least 15 seconds; provider limits can last longer.'
        : status === 408
          ? 'Provider history timed out. Wait at least 15 seconds before a new check.'
          : status === 503
            ? 'Provider history is temporarily unavailable on this server. You can still use Saved receipts.'
            : status === 409
              ? 'Your wallet selection changed. Refresh the wallets before a new check.'
              : status === 401
                ? 'Sign in before checking provider history.'
                : 'Provider funding history could not be checked. Keep the selection and wait at least 15 seconds before a new check.') +
        (completed
          ? ` ${completed} of ${total} wallets were read. No partial result was kept; a new check reads the full selection again.`
          : '') +
        ' No automatic retry was made.',
    );
  }
}
function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 17000);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export async function readProviderFundingOrigins(
  selection: WalletFundingSelection,
  caller: AbortSignal,
  progress: (p: FundingOriginProgress) => void,
) {
  const wallets = walletFundingSelection.parse({ wallets: selection }).wallets;
  const signal = AbortSignal.any([caller, AbortSignal.timeout(700000)]);
  const rows: FundingOriginBatch['wallets'] = [];
  let capturedAt = '';
  try {
    for (let start = 0; start < wallets.length; start += 10) {
      signal.throwIfAborted();
      if (start) {
        progress({ completed: start, total: wallets.length, phase: 'waiting' });
        await wait(signal);
      }
      signal.throwIfAborted();
      progress({ completed: start, total: wallets.length, phase: 'reading' });
      signal.throwIfAborted();
      const requested = wallets.slice(start, start + 10);
      const current = AbortSignal.any([signal, AbortSignal.timeout(50000)]);
      const response = await fetch('/api/wallet-workspace/funding-origins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallets: requested, context: wallets }),
        cache: 'no-store',
        signal: current,
      });
      if (current.aborted) {
        void response.body?.cancel().catch(() => {});
        current.throwIfAborted();
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new FundingOriginClientError(response.status);
      }
      const result = decodeFundingOriginBatch(
        await readBoundedPanelJson(response, current),
        requested,
        wallets,
      );
      current.throwIfAborted();
      rows.push(...result.wallets);
      if (result.capturedAt > capturedAt) capturedAt = result.capturedAt;
    }
    signal.throwIfAborted();
    const result = decodeFundingOriginBatch(
      {
        context: wallets,
        format: 'wallet-funding-origins-v1',
        network: 'mainnet',
        scope: 'oldest-provider-reported-transaction',
        ledgerMetadata: 'provider-reported',
        historyComplete: false,
        signingAllowed: false,
        executionAllowed: false,
        capturedAt,
        wallets: rows,
      },
      wallets,
    );
    progress({
      completed: wallets.length,
      total: wallets.length,
      phase: 'complete',
    });
    return result;
  } catch (error) {
    if (caller.aborted) throw caller.reason;
    throw new FundingOriginClientError(
      error instanceof FundingOriginClientError
        ? error.status
        : error instanceof DOMException && error.name === 'TimeoutError'
          ? 408
          : 502,
      rows.length,
      wallets.length,
    );
  }
}
