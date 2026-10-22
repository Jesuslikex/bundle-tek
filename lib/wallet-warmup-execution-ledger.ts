import { z } from 'zod';
import bs58 from 'bs58';
import {
  bindWarmupExecutionManifest,
  warmupExecutionHash as hash,
  warmupExecutionId as uuid,
  warmupExecutionUnits as units,
  type WarmupExecutionManifest,
  WARMUP_EXECUTION_POLICY,
} from './wallet-warmup-execution-manifest';

export const WARMUP_EXECUTION_AUTHORIZATION_MS =
  WARMUP_EXECUTION_POLICY.authorizationMs;
export const WARMUP_EXECUTION_MODEL_STEPS = WARMUP_EXECUTION_POLICY.modelSteps;
const signature = z
  .string()
  .min(64)
  .max(88)
  .refine((v) => {
    try {
      return bs58.decode(v).length === 64;
    } catch {
      return false;
    }
  });
const base = z.object({
  expectedRootSha256: hash,
  expectedVersion: z.number().int().min(0),
  now: z.number().int().min(0),
});
const event = z.discriminatedUnion('operation', [
  base.extend({ operation: z.literal('reserve') }).strict(),
  base.extend({ operation: z.literal('cancel-unsigned') }).strict(),
  base.extend({ operation: z.literal('pause') }).strict(),
  base.extend({ operation: z.literal('resume') }).strict(),
  base.extend({ operation: z.literal('stop') }).strict(),
  base.extend({ operation: z.literal('unknown') }).strict(),
  base
    .extend({ operation: z.literal('qualify'), evidenceSha256: hash })
    .strict(),
  base
    .extend({
      operation: z.literal('prepare'),
      qualificationEvidenceSha256: hash,
      packetSha256: hash,
      minimumOutputRaw: units.refine((v) => BigInt(v) > 0n),
    })
    .strict(),
  base
    .extend({
      operation: z.literal('authorize'),
      id: uuid,
      packetSha256: hash,
      recheckSha256: hash,
    })
    .strict(),
  base
    .extend({
      operation: z.literal('dispatch-intent'),
      id: uuid,
      authorizationId: uuid,
      packetSha256: hash,
      signedPacketSha256: hash,
      signature,
    })
    .strict(),
  base
    .extend({
      operation: z.literal('recover-signed'),
      packetSha256: hash,
      signedPacketSha256: hash,
      signature,
    })
    .strict(),
  base
    .extend({
      operation: z.literal('settle'),
      packetSha256: hash,
      signedPacketSha256: hash,
      receiptId: uuid,
      sourceSha256: hash,
      signature,
      inputRaw: units,
      outputRaw: units,
      networkFeeLamports: units,
      rentDebitLamports: units,
      rentRefundLamports: units,
      landedFailure: z.boolean(),
    })
    .strict(),
]);
type Event = z.infer<typeof event>;
type Outcome = Extract<Event, { operation: 'settle' }> & {
  actionId: string;
  wallet: string;
  mint: string;
  side: 'Buy' | 'Sell';
  lotReceiptId: string | null;
  authorizationId: string;
  dispatchId: string | null;
  qualificationEvidenceSha256: string;
  disposition: 'applied' | 'held';
  reason: string | null;
};
type Lot = {
  receiptId: string;
  wallet: string;
  mint: string;
  tokenProgram: string;
  decimals: number;
  remainingRaw: string;
  sourceSha256: string;
  buyActionId?: string;
};
type Pending = {
  actionId: string;
  state:
    | 'reviewing'
    | 'prepared'
    | 'authorized'
    | 'dispatch-intent'
    | 'unknown'
    | 'held';
  inputRaw: string;
  lotReceiptId: string | null;
  qualification: { evidenceSha256: string; expiresAt: number } | null;
  prepared: {
    packetSha256: string;
    minimumOutputRaw: string;
    qualificationEvidenceSha256: string;
  } | null;
  authorization: {
    id: string;
    expiresAt: number;
    recheckSha256: string;
    qualificationEvidenceSha256: string;
  } | null;
  signed: {
    signature: string;
    signedPacketSha256: string;
    dispatchId: string | null;
  } | null;
  outcome:
    | (Extract<Event, { operation: 'settle' }> & { reason: string })
    | null;
};
function fail(): never {
  throw Error(
    'Warmup execution bookkeeping requires exact current context or recovery.',
  );
}
const authorities = {
  executionAllowed: false as const,
  signingAllowed: false as const,
  automaticExecutionAllowed: false as const,
};

/** Unmounted bookkeeping model only, not an executable receipt/consent verifier.
 * Every evidence/hash/signature input needs independent production verification
 * and a same-transaction source guard before any future durable writer uses it.
 * No API, signer, timer, provider, database or send callback is called here. */
export class WarmupExecutionLedger {
  private version = 0;
  private cursor = 0;
  private clock: number;
  private nextQualificationAt = 0;
  private paused = false;
  private stopped = false;
  private pending: Pending | null = null;
  private readonly attempts = new Map<string, number>();
  private readonly lots = new Map<string, Lot>();
  private readonly buyLots = new Map<string, string>();
  private qualifications = 0;
  private readonly receipts = new Set<string>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly signatures = new Set<string>();
  private readonly authorizations = new Set<string>();
  private readonly dispatches = new Set<string>();
  private readonly signedPackets = new Set<string>();
  private readonly preparations = new Map<
    string,
    { actionId: string; minimumOutputRaw: string }
  >();
  private readonly buySpent = new Map<string, bigint>();
  private readonly feeRentSpent = new Map<string, bigint>();

  private constructor(
    private readonly manifest: WarmupExecutionManifest,
    private readonly rootSha256: string,
  ) {
    this.clock = Date.parse(manifest.createdAt);
    for (const l of manifest.savedLots)
      this.lots.set(l.receiptId, structuredClone(l));
    for (const w of manifest.wallets) {
      this.buySpent.set(w.wallet, 0n);
      this.feeRentSpent.set(w.wallet, 0n);
    }
  }
  static async create(value: unknown) {
    const { manifest, sha256 } = await bindWarmupExecutionManifest(value);
    return new WarmupExecutionLedger(manifest, sha256);
  }
  private time(now: number) {
    if (
      !Number.isSafeInteger(now) ||
      now < this.clock ||
      now > 8640000000000000 - 60000
    )
      fail();
  }
  private active(now: number) {
    if (
      this.stopped ||
      this.paused ||
      now >= Date.parse(this.manifest.expiresAt)
    )
      fail();
  }
  private action() {
    return this.manifest.actions[this.cursor] ?? fail();
  }
  private requirePending() {
    return this.pending ?? fail();
  }
  private fresh(now: number) {
    this.active(now);
    const p = this.requirePending();
    if (!p.qualification || now >= p.qualification.expiresAt) fail();
    return p;
  }
  private recoveryRequired(now: number) {
    const p = this.pending;
    return (
      !!p &&
      (p.state === 'unknown' ||
        (!!p.authorization &&
          (this.stopped ||
            this.paused ||
            now >= Date.parse(this.manifest.expiresAt) ||
            this.version >= this.manifest.policy.modelSteps - 4 ||
            (p.state === 'authorized' && now >= p.authorization.expiresAt))))
    );
  }
  /** Detached projection only, not a recoverable or trusted storage checkpoint. */
  snapshot(now = this.clock) {
    this.time(now);
    const p = this.pending,
      action = this.manifest.actions[this.cursor];
    const needsRecovery = this.recoveryRequired(now);
    const phase =
      p?.state === 'held'
        ? 'held'
        : needsRecovery
          ? 'recovery-required'
          : this.stopped
            ? 'stopped'
            : this.cursor === this.manifest.actions.length
              ? 'complete'
              : now >= Date.parse(this.manifest.expiresAt)
                ? 'expired'
                : this.paused
                  ? 'paused'
                  : this.version >= this.manifest.policy.modelSteps - 4
                    ? 'model-capacity-exhausted'
                    : p?.state === 'dispatch-intent'
                      ? 'awaiting-outcome'
                      : p?.qualification && now >= p.qualification.expiresAt
                        ? 'review-expired'
                        : p
                          ? 'pending'
                          : action &&
                              (this.attempts.get(action.id) ?? 0) >=
                                this.manifest.policy.maxAttemptsPerAction
                            ? 'qualification-exhausted'
                            : 'queued';
    return structuredClone({
      scope: 'execution-bookkeeping-model-only' as const,
      rootId: this.manifest.id,
      rootSha256: this.rootSha256,
      version: this.version,
      completedActions: this.cursor,
      totalActions: this.manifest.actions.length,
      expiresAt: this.manifest.expiresAt,
      phase,
      paused: this.paused,
      stopped: this.stopped,
      nextActionId: action?.id ?? null,
      nextQualificationAt: this.nextQualificationAt,
      qualificationAttempts: action ? (this.attempts.get(action.id) ?? 0) : 0,
      totalQualifications: this.qualifications,
      pending: p,
      heldAcquisition:
        p?.outcome && action?.side === 'Buy' && BigInt(p.outcome.outputRaw) > 0n
          ? {
              wallet: action.wallet,
              mint: action.mint,
              tokenProgram: action.tokenProgram,
              decimals: action.decimals,
              receiptId: p.outcome.receiptId,
              sourceSha256: p.outcome.sourceSha256,
              observedRaw: p.outcome.outputRaw,
              availableRaw: '0',
              reconciliationRequired: true,
            }
          : null,
      wallets: this.manifest.wallets.map((w) => {
        const relevant = action?.wallet === w.wallet ? p : null;
        const heldBuy =
          relevant && action.side === 'Buy' ? BigInt(action.inputLamports) : 0n;
        const heldFee = relevant ? BigInt(action.maximumFeeRentLamports) : 0n;
        const actual = relevant?.outcome;
        const observedBuy =
          actual && action.side === 'Buy' ? BigInt(actual.inputRaw) : 0n;
        const observedFee = actual
          ? BigInt(actual.networkFeeLamports) + BigInt(actual.rentDebitLamports)
          : 0n;
        const buyExposure = heldBuy > observedBuy ? heldBuy : observedBuy;
        const feeExposure = heldFee > observedFee ? heldFee : observedFee;
        const spentBuy = this.buySpent.get(w.wallet)!,
          spentFee = this.feeRentSpent.get(w.wallet)!;
        return {
          wallet: w.wallet,
          revision: w.revision,
          spentBuyLamports: spentBuy.toString(),
          spentFeeRentLamports: spentFee.toString(),
          heldBuyLamports: buyExposure.toString(),
          heldFeeRentLamports: feeExposure.toString(),
          remainingBuyLamports: (
            BigInt(w.maximumBuyLamports) -
            spentBuy -
            buyExposure
          ).toString(),
          remainingFeeRentLamports: (
            BigInt(w.maximumFeeRentLamports) -
            spentFee -
            feeExposure
          ).toString(),
        };
      }),
      ...authorities,
    });
  }
  lot(receiptId: string, now = this.clock) {
    this.time(now);
    const l = this.lots.get(receiptId);
    if (!l) return null;
    const p = this.pending?.lotReceiptId === receiptId ? this.pending : null;
    const { remainingRaw, ...identity } = l;
    return structuredClone({
      ...identity,
      bookedRemainingRaw: remainingRaw,
      heldRaw: p?.inputRaw ?? '0',
      availableRaw: p ? '0' : remainingRaw,
      observedConsumedRaw: p?.outcome?.inputRaw ?? '0',
      reconciliationRequired:
        !!p && (p.state === 'held' || this.recoveryRequired(now)),
    });
  }
  outcome(receiptId: string) {
    return structuredClone(this.outcomes.get(receiptId) ?? null);
  }

  /** Atomic in-memory transition: validate first, then commit one mutation.
   * expectedVersion is a local CAS check, not a cross-process database lock. */
  apply(value: unknown) {
    const e = event.parse(value);
    this.time(e.now);
    if (
      e.expectedRootSha256 !== this.rootSha256 ||
      e.expectedVersion !== this.version ||
      this.version >= WARMUP_EXECUTION_MODEL_STEPS
    )
      fail();
    if (
      this.version >= WARMUP_EXECUTION_MODEL_STEPS - 4 &&
      ![
        'stop',
        'unknown',
        'recover-signed',
        'settle',
        'cancel-unsigned',
      ].includes(e.operation)
    )
      fail();
    let commit: () => void;
    if (
      e.operation === 'pause' ||
      e.operation === 'resume' ||
      e.operation === 'stop'
    ) {
      if (this.cursor === this.manifest.actions.length && !this.pending) fail();
      if (e.operation === 'stop') {
        if (this.stopped) fail();
        commit = () => {
          this.stopped = true;
        };
      } else {
        if (
          this.stopped ||
          e.now >= Date.parse(this.manifest.expiresAt) ||
          (e.operation === 'pause' ? this.paused : !this.paused)
        )
          fail();
        commit = () => {
          this.paused = e.operation === 'pause';
          if (
            this.paused &&
            this.pending &&
            ['authorized', 'dispatch-intent'].includes(this.pending.state)
          )
            this.pending.state = 'unknown';
        };
      }
    } else if (e.operation === 'reserve') {
      this.active(e.now);
      if (this.pending) fail();
      const a = this.action();
      if (
        e.now < Date.parse(a.scheduledAt) ||
        (this.attempts.get(a.id) ?? 0) >=
          this.manifest.policy.maxAttemptsPerAction
      )
        fail();
      let inputRaw: string,
        lotReceiptId: string | null = null;
      if (a.side === 'Buy') inputRaw = a.inputLamports;
      else {
        const source = a.source;
        const lot =
          source.kind === 'saved-buy'
            ? this.lots.get(source.receiptId)
            : this.lots.get(this.buyLots.get(source.actionId) ?? '');
        if (
          !lot ||
          lot.wallet !== a.wallet ||
          lot.mint !== a.mint ||
          lot.tokenProgram !== a.tokenProgram ||
          lot.decimals !== a.decimals ||
          BigInt(lot.remainingRaw) <= 0n
        )
          fail();
        inputRaw = lot.remainingRaw;
        lotReceiptId = lot.receiptId;
      }
      const wallet = this.manifest.wallets.find((w) => w.wallet === a.wallet)!;
      if (
        this.buySpent.get(a.wallet)! +
          (a.side === 'Buy' ? BigInt(inputRaw) : 0n) >
          BigInt(wallet.maximumBuyLamports) ||
        this.feeRentSpent.get(a.wallet)! + BigInt(a.maximumFeeRentLamports) >
          BigInt(wallet.maximumFeeRentLamports)
      )
        fail();
      const pending: Pending = {
        actionId: a.id,
        state: 'reviewing',
        inputRaw,
        lotReceiptId,
        qualification: null,
        prepared: null,
        authorization: null,
        signed: null,
        outcome: null,
      };
      commit = () => {
        this.pending = pending;
      };
    } else if (e.operation === 'cancel-unsigned') {
      const p = this.requirePending();
      if (
        !['reviewing', 'prepared'].includes(p.state) ||
        p.authorization ||
        p.signed
      )
        fail();
      commit = () => {
        this.pending = null;
      };
    } else if (e.operation === 'qualify') {
      this.active(e.now);
      const p = this.requirePending(),
        n = this.attempts.get(p.actionId) ?? 0;
      if (
        !['reviewing', 'prepared'].includes(p.state) ||
        n >= this.manifest.policy.maxAttemptsPerAction ||
        e.now < this.nextQualificationAt
      )
        fail();
      commit = () => {
        this.attempts.set(p.actionId, n + 1);
        this.qualifications++;
        this.nextQualificationAt = e.now + this.manifest.policy.minimumGapMs;
        p.state = 'reviewing';
        p.prepared = null;
        p.qualification = {
          evidenceSha256: e.evidenceSha256,
          expiresAt: Math.min(
            e.now + this.manifest.policy.qualificationTtlMs,
            Date.parse(this.manifest.expiresAt),
          ),
        };
      };
    } else if (e.operation === 'prepare') {
      const p = this.fresh(e.now);
      const prior = this.preparations.get(e.packetSha256);
      if (
        p.state !== 'reviewing' ||
        e.qualificationEvidenceSha256 !== p.qualification!.evidenceSha256 ||
        (prior &&
          (prior.actionId !== p.actionId ||
            prior.minimumOutputRaw !== e.minimumOutputRaw))
      )
        fail();
      commit = () => {
        this.preparations.set(e.packetSha256, {
          actionId: p.actionId,
          minimumOutputRaw: e.minimumOutputRaw,
        });
        p.state = 'prepared';
        p.prepared = {
          packetSha256: e.packetSha256,
          minimumOutputRaw: e.minimumOutputRaw,
          qualificationEvidenceSha256: e.qualificationEvidenceSha256,
        };
      };
    } else if (e.operation === 'authorize') {
      const p = this.fresh(e.now);
      if (
        p.state !== 'prepared' ||
        p.prepared?.packetSha256 !== e.packetSha256 ||
        this.authorizations.has(e.id)
      )
        fail();
      commit = () => {
        this.authorizations.add(e.id);
        p.state = 'authorized';
        p.authorization = {
          id: e.id,
          recheckSha256: e.recheckSha256,
          qualificationEvidenceSha256: p.prepared!.qualificationEvidenceSha256,
          expiresAt: Math.min(
            e.now + WARMUP_EXECUTION_AUTHORIZATION_MS,
            p.qualification!.expiresAt,
          ),
        };
      };
    } else if (
      e.operation === 'dispatch-intent' ||
      e.operation === 'recover-signed'
    ) {
      const p = this.requirePending();
      if (
        !p.authorization ||
        p.prepared?.packetSha256 !== e.packetSha256 ||
        p.signed ||
        this.signatures.has(e.signature) ||
        this.signedPackets.has(e.signedPacketSha256)
      )
        fail();
      if (e.operation === 'dispatch-intent') {
        this.fresh(e.now);
        if (
          p.state !== 'authorized' ||
          e.now >= p.authorization.expiresAt ||
          e.authorizationId !== p.authorization.id ||
          this.dispatches.has(e.id)
        )
          fail();
      } else if (p.state !== 'unknown') fail();
      commit = () => {
        this.signatures.add(e.signature);
        this.signedPackets.add(e.signedPacketSha256);
        if (e.operation === 'dispatch-intent') this.dispatches.add(e.id);
        p.signed = {
          signature: e.signature,
          signedPacketSha256: e.signedPacketSha256,
          dispatchId: e.operation === 'dispatch-intent' ? e.id : null,
        };
        p.state =
          e.operation === 'dispatch-intent' ? 'dispatch-intent' : 'unknown';
      };
    } else if (e.operation === 'unknown') {
      const p = this.requirePending();
      if (!['authorized', 'dispatch-intent'].includes(p.state)) fail();
      commit = () => {
        p.state = 'unknown';
      };
    } else {
      const p = this.requirePending(),
        a = this.action();
      if (
        !['dispatch-intent', 'unknown'].includes(p.state) ||
        p.signed?.signature !== e.signature ||
        p.signed?.signedPacketSha256 !== e.signedPacketSha256 ||
        p.prepared?.packetSha256 !== e.packetSha256 ||
        !p.authorization ||
        !p.prepared ||
        this.receipts.has(e.receiptId) ||
        this.lots.has(e.receiptId)
      )
        fail();
      const cost = BigInt(e.networkFeeLamports) + BigInt(e.rentDebitLamports);
      const reason = !p.signed.dispatchId
        ? 'missing-dispatch-intent'
        : e.landedFailure
          ? 'landed-failure'
          : e.inputRaw !== p.inputRaw
            ? 'input-mismatch'
            : BigInt(e.outputRaw) < BigInt(p.prepared.minimumOutputRaw)
              ? 'minimum-output'
              : cost > BigInt(a.maximumFeeRentLamports)
                ? 'fee-rent-overrun'
                : null;
      const oldLot = p.lotReceiptId ? this.lots.get(p.lotReceiptId) : null;
      if (a.side === 'Sell' && (!oldLot || oldLot.remainingRaw !== p.inputRaw))
        fail();
      commit = () => {
        this.receipts.add(e.receiptId);
        this.outcomes.set(e.receiptId, {
          ...e,
          actionId: a.id,
          wallet: a.wallet,
          mint: a.mint,
          side: a.side,
          lotReceiptId: p.lotReceiptId,
          authorizationId: p.authorization!.id,
          dispatchId: p.signed!.dispatchId,
          qualificationEvidenceSha256:
            p.authorization!.qualificationEvidenceSha256,
          disposition: reason ? 'held' : 'applied',
          reason,
        });
        if (reason) {
          p.state = 'held';
          p.outcome = { ...e, reason };
          return;
        }
        this.feeRentSpent.set(
          a.wallet,
          this.feeRentSpent.get(a.wallet)! + cost,
        );
        if (a.side === 'Buy') {
          this.buySpent.set(
            a.wallet,
            this.buySpent.get(a.wallet)! + BigInt(e.inputRaw),
          );
          this.lots.set(e.receiptId, {
            receiptId: e.receiptId,
            wallet: a.wallet,
            mint: a.mint,
            tokenProgram: a.tokenProgram,
            decimals: a.decimals,
            remainingRaw: e.outputRaw,
            sourceSha256: e.sourceSha256,
            buyActionId: a.id,
          });
          this.buyLots.set(a.id, e.receiptId);
        } else oldLot!.remainingRaw = '0';
        this.cursor++;
        this.pending = null;
      };
    }
    commit();
    this.clock = e.now;
    this.version++;
    return this.snapshot();
  }
}
