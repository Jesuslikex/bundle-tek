import { rawToDecimal } from './auto-sell';
import { abortableSleep } from './auto-sell-execute';
import { readBoundedPanelJson } from './read-bounded-panel-json';
import type { VaultSession } from './browser-wallet-vault';
import {
  signApprovedWarmupPacket,
  type WarmupSigningReview,
} from './warmup-signing';

// Drives the existing imported-token trade pipeline for Cleanup rounds:
// prepare -> server review -> local vault signature -> register -> one send,
// then reads the finalized receipt. Server checks are unchanged; this only
// answers them for a Cleanup run the user started.

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export type CleanupSide = 'Buy' | 'Sell';
export type CleanupWallet = { address: string; revision: number };
export type CleanupTradeResult = {
  intentId: string;
  signature: string;
  wallet: string;
  side: CleanupSide;
  inputRaw: string;
};
export type CleanupFinalOutcome = {
  state: 'finalized' | 'failed';
  signature: string;
  /** Wallet lamport change, signed (a sell's proceeds are positive). */
  nativeChangeRaw: bigint | null;
  /** Coin units bought or sold, from the finalized receipt. */
  tokenUnitsRaw: bigint | null;
};
export type CleanupExecuteDeps = {
  projectId: string;
  projectRevision: number;
  mint: string;
  decimals: number;
  session: () => VaultSession | null;
  fetcher?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  sign?: typeof signApprovedWarmupPacket;
  /** How long to wait for a sent trade to finalize before stopping the run. */
  finalTimeoutMs?: number;
  pollMs?: number;
};

/** A trade was signed and may have landed; its outcome is not known yet. */
export class CleanupUncertainError extends Error {
  readonly uncertain = true;
  constructor(
    message: string,
    readonly signature: string,
    readonly wallet: string,
    readonly intentId: string,
  ) {
    super(message);
  }
}
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly waitMs = 0,
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
    if (response.ok) throw new Error('Cleanup server response unavailable.');
  }
  if (!response.ok) {
    const wait =
      typeof data.reviewWaitMs === 'number' &&
      Number.isSafeInteger(data.reviewWaitMs)
        ? Math.min(15000, Math.max(0, data.reviewWaitMs))
        : 15000;
    throw new RequestError(
      response.status,
      typeof data.error === 'string' ? data.error : `HTTP ${response.status}`,
      response.status === 429 ? wait + 250 : 0,
    );
  }
  return data;
}

export function createCleanupExecutor(deps: CleanupExecuteDeps) {
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? abortableSleep;
  const sign = deps.sign ?? signApprovedWarmupPacket;
  const pollMs = deps.pollMs ?? 4000;
  const finalTimeoutMs = deps.finalTimeoutMs ?? 120_000;
  const retry = async <T>(run: () => Promise<T>, signal: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (
          !(error instanceof RequestError) ||
          error.status !== 429 ||
          attempt >= 4
        )
          throw error;
        await sleep(error.waitMs, signal);
      }
    }
  };

  async function trade(
    wallet: CleanupWallet,
    side: CleanupSide,
    amountRaw: bigint,
    signal: AbortSignal,
  ): Promise<CleanupTradeResult> {
    const inputMint = side === 'Sell' ? deps.mint : SOL_MINT,
      outputMint = side === 'Sell' ? SOL_MINT : deps.mint;
    const prepared = await retry(
      () =>
        postJson(
          fetcher,
          '/api/imported-projects/prepare',
          {
            id: deps.projectId,
            revision: deps.projectRevision,
            wallet: wallet.address,
            walletRevision: wallet.revision,
            side,
            amount: rawToDecimal(
              amountRaw,
              side === 'Sell' ? deps.decimals : 9,
            ),
          },
          signal,
        ),
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
    if (
      !order ||
      order.side !== side ||
      order.inAmount !== amountRaw.toString() ||
      order.inputMint !== inputMint ||
      order.outputMint !== outputMint ||
      order.preparation?.wallet !== wallet.address ||
      typeof order.preparation.transaction !== 'string' ||
      typeof history?.id !== 'string'
    )
      throw new Error(`Preparation does not match this ${side.toLowerCase()}.`);
    if ((prepared.simulation as { succeeded?: boolean })?.succeeded === false)
      throw new Error(`Simulation failed for this ${side.toLowerCase()}.`);
    const reviewed = await retry(
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
      review.inputMint !== inputMint ||
      review.outputMint !== outputMint ||
      review.network !== 'mainnet'
    )
      throw new Error('Approval review differs from the prepared trade.');
    const session = deps.session();
    if (!session) throw new Error('Wallet vault is locked.');
    let packet: Awaited<ReturnType<typeof sign>>;
    try {
      packet = await sign(session, review, () => {
        if (signal.aborted || deps.session() !== session)
          throw new Error('Cleanup stopped.');
      });
    } catch (error) {
      // Nothing was signed: release the reservation so the wallet stays usable.
      await postJson(
        fetcher,
        '/api/imported-projects/signing',
        { action: 'cancel', id: review.id },
        AbortSignal.timeout(20000),
      ).catch(() => undefined);
      throw error;
    }
    try {
      const registered = await postJson(
        fetcher,
        '/api/imported-projects/signing',
        { action: 'register', id: review.id, transaction: packet.transaction },
        signal,
      );
      if (
        registered.signature !== packet.signature ||
        registered.state !== 'signed'
      )
        throw new Error('Registration differs.');
      signal.throwIfAborted();
      // Once started the send is not aborted: the server sends it once.
      const submitted = await postJson(
        fetcher,
        '/api/imported-projects/signing',
        { action: 'submit', id: review.id, transaction: packet.transaction },
        AbortSignal.timeout(40000),
      );
      if (
        submitted.signature !== packet.signature ||
        submitted.state !== 'submitted'
      )
        throw new Error('Submission acknowledgement differs.');
    } catch (error) {
      throw new CleanupUncertainError(
        `${error instanceof Error ? error.message : 'Submission unknown'} Check signature ${packet.signature} before trading this wallet again.`,
        packet.signature,
        wallet.address,
        review.id,
      );
    }
    return {
      intentId: review.id,
      signature: packet.signature,
      wallet: wallet.address,
      side,
      inputRaw: amountRaw.toString(),
    };
  }

  /** Polls the original approval until its finalized receipt or failure is known. */
  async function awaitFinal(
    sent: CleanupTradeResult,
    signal: AbortSignal,
  ): Promise<CleanupFinalOutcome> {
    const deadline = Date.now() + finalTimeoutMs;
    for (;;) {
      await sleep(pollMs, signal);
      try {
        const value = await postJson(
          fetcher,
          '/api/imported-projects/signing',
          { action: 'recover', id: sent.intentId },
          signal,
        );
        if (value.signature !== sent.signature)
          throw new Error('Recovered signature differs.');
        if (value.state === 'failed')
          return {
            state: 'failed',
            signature: sent.signature,
            nativeChangeRaw: null,
            tokenUnitsRaw: null,
          };
        if (value.state === 'finalized') {
          const document = (
            value.receipt as {
              document?: { nativeChangeRaw?: string; tokenUnitsRaw?: string };
            }
          )?.document;
          const int = (v: unknown) =>
            typeof v === 'string' && /^-?\d{1,20}$/.test(v) ? BigInt(v) : null;
          return {
            state: 'finalized',
            signature: sent.signature,
            nativeChangeRaw: int(document?.nativeChangeRaw),
            tokenUnitsRaw: int(document?.tokenUnitsRaw),
          };
        }
      } catch (error) {
        // A server answer (409: not finalized yet, 5xx: provider) keeps
        // waiting until the deadline; anything else stops the run.
        if (signal.aborted || !(error instanceof RequestError)) throw error;
      }
      if (Date.now() >= deadline)
        throw new CleanupUncertainError(
          `Trade ${sent.signature} has not finalized yet. Cleanup stopped; check it in preparation history.`,
          sent.signature,
          sent.wallet,
          sent.intentId,
        );
    }
  }

  return { trade, awaitFinal };
}
