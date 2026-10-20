import { rawToDecimal } from './auto-sell';
import type { VaultSession } from './browser-wallet-vault';
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
  ) {
    super(message);
  }
}

/** Stopped after registration but before the send started. */
class AutoSellNotSentError extends Error {
  constructor() {
    super('Auto Sell stopped before sending.');
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
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error bodies fall through to the status check.
  }
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
    throw new Error(
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
    const review = reviewed.review as WarmupSigningReview | undefined;
    if (
      !review ||
      review.preparationId !== history.id ||
      review.wallet !== wallet.address ||
      review.sha256 !== order.preparation.sha256 ||
      review.transaction !== order.preparation.transaction ||
      review.inputRaw !== amountRaw.toString() ||
      review.inputMint !== deps.mint ||
      review.outputMint !== SOL ||
      review.network !== 'mainnet'
    )
      throw new Error('Approval review differs from the prepared sell.');
    const session = deps.session();
    if (!session) throw new Error('Wallet vault is locked.');
    const assertCurrent = () => {
      if (signal.aborted || deps.session() !== session)
        throw new Error('Auto Sell stopped.');
    };
    const packet = await sign(session, review, assertCurrent);
    try {
      const registered = await postJson(
        fetcher,
        '/api/imported-projects/signing',
        { action: 'register', id: review.id, transaction: packet.transaction },
        signal,
      );
      if (registered.signature !== packet.signature)
        throw new Error('Registered signature mismatch.');
      // Stop pressed while registering: never start the send. The registered
      // packet is left unsent and expires with its blockhash.
      if (signal.aborted) throw new AutoSellNotSentError();
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
    } catch (error) {
      if (error instanceof AutoSellNotSentError) throw error;
      // A signed packet may already be on chain. Never resell this amount.
      throw new AutoSellUncertainError(
        `${error instanceof Error ? error.message : 'Submission unknown'}. Check signature ${packet.signature} in preparation history.`,
        packet.signature,
        wallet.address,
      );
    }
    return {
      soldRaw: amountRaw,
      signature: packet.signature,
      wallet: wallet.address,
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
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : 'failed';
        errors.push(`${wallet.address.slice(0, 4)}…: ${message}`);
        // Signed sells are never retried on another wallet.
        if (error instanceof AutoSellUncertainError) throw error;
      }
    }
    throw new Error(errors.join(' · '));
  };
}
