import { parseLaunchLayerEnvelope } from './launch-layer-terms';
import {
  walletFundingSelection,
  decodeWalletFundingTimes,
  compareFundingEventTimes,
  type WalletFundingSelection,
  type WalletFundingTimes,
} from './wallet-funding-time';
import {
  decodeFundingOriginBatch,
  type FundingOriginBatch,
} from './wallet-funding-origin-view';
import {
  readProviderFundingOrigins,
  FundingOriginClientError,
  type FundingOriginProgress,
} from './wallet-funding-origin-client';
import { readBoundedPanelJson } from './read-bounded-panel-json';

export type LaunchFundingSource = 'saved' | 'provider';
type Batch = WalletFundingTimes | FundingOriginBatch;
export class LaunchFundingCapacityError extends Error {
  constructor(readonly count: number) {
    super(
      `Funding comparison supports at most 500 assigned wallets; this review contains ${count}. No wallet was checked or omitted.`,
    );
  }
}
export class LaunchFundingReadError extends Error {
  constructor(
    readonly status: number,
    source: LaunchFundingSource,
    completed: number,
    total: number,
  ) {
    const reason =
      status === 401
        ? 'Sign in before checking funding history.'
        : status === 409
          ? 'Wallet references changed. Reload the current wallets and layer review.'
          : status === 429
            ? 'Provider rate limited; wait at least 15 seconds before a new check.'
            : status === 408
              ? 'The history check timed out. Wait before starting a new check.'
              : status === 503
                ? source === 'provider'
                  ? 'Provider history is unavailable. You can still use Saved receipts.'
                  : 'Saved receipt storage is unavailable. Try again later.'
                : 'Funding history could not be checked.';
    super(
      `${source === 'provider' ? 'Provider' : 'Recorded'} launch funding check stopped after ${completed} of ${total} wallets. No partial result was kept. ${reason} No automatic retry was made.`,
    );
  }
}
class FundingHttpError extends Error {
  constructor(readonly status: number) {
    super('Funding read failed.');
  }
}
export function launchFundingSelection(value: unknown): WalletFundingSelection {
  if (Array.isArray(value) && value.length > 500)
    throw new LaunchFundingCapacityError(value.length);
  if (!Array.isArray(value) || !value.length || value.length > 500)
    throw Error('Choose 1 to 500 distinct launch wallets.');
  const wallets: WalletFundingSelection = [];
  for (let start = 0; start < value.length; start += 100)
    wallets.push(
      ...walletFundingSelection.parse({
        wallets: value.slice(start, start + 100),
      }).wallets,
    );
  if (new Set(wallets.map((w) => w.address)).size !== wallets.length)
    throw Error('Launch funding wallets are duplicated.');
  return wallets;
}
export function launchFundingRoster(value: unknown) {
  const envelope = parseLaunchLayerEnvelope(value),
    roles = envelope.terms.roles;
  const wallets = launchFundingSelection(
    [
      roles.funder,
      ...(roles.developer ? [roles.developer] : []),
      ...roles.front,
      ...roles.back,
      ...roles.temporary,
      ...roles.holders,
    ].map((member) => ({
      address: member.wallet.address,
      revision: member.wallet.revision,
    })),
  );
  return { wallets, key: JSON.stringify(envelope) };
}
export function launchFundingComparison(
  selection: WalletFundingSelection,
  source: LaunchFundingSource,
  input: readonly Batch[],
) {
  const wallets = launchFundingSelection(selection);
  if (source !== 'saved' && source !== 'provider')
    throw Error('Unknown funding source.');
  if (input.length !== Math.ceil(wallets.length / 100))
    throw Error('Launch funding batches are incomplete.');
  const batches = input.map((batch, index) => {
    const requested = wallets.slice(index * 100, index * 100 + 100);
    return source === 'saved'
      ? decodeWalletFundingTimes(batch, requested)
      : decodeFundingOriginBatch(batch, requested, requested);
  });
  const observations: Array<
    | WalletFundingTimes['wallets'][number]
    | FundingOriginBatch['wallets'][number]
  > = [];
  for (const batch of batches) observations.push(...batch.wallets);
  return {
    source,
    observations,
    pairs: compareFundingEventTimes(observations, 1800, 500),
    batches,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export type LaunchFundingComparison = ReturnType<
  typeof launchFundingComparison
>;

function wait(milliseconds: number, signal: AbortSignal) {
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
    }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
type Dependencies = {
  fetcher?: typeof fetch;
  provider?: typeof readProviderFundingOrigins;
  sleep?: typeof wait;
  onProviderRead?: () => void;
};
/** Explicit advisory reads only. Original per-request schemas and gates stay intact. */
export async function readLaunchFundingTimes(
  value: WalletFundingSelection,
  source: LaunchFundingSource,
  caller: AbortSignal,
  progress: (value: FundingOriginProgress) => void,
  deps: Dependencies = {},
) {
  const wallets = launchFundingSelection(value);
  if (source !== 'saved' && source !== 'provider')
    throw Error('Unknown funding source.');
  const signal = AbortSignal.any([
    caller,
    AbortSignal.timeout(source === 'saved' ? 90000 : 3600000),
  ]);
  const batches: Batch[] = [];
  let completed = 0;
  try {
    for (let start = 0; start < wallets.length; start += 100) {
      signal.throwIfAborted();
      if (source === 'provider' && start) {
        progress({ completed, total: wallets.length, phase: 'waiting' });
        await (deps.sleep ?? wait)(17000, signal);
      }
      const requested = wallets.slice(start, start + 100);
      progress({ completed, total: wallets.length, phase: 'reading' });
      signal.throwIfAborted();
      if (source === 'provider') {
        deps.onProviderRead?.();
        const batch = await (deps.provider ?? readProviderFundingOrigins)(
          requested,
          signal,
          (p) => {
            if (p.phase === 'reading') deps.onProviderRead?.();
            completed = start + p.completed;
            progress({
              completed,
              total: wallets.length,
              phase: p.phase === 'complete' ? 'reading' : p.phase,
            });
          },
        );
        signal.throwIfAborted();
        batches.push(decodeFundingOriginBatch(batch, requested, requested));
      } else {
        const current = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
        const response = await (deps.fetcher ?? fetch)(
          '/api/wallet-workspace/funding-times',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wallets: requested }),
            cache: 'no-store',
            signal: current,
          },
        );
        if (current.aborted) {
          void response.body?.cancel().catch(() => {});
          current.throwIfAborted();
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new FundingHttpError(response.status);
        }
        batches.push(
          decodeWalletFundingTimes(
            await readBoundedPanelJson(response, current),
            requested,
          ),
        );
        current.throwIfAborted();
      }
      completed = start + requested.length;
    }
    signal.throwIfAborted();
    const result = launchFundingComparison(wallets, source, batches);
    signal.throwIfAborted();
    progress({
      completed: wallets.length,
      total: wallets.length,
      phase: 'complete',
    });
    return result;
  } catch (error) {
    caller.throwIfAborted();
    throw new LaunchFundingReadError(
      error instanceof FundingOriginClientError ||
        error instanceof FundingHttpError
        ? error.status
        : signal.aborted ||
            (typeof error === 'object' &&
              error !== null &&
              'name' in error &&
              error.name === 'TimeoutError')
          ? 408
          : 502,
      source,
      completed,
      wallets.length,
    );
  }
}
