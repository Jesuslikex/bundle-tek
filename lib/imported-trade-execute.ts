import { rawToDecimal } from './auto-sell';
import { abortableSleep } from './auto-sell-execute';
import { readBoundedPanelJson } from './read-bounded-panel-json';
import { readUserSettings } from './user-settings';
import type { VaultSession } from './browser-wallet-vault';
import {
  signApprovedWarmupPacket,
  type WarmupSigningReview,
} from './warmup-signing';

// One imported-token market trade from one wallet through the existing
// server pipeline: prepare -> review wait -> approval review -> local vault
// signature -> register -> one submit. Used by Instant Trade (the user's click
// or hotkey is the approval) and the opt-in Auto Buy run. Server-side balance,
// simulation, instruction and rate checks are unchanged.

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export type TradeSide = 'Buy' | 'Sell';
export type TradeWallet = { address: string; revision: number };
export type ImportedTradeContext = {
  projectId: string;
  projectRevision: number;
  mint: string;
  decimals: number;
  session: () => VaultSession | null;
  slippageBps?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  sign?: typeof signApprovedWarmupPacket;
};
export type ImportedTradeResult = {
  side: TradeSide;
  wallet: string;
  inputRaw: string;
  signature: string;
  preparationId: string;
};

/** Signed; landing unknown. The caller must never retry this trade. */
export class TradeUncertainError extends Error {
  readonly uncertain = true;
  constructor(
    message: string,
    readonly signature: string,
    readonly wallet: string,
  ) {
    super(message);
  }
}
export class TradeRequestError extends Error {
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
    if (response.ok) throw new Error('Trade server response unavailable.');
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
    throw new TradeRequestError(
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

/** Reads one wallet's native lamports and unfrozen token units. */
export async function readTradeWalletBalance(
  ctx: Pick<
    ImportedTradeContext,
    'projectId' | 'projectRevision' | 'mint' | 'fetcher'
  >,
  wallet: TradeWallet,
  signal: AbortSignal,
) {
  const data = await postJson(
    ctx.fetcher ?? fetch,
    '/api/imported-projects/balance',
    {
      id: ctx.projectId,
      revision: ctx.projectRevision,
      wallet: wallet.address,
      walletRevision: wallet.revision,
      side: 'Buy',
      amount: '0.000000001',
    },
    signal,
  );
  const report = data.report as
    | {
        wallet?: string;
        mint?: string;
        nativeRaw?: string;
        unfrozenRaw?: string;
      }
    | undefined;
  const uint = (v: unknown) =>
    typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v) ? BigInt(v) : null;
  const nativeRaw = uint(report?.nativeRaw),
    tokenRaw = uint(report?.unfrozenRaw);
  if (
    data.id !== ctx.projectId ||
    report?.wallet !== wallet.address ||
    report.mint !== ctx.mint ||
    nativeRaw === null ||
    tokenRaw === null
  )
    throw new Error('Balance report does not match this wallet.');
  return { nativeRaw, tokenRaw };
}

/**
 * Reads unfrozen token units for many wallets with one gated server read per
 * 25 wallets (the account's 15-second wallet-read gate is waited out between
 * chunks). Returns token raw units keyed by wallet address.
 */
export async function readGroupTokenBalances(
  ctx: Pick<
    ImportedTradeContext,
    'projectId' | 'projectRevision' | 'mint' | 'fetcher' | 'sleep'
  >,
  wallets: TradeWallet[],
  signal: AbortSignal,
): Promise<Record<string, bigint>> {
  const fetcher = ctx.fetcher ?? fetch;
  const sleep = ctx.sleep ?? abortableSleep;
  const out: Record<string, bigint> = {};
  for (let i = 0; i < wallets.length; i += 25) {
    const chunk = wallets.slice(i, i + 25);
    const data = await withRateRetry(
      () =>
        postJson(
          fetcher,
          '/api/imported-projects/inventory/refresh',
          {
            id: ctx.projectId,
            revision: ctx.projectRevision,
            scope: 'mint',
            wallets: chunk.map((w) => ({
              address: w.address,
              revision: w.revision,
            })),
          },
          signal,
        ),
      sleep,
      signal,
    );
    const items = Array.isArray(data.items) ? data.items : [];
    if (
      data.id !== ctx.projectId ||
      data.mint !== ctx.mint ||
      items.length !== chunk.length
    )
      throw new Error('Holdings refresh does not match these wallets.');
    for (const item of items as {
      wallet?: string;
      observation?: { unfrozenRaw?: string } | null;
    }[]) {
      const raw = item.observation?.unfrozenRaw;
      if (
        !item.wallet ||
        !chunk.some((w) => w.address === item.wallet) ||
        typeof raw !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(raw)
      )
        throw new Error('Holdings refresh does not match these wallets.');
      out[item.wallet] = BigInt(raw);
    }
  }
  return out;
}

/**
 * Executes one trade. `inputRaw` is lamports for a Buy and token units for a
 * Sell. Throws TradeUncertainError once a signature exists.
 */
export async function executeImportedTrade(
  ctx: ImportedTradeContext,
  wallet: TradeWallet,
  side: TradeSide,
  inputRaw: bigint,
  signal: AbortSignal,
): Promise<ImportedTradeResult> {
  if (inputRaw <= 0n) throw new Error('Amount must be positive.');
  const fetcher = ctx.fetcher ?? fetch;
  const sleep = ctx.sleep ?? abortableSleep;
  const sign = ctx.sign ?? signApprovedWarmupPacket;
  const inputMint = side === 'Buy' ? SOL_MINT : ctx.mint;
  const outputMint = side === 'Buy' ? ctx.mint : SOL_MINT;
  const amount = rawToDecimal(inputRaw, side === 'Buy' ? 9 : ctx.decimals);
  const prepared = await withRateRetry(
    () =>
      postJson(
        fetcher,
        '/api/imported-projects/prepare',
        {
          id: ctx.projectId,
          revision: ctx.projectRevision,
          wallet: wallet.address,
          walletRevision: wallet.revision,
          side,
          amount,
          ...(ctx.slippageBps === undefined
            ? {}
            : { slippageBps: ctx.slippageBps }),
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
  const simulation = prepared.simulation as { succeeded?: boolean } | undefined;
  if (
    !order ||
    order.side !== side ||
    order.inAmount !== inputRaw.toString() ||
    order.inputMint !== inputMint ||
    order.outputMint !== outputMint ||
    order.preparation?.wallet !== wallet.address ||
    typeof order.preparation.transaction !== 'string' ||
    typeof history?.id !== 'string'
  )
    throw new Error('Preparation does not match this trade.');
  if (simulation && simulation.succeeded === false)
    throw new Error('Simulation failed for this trade.');
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
    review.inputRaw !== inputRaw.toString() ||
    review.inputMint !== inputMint ||
    review.outputMint !== outputMint ||
    review.network !== 'mainnet'
  )
    throw new Error('Approval review differs from the prepared trade.');
  const session = ctx.session();
  if (!session) throw new Error('Wallet vault is locked.');
  const packet = await sign(session, review, () => {
    if (signal.aborted || ctx.session() !== session)
      throw new Error('Trade stopped.');
  });
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
      throw new Error('Registration differs. Recover the original approval.');
    signal.throwIfAborted();
    // Once sent, the server sends once and never resends: await the outcome.
    const submitted = await postJson(
      fetcher,
      '/api/imported-projects/signing',
      {
        action: 'submit',
        id: review.id,
        transaction: packet.transaction,
        ...(readUserSettings().tradePanel.providerRacing ? { race: true } : {}),
      },
      AbortSignal.timeout(40000),
    );
    if (
      submitted.signature !== packet.signature ||
      submitted.state !== 'submitted'
    )
      throw new Error('Submission acknowledgement differs.');
  } catch (error) {
    throw new TradeUncertainError(
      `${error instanceof Error ? error.message : 'Submission unknown'}. Check signature ${packet.signature} in preparation history.`,
      packet.signature,
      wallet.address,
    );
  }
  return {
    side,
    wallet: wallet.address,
    inputRaw: inputRaw.toString(),
    signature: packet.signature,
    preparationId: history.id,
  };
}

export type MultiWalletOutcome =
  | { wallet: string; ok: true; result: ImportedTradeResult }
  | { wallet: string; ok: false; error: string; uncertain: boolean };

/**
 * Runs one trade per wallet. Stagger runs them in order with `delayMs`
 * between starts; Parallel starts all at once. A failure on one wallet never
 * retries on another, and nothing is atomic across wallets.
 */
export async function executeAcrossWallets(
  wallets: TradeWallet[],
  mode: 'Stagger' | 'Parallel',
  delayMs: number,
  run: (
    wallet: TradeWallet,
    signal: AbortSignal,
  ) => Promise<ImportedTradeResult>,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  onOutcome?: (o: MultiWalletOutcome) => void,
): Promise<MultiWalletOutcome[]> {
  const one = async (wallet: TradeWallet): Promise<MultiWalletOutcome> => {
    let outcome: MultiWalletOutcome;
    try {
      outcome = {
        wallet: wallet.address,
        ok: true,
        result: await run(wallet, signal),
      };
    } catch (error) {
      outcome = {
        wallet: wallet.address,
        ok: false,
        error: error instanceof Error ? error.message : 'Trade failed.',
        uncertain: error instanceof TradeUncertainError,
      };
    }
    onOutcome?.(outcome);
    return outcome;
  };
  if (mode === 'Parallel') return Promise.all(wallets.map(one));
  const out: MultiWalletOutcome[] = [];
  for (let i = 0; i < wallets.length; i++) {
    if (signal.aborted) break;
    if (i > 0 && delayMs > 0) {
      try {
        await sleep(delayMs, signal);
      } catch {
        break;
      }
    }
    out.push(await one(wallets[i]));
  }
  return out;
}

/** Sell size: percent (up to 4 dp) of the observed unfrozen balance. */
export function percentOfBalance(balanceRaw: bigint, percent: string) {
  if (!/^(100(\.0{1,4})?|[1-9]?\d(\.\d{1,4})?)$/.test(percent))
    throw new Error('Use a percent from 0.0001 to 100.');
  const [whole, frac = ''] = percent.split('.');
  const units = BigInt(whole) * 10000n + BigInt(frac.padEnd(4, '0'));
  if (units <= 0n) throw new Error('Use a percent from 0.0001 to 100.');
  return (balanceRaw * units) / 1_000_000n;
}

/**
 * Trades from the selected wallets in rotation. A wallet that fails before
 * signing is skipped for the next one; a signed trade is never retried.
 */
export function createRotatingTrader(
  ctx: ImportedTradeContext,
  wallets: TradeWallet[],
  side: TradeSide,
) {
  let next = 0;
  return async (inputRaw: bigint, signal: AbortSignal) => {
    if (!wallets.length) throw new Error('No wallets selected.');
    const errors: string[] = [];
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[(next + i) % wallets.length];
      try {
        const r = await executeImportedTrade(
          ctx,
          wallet,
          side,
          inputRaw,
          signal,
        );
        next = (next + i + 1) % wallets.length;
        return r;
      } catch (error) {
        if (signal.aborted || error instanceof TradeUncertainError) throw error;
        errors.push(
          `${wallet.address.slice(0, 4)}…: ${error instanceof Error ? error.message : 'failed'}`,
        );
      }
    }
    throw new Error(errors.join(' · '));
  };
}
