import { rawToDecimal } from './auto-sell';
import { readBoundedPanelJson } from './read-bounded-panel-json';
import {
  AutoSellReviewRecoveryError,
  validatedAutoSellReviewReference,
} from './auto-sell-review-recovery';
import type { VaultSession } from './browser-wallet-vault';
import type { AutoSellOutcomeReference } from './auto-sell-outcome-reference';
import {
  signApprovedWarmupPacket,
  type WarmupSigningReview,
} from './warmup-signing';

// Drives the existing imported-token sell pipeline without clicks:
// prepare -> server review wait -> approval review -> local vault signature
// -> register -> submit. Server checks (balance, simulation, instruction
// review, rate gates) are unchanged; this only answers them automatically
// for strategies the user armed with Run Strategy.

export type AutoSellWallet = { address: string; revision: number };

export type AutoSellExecuteDeps = {
  projectId: string;
  projectRevision: number;
  mint: string;
  decimals: number;
  wallets: AutoSellWallet[];
  session: () => VaultSession | null;
  fetcher?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  sign?: typeof signApprovedWarmupPacket;
};

const SOL = 'So11111111111111111111111111111111111111112';

export function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Stopped.'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Stopped.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The sell was signed; whether it landed is unknown. Do not retry it. */
export class AutoSellUncertainError extends Error {
  readonly uncertain = true;
  constructor(
    message: string,
    readonly signature: string,
    readonly wallet: string,
    readonly outcome?: AutoSellOutcomeReference,
  ) {
    super(message);
  }
}

class AutoSellRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class RetryLater extends Error {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message);
  }
}

async function postJson(
  fetcher: typeof fetch,
  url: string,
  body: unknown,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const current = AbortSignal.any([signal, AbortSignal.timeout(40000)]);
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: current,
    cache: 'no-store',
    redirect: 'error',
  });
  let data: Record<string, unknown> = {};
  try {
    const value = await readBoundedPanelJson(response, current);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    data = value as Record<string, unknown>;
  } catch {
    if (current.aborted) throw current.reason;
    if (response.ok) throw new Error('Auto Sell server response unavailable.');
    // An unavailable error body never exposes raw parser or HTML diagnostics.
  }
  current.throwIfAborted();
  if (response.status === 429) {
    const wait =
      typeof data.reviewWaitMs === 'number' &&
      Number.isSafeInteger(data.reviewWaitMs)
        ? Math.min(15000, Math.max(0, data.reviewWaitMs))
        : 15000;
    throw new RetryLater(
      typeof data.error === 'string' ? data.error : 'Rate limited.',
      wait + 250,
    );
  }
  if (!response.ok)
    throw new AutoSellRequestError(
      response.status,
      typeof data.error === 'string' ? data.error : `HTTP ${response.status}`,
    );
  return data;
}

async function withRateRetry<T>(
  run: () => Promise<T>,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof RetryLater) || attempt >= 4) throw error;
      await sleep(error.waitMs, signal);
    }
  }
}

export function createAutoSellExecutor(deps: AutoSellExecuteDeps) {
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? abortableSleep;
  const sign = deps.sign ?? signApprovedWarmupPacket;
  let next = 0;

  async function sellFrom(
    wallet: AutoSellWallet,
    amountRaw: bigint,
    signal: AbortSignal,
  ) {
    const amount = rawToDecimal(amountRaw, deps.decimals);
    const prepared = await withRateRetry(
      () =>
        postJson(
          fetcher,
          '/api/imported-projects/prepare',
          {
            id: deps.projectId,
            revision: deps.projectRevision,
            wallet: wallet.address,
            walletRevision: wallet.revision,
            side: 'Sell',
            amount,
          },
          signal,
        ),
      sleep,
      signal,
    );
    const order = prepared.order as
      | {
          side?: string;
          inAmount?: string;
          inputMint?: string;
          outputMint?: string;
          preparation?: {
            wallet?: string;
            transaction?: string;
            sha256?: string;
          };
        }
      | undefined;
    const history = prepared.history as { id?: string } | undefined;
    const simulation = prepared.simulation as
      | { succeeded?: boolean }
      | undefined;
    if (
      !order ||
      order.side !== 'Sell' ||
      order.inAmount !== amountRaw.toString() ||
      order.inputMint !== deps.mint ||
      order.outputMint !== SOL ||
      order.preparation?.wallet !== wallet.address ||
      typeof order.preparation.transaction !== 'string' ||
      typeof history?.id !== 'string'
    )
      throw new Error('Preparation does not match this sell.');
    if (simulation && simulation.succeeded === false)
      throw new Error('Simulation failed for this sell.');
    const wait =
      typeof prepared.reviewWaitMs === 'number' &&
      Number.isSafeInteger(prepared.reviewWaitMs)
        ? Math.min(15000, Math.max(0, prepared.reviewWaitMs))
        : 0;
    if (wait) await sleep(wait + 100, signal);
    const reviewReference = validatedAutoSellReviewReference({
      projectId: deps.projectId,
      projectRevision: deps.projectRevision,
      walletRevision: wallet.revision,
      preparationId: history.id,
      wallet: wallet.address,
      mint: deps.mint,
      inputRaw: amountRaw.toString(),
      preparationSha256: order.preparation.sha256,
    });
    let review: WarmupSigningReview;
    try {
      const reviewed = await withRateRetry(
        () =>
          postJson(
            fetcher,
            '/api/imported-projects/signing',
            {
              action: 'review',
              preparationId: history.id,
              transaction: order.preparation!.transaction,
            },
            signal,
          ),
        sleep,
        signal,
      );
      const candidate = reviewed.review as WarmupSigningReview | undefined;
      if (
        !candidate ||
        candidate.preparationId !== history.id ||
        candidate.wallet !== wallet.address ||
        candidate.sha256 !== order.preparation.sha256 ||
        candidate.transaction !== order.preparation.transaction ||
        candidate.inputRaw !== amountRaw.toString() ||
        candidate.inputMint !== deps.mint ||
        candidate.outputMint !== SOL ||
        candidate.network !== 'mainnet'
      )
        throw new Error('Approval review differs from the prepared sell.');
      review = candidate;
    } catch (error) {
      throw new AutoSellReviewRecoveryError(
        reviewReference,
        error instanceof AutoSellRequestError && error.status === 409,
      );
    }
    let packet: Awaited<ReturnType<typeof sign>>;
    try {
      const session = deps.session();
      if (!session) throw new Error('Wallet vault is locked.');
      const assertCurrent = () => {
        if (signal.aborted || deps.session() !== session)
          throw new Error('Auto Sell stopped.');
      };
      packet = await sign(session, review, assertCurrent);
    } catch {
      throw new AutoSellReviewRecoveryError(reviewReference);
    }
    const outcome: AutoSellOutcomeReference = Object.freeze({
      projectId: deps.projectId,
      projectRevision: deps.projectRevision,
      walletRevision: wallet.revision,
      preparationId: review.preparationId,
      intentId: review.id,
      wallet: wallet.address,
      mint: deps.mint,
      inputRaw: amountRaw.toString(),
      preparationSha256: review.sha256,
      signature: packet.signature,
    });
    try {
      const registered = await postJson(
        fetcher,
        '/api/imported-projects/signing',
        { action: 'register', id: review.id, transaction: packet.transaction },
        signal,
      );
      if (registered.signature !== packet.signature)
        throw new Error('Registered signature mismatch.');
      if (registered.state !== 'signed')
        throw new Error(
          'Registration is not ready for a new send. Recover the original approval.',
        );
      // Stop still prevents a new send. Once signed, keep the original
      // exposure/recovery reference even if no acknowledgement was readable.
      signal.throwIfAborted();
      // Once the send has started it is not aborted: the server sends it once
      // and never resends, so the outcome must be awaited and recorded.
      const submitted = await postJson(
        fetcher,
        '/api/imported-projects/signing',
        { action: 'submit', id: review.id, transaction: packet.transaction },
        AbortSignal.timeout(40000),
      );
      if (submitted.signature !== packet.signature)
        throw new Error('Submitted signature mismatch.');
      if (submitted.state !== 'submitted')
        throw new Error(
          'Submission acknowledgement differs. Recover the original approval.',
        );
    } catch (error) {
      // A signed packet may already be on chain. Never resell this amount.
      throw new AutoSellUncertainError(
        `${error instanceof Error ? error.message : 'Submission unknown'}. Check signature ${packet.signature} in preparation history.`,
        packet.signature,
        wallet.address,
        outcome,
      );
    }
    return {
      soldRaw: amountRaw,
      signature: packet.signature,
      wallet: wallet.address,
      outcome,
    };
  }

  /** Tries each selected wallet in turn, starting after the last one used. */
  return async function sell(amountRaw: bigint, signal: AbortSignal) {
    if (!deps.wallets.length) throw new Error('No sell wallets selected.');
    const errors: string[] = [];
    for (let i = 0; i < deps.wallets.length; i++) {
      const wallet = deps.wallets[(next + i) % deps.wallets.length];
      try {
        const result = await sellFrom(wallet, amountRaw, signal);
        next = (next + i + 1) % deps.wallets.length;
        return result;
      } catch (error) {
        if (signal.aborted || error instanceof AutoSellReviewRecoveryError)
          throw error;
        const message = error instanceof Error ? error.message : 'failed';
        errors.push(`${wallet.address.slice(0, 4)}…: ${message}`);
        // Signed sells are never retried on another wallet.
        if (error instanceof AutoSellUncertainError) throw error;
      }
    }
    throw new Error(errors.join(' · '));
  };
}
