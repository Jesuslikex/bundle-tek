import { z } from 'zod';
import type { SavedWarmup } from './wallet-warmup-storage';
import { walletWarmupSessionView } from './wallet-warmup-session-view';
import type { WarmupSessionAction } from './wallet-warmup-session-review';

/** A floor for successive review requests, not a replacement for provider pacing. */
export const WARMUP_SESSION_REVIEW_GAP_MS = 15000;
const units = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) <= (1n << 64n) - 1n);
const signedUnits = z
  .string()
  .regex(/^(0|-?[1-9]\d{0,19})$/)
  .refine(
    (v) => BigInt(v) >= -((1n << 64n) - 1n) && BigInt(v) <= (1n << 64n) - 1n,
  );
const receiptId = z.uuid().refine((v) => v === v.toLowerCase());
const receipt = z
  .object({
    actionId: z.string(),
    planId: z.string(),
    planRevision: z.number().int().positive(),
    wallet: z.string(),
    walletRevision: z.number().int().positive(),
    mint: z.string(),
    receiptId,
    network: z.literal('mainnet'),
    commitment: z.literal('finalized'),
    verified: z.literal(true),
    networkFeeLamports: units,
    rentChangeLamports: signedUnits,
  })
  .strict();
const settlement = z.discriminatedUnion('side', [
  receipt
    .extend({
      side: z.literal('Buy'),
      inputLamports: units,
      acquiredRaw: units,
      decimals: z.number().int().min(0).max(18),
    })
    .strict(),
  receipt
    .extend({
      side: z.literal('Sell'),
      buyReceiptId: receiptId,
      consumedRaw: units,
    })
    .strict(),
]);
type Settlement = z.infer<typeof settlement>;
/** Shape consistency only. This does not verify a receipt or grant authority. */
export function parseWalletWarmupSessionSettlement(value: unknown) {
  return settlement.parse(value);
}
type Entry = {
  action: WarmupSessionAction;
  state: 'queued' | 'reviewing' | 'submitted' | 'unknown' | 'finalized';
  settlement?: Settlement;
};
const fail = (): never => {
  throw Error('Session sequence evidence changed or requires recovery.');
};

/**
 * Internal bookkeeping over an admitted, unsigned review. No timers, callbacks,
 * provider calls or signing capability. Receipt flags are NOT on-chain proof:
 * any future caller must replay the real retained receipt before passing it here.
 */
export class WalletWarmupSessionSequence {
  private readonly review;
  private readonly expiresAt: number;
  private readonly entries: Entry[];
  private readonly fees = new Map<string, bigint>();
  private readonly buys = new Map<string, bigint>();
  private readonly receipts = new Set<string>();
  private lastClock: number;
  private nextReviewAt = 0;
  private pending: string | null = null;
  private paused = false;
  private stopped = false;

  constructor(value: unknown, plan: SavedWarmup, now = Date.now()) {
    const admitted = walletWarmupSessionView(value, plan, now);
    this.review = structuredClone(admitted.review);
    this.expiresAt = admitted.deadline;
    this.lastClock = now;
    this.entries = this.review.actions.map((action) => ({
      action,
      state: 'queued',
    }));
    for (const action of this.review.actions) {
      if (action.side === 'Sell' && action.source.kind === 'saved-buy')
        this.receipts.add(action.source.buyReceiptId);
    }
    this.review.wallets.forEach((w) => {
      this.fees.set(w.wallet, 0n);
      this.buys.set(w.wallet, 0n);
    });
  }
  private clock(now: number) {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > 8640000000000000 - WARMUP_SESSION_REVIEW_GAP_MS ||
      now < this.lastClock
    )
      return fail();
    this.lastClock = now;
  }
  private entry(id: string) {
    return this.entries.find((e) => e.action.id === id) ?? fail();
  }
  private source(action: WarmupSessionAction) {
    if (action.side === 'Buy') return null;
    if (action.source.kind === 'saved-buy')
      return {
        buyReceiptId: action.source.buyReceiptId,
        remainingRaw: action.source.remainingRaw,
        decimals: action.source.decimals,
      };
    const buy = this.entry(action.source.actionId);
    return buy.state === 'finalized' && buy.settlement?.side === 'Buy'
      ? {
          buyReceiptId: buy.settlement.receiptId,
          remainingRaw: buy.settlement.acquiredRaw,
          decimals: buy.settlement.decimals,
        }
      : null;
  }
  snapshot(now = Date.now()) {
    this.clock(now);
    const pending = this.pending ? this.entry(this.pending) : null;
    const queued = this.entries.find((e) => e.state === 'queued');
    const complete = this.entries.every((e) => e.state === 'finalized');
    const due = queued
      ? Math.max(Date.parse(queued.action.scheduledAt), this.nextReviewAt)
      : null;
    const phase =
      pending?.state === 'unknown'
        ? 'recovery-required'
        : this.stopped
          ? 'stopped'
          : pending
            ? 'in-flight'
            : complete
              ? 'complete'
              : this.paused
                ? 'paused'
                : now >= this.expiresAt
                  ? 'refresh-required'
                  : due !== null &&
                      now >= due &&
                      (queued!.action.side === 'Buy' ||
                        this.source(queued!.action))
                    ? 'review-required'
                    : 'waiting';
    return structuredClone({
      phase,
      planId: this.review.planId,
      planRevision: this.review.planRevision,
      contextKey: this.review.contextKey,
      sourceReviewFresh: now < this.expiresAt,
      sourceReviewExpiresAt: new Date(this.expiresAt).toISOString(),
      completedActions: this.entries.filter((e) => e.state === 'finalized')
        .length,
      totalActions: this.entries.length,
      nextReviewAt: due === null ? null : new Date(due).toISOString(),
      pending: pending
        ? { action: pending.action, state: pending.state }
        : null,
      paused: this.paused,
      stopped: this.stopped,
      wallets: this.review.wallets.map((w) => ({
        wallet: w.wallet,
        recordedFurtherBuySpendLamports: this.buys.get(w.wallet)!.toString(),
        recordedFurtherFeeRentLamports: this.fees.get(w.wallet)!.toString(),
        remainingReserveLamports: (
          BigInt(w.remainingFeeReserveLamports) - this.fees.get(w.wallet)!
        ).toString(),
      })),
      executionAllowed: false as const,
      signingAllowed: false as const,
      automaticExecutionAllowed: false as const,
    });
  }
  /** Reserves one review slot only. This is not an approval or a send request. */
  beginReview(now = Date.now()) {
    if (this.snapshot(now).phase !== 'review-required') return fail();
    const entry = this.entries.find((e) => e.state === 'queued')!;
    entry.state = 'reviewing';
    this.pending = entry.action.id;
    return structuredClone({
      action: entry.action,
      sellSource: this.source(entry.action),
      executionAllowed: false as const,
      signingAllowed: false as const,
    });
  }
  /** Observation only: a late response must remain recordable after pause, stop or expiry. */
  recordSubmission(actionId: string, now = Date.now()) {
    this.clock(now);
    const entry = this.entry(actionId);
    if (this.pending !== actionId || entry.state !== 'reviewing') return fail();
    entry.state = 'submitted';
    return this.snapshot(now);
  }
  requireRecovery(actionId: string, now = Date.now()) {
    this.clock(now);
    const entry = this.entry(actionId);
    if (
      this.pending !== actionId ||
      !['reviewing', 'submitted', 'unknown'].includes(entry.state)
    )
      return fail();
    entry.state = 'unknown';
    return this.snapshot(now);
  }
  /** Record only after the existing finalized-receipt verifier has admitted it. */
  recordFinalized(value: unknown, now = Date.now()) {
    this.clock(now);
    const result = parseWalletWarmupSessionSettlement(value),
      entry = this.entry(result.actionId),
      action = entry.action;
    if (entry.state === 'finalized') {
      if (JSON.stringify(entry.settlement) !== JSON.stringify(result))
        return fail();
      return this.snapshot(now);
    }
    if (
      this.pending !== action.id ||
      !['submitted', 'unknown'].includes(entry.state) ||
      result.planId !== this.review.planId ||
      result.planRevision !== this.review.planRevision ||
      result.wallet !== action.wallet ||
      result.walletRevision !== action.walletRevision ||
      result.mint !== action.mint ||
      result.side !== action.side ||
      this.receipts.has(result.receiptId)
    )
      return fail();
    if (action.side === 'Buy') {
      if (
        result.side !== 'Buy' ||
        result.inputLamports !== action.inputLamports ||
        result.acquiredRaw === '0'
      )
        return fail();
    } else {
      const source = this.source(action);
      if (
        result.side !== 'Sell' ||
        !source ||
        result.buyReceiptId !== source.buyReceiptId ||
        result.consumedRaw !== source.remainingRaw ||
        result.consumedRaw === '0'
      )
        return fail();
    }
    const cost =
      BigInt(result.networkFeeLamports) +
      (BigInt(result.rentChangeLamports) > 0n
        ? BigInt(result.rentChangeLamports)
        : 0n);
    const used = this.fees.get(action.wallet)! + cost;
    const budget = this.review.wallets.find((w) => w.wallet === action.wallet)!;
    const buySpend =
      this.buys.get(action.wallet)! +
      (result.side === 'Buy' ? BigInt(result.inputLamports) : 0n);
    if (
      used > BigInt(budget.remainingFeeReserveLamports) ||
      buySpend > BigInt(budget.buySpendLamports)
    )
      return fail();
    entry.settlement = result;
    entry.state = 'finalized';
    this.receipts.add(result.receiptId);
    this.fees.set(action.wallet, used);
    this.buys.set(action.wallet, buySpend);
    this.pending = null;
    this.nextReviewAt = now + WARMUP_SESSION_REVIEW_GAP_MS;
    return this.snapshot(now);
  }
  pause(now = Date.now()) {
    this.clock(now);
    if (this.stopped) return fail();
    this.paused = true;
    return this.snapshot(now);
  }
  resume(now = Date.now()) {
    this.clock(now);
    if (this.stopped || !this.paused) return fail();
    this.paused = false;
    return this.snapshot(now);
  }
  /** Stop is terminal; already submitted outcomes can still be recorded. */
  stop(now = Date.now()) {
    this.clock(now);
    this.stopped = true;
    return this.snapshot(now);
  }
}
