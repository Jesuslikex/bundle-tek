import { z } from 'zod';
import {
  getBase64Encoder,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { warmupAccountTokens } from './warmup-native-settlement';
import { decodeSwapFailure } from './swap-failure-server';
import { parseBalanceJson } from './wallet-balances';
import { readWarmupExecutionRootBinding } from './wallet-warmup-execution-terms';
import { parseWarmupExecutionLedgerEvent } from './wallet-warmup-execution-ledger';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  warmupExecutionHash as hash,
  warmupExecutionId as uuid,
  warmupExecutionTimestamp as iso,
  warmupExecutionUnits as units,
  WARMUP_EXECUTION_POLICY,
} from './wallet-warmup-execution-manifest';

export const WARMUP_FAILURE_RECEIPT_BYTES = 256 * 1024;
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const positive = units.refine((v) => BigInt(v) > 0n);
const contextSchema = z
  .object({
    rootId: uuid,
    rootSha256: hash,
    manifestSha256: hash,
    actionId: z.string().min(1).max(256),
    actionIndex: z.number().int().min(0).max(4799),
    expectedVersion: z
      .number()
      .int()
      .min(5)
      .max(WARMUP_EXECUTION_POLICY.modelSteps - 1),
    now: z
      .number()
      .int()
      .min(0)
      .max(8640000000000000 - 60000),
    packetSha256: hash,
    signedPacketSha256: hash,
    authorizationId: uuid,
    dispatchId: uuid.nullable(),
    lotReceiptId: uuid.nullable(),
    signature: z.string().min(64).max(88),
    receiptId: uuid,
    inputRaw: positive,
    minimumOutputRaw: positive,
  })
  .strict();
const timestamp = z.number().int().min(0).max(8640000000000000);
const signedUnits = z.string().regex(/^(0|-?[1-9]\d{0,39})$/);
// A bounded selected projection from the ORIGINAL ledger, never restore/CAS
// state. Requiring all fields prevents an arbitrary fragment being promoted
// to a ledger snapshot; storage provenance still belongs to the future caller.
const selectedSnapshotSchema = z
  .object({
    scope: z.literal('execution-bookkeeping-model-only'),
    rootId: uuid,
    rootSha256: hash,
    version: z.number().int().min(0).max(WARMUP_EXECUTION_POLICY.modelSteps),
    completedActions: z.number().int().min(0).max(4800),
    totalActions: z.number().int().min(1).max(4800),
    expiresAt: iso,
    phase: z.enum([
      'held',
      'recovery-required',
      'stopped',
      'complete',
      'expired',
      'paused',
      'model-capacity-exhausted',
      'awaiting-outcome',
      'review-expired',
      'pending',
      'qualification-exhausted',
      'queued',
    ]),
    paused: z.boolean(),
    stopped: z.boolean(),
    nextActionId: z.string().min(1).max(256).nullable(),
    nextQualificationAt: timestamp,
    qualificationAttempts: z.number().int().min(0).max(3),
    totalQualifications: z
      .number()
      .int()
      .min(0)
      .max(WARMUP_EXECUTION_POLICY.modelSteps),
    pending: z
      .object({
        actionId: z.string().min(1).max(256),
        state: z.enum(['dispatch-intent', 'unknown']),
        inputRaw: positive,
        lotReceiptId: uuid.nullable(),
        qualification: z
          .object({ evidenceSha256: hash, expiresAt: timestamp })
          .strict(),
        prepared: z
          .object({
            packetSha256: hash,
            minimumOutputRaw: positive,
            qualificationEvidenceSha256: hash,
          })
          .strict(),
        authorization: z
          .object({
            id: uuid,
            expiresAt: timestamp,
            recheckSha256: hash,
            qualificationEvidenceSha256: hash,
          })
          .strict(),
        signed: z
          .object({
            signature: z.string().min(64).max(88),
            signedPacketSha256: hash,
            dispatchId: uuid.nullable(),
          })
          .strict(),
        outcome: z.null(),
      })
      .strict(),
    heldAcquisition: z.null(),
    wallets: z
      .array(
        z
          .object({
            wallet: address,
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            spentBuyLamports: signedUnits,
            spentFeeRentLamports: signedUnits,
            heldBuyLamports: signedUnits,
            heldFeeRentLamports: signedUnits,
            remainingBuyLamports: signedUnits,
            remainingFeeRentLamports: signedUnits,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    executionAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
  })
  .strict();
// Only the existing failure decoder's reviewed packet/account scope is admitted.
// Optional unrelated signing extensions are deliberately not copied or promoted.
const reviewSchema = z.object({
  id: uuid,
  preparationId: uuid,
  wallet: address,
  sha256: hash,
  expiresAt: iso,
  network: z.literal('mainnet'),
  maximumFeeLamports: units,
  inputRaw: positive,
  minimumOutputRaw: positive,
  inputMint: address,
  outputMint: address,
  transaction: z.string().min(1).max(1644),
  lastValidBlockHeight: units,
  settlement: z.object({
    accountKeysSha256: hash,
    version: z.union([z.literal(1), z.literal(2)]),
    wrappedFromNativeRaw: units,
    maximumRentLamports: units,
    maximumNativeDebitLamports: units,
    preexistingWrappedRefundRaw: units,
    closesWrappedAccount: z.boolean(),
    accounts: z
      .array(
        z.object({
          address,
          mint: address,
          index: z.number().int().min(0).max(255),
          created: z.boolean(),
          closed: z.boolean(),
          rentBeforeRaw: units,
        }),
      )
      .max(256),
    lookupTables: z
      .array(z.object({ address, sha256: hash, lastExtendedSlot: units }))
      .max(256),
  }),
});
export class WarmupExecutionFailureError extends Error {
  constructor() {
    super(
      'Exact original warmup failure evidence is unavailable or changed. Keep recovery and reservations; no execution is authorized.',
    );
  }
}
function fail(): never {
  throw new WarmupExecutionFailureError();
}
const flags = {
  receiptProvenanceVerified: false as const,
  currentSourceVerified: false as const,
  networkProvenanceVerified: false as const,
  finalityProvenanceVerified: false as const,
  currentHeadVerified: false as const,
  financialReservationVerified: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
};
type Selector = Parameters<typeof readWarmupExecutionRootBinding>[2];

/** Pure historical evidence binding, not an owned outcome writer or network proof.
 * Selector/context/review/snapshot must later be loaded independently from owned
 * storage. A self-consistent caller-supplied context is never authority. No SQL,
 * provider request, signer, reservation release or execution callback is invoked.
 * The original failure decoder supplies cryptographic packet and observed
 * fee-only native rollback checks. Its fresh display timestamp/provider label
 * invoke its clock/config accessors and are NOT retained as original observation
 * evidence here. No freshness is renewed. Snapshot omits the reducer's last
 * clock/uniqueness sets; the eventual original ledger/CAS writer must recheck them.
 */
export async function bindWarmupExecutionFailure(
  rawRoot: unknown,
  rawApproval: unknown,
  selector: Selector,
  rawContext: unknown,
  rawReview: unknown,
  rawSelectedSnapshot: unknown,
  receiptWire: string,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    const context = contextSchema.parse(rawContext),
      review = reviewSchema.parse(rawReview),
      selectedSnapshot = selectedSnapshotSchema.parse(rawSelectedSnapshot);
    if (new TextEncoder().encode(canonical(selectedSnapshot)).length > 65536)
      fail();
    if (
      typeof receiptWire !== 'string' ||
      receiptWire.length > WARMUP_FAILURE_RECEIPT_BYTES ||
      new TextEncoder().encode(receiptWire).length >
        WARMUP_FAILURE_RECEIPT_BYTES
    )
      fail();
    const raw = parseBalanceJson(receiptWire) as {
      transaction?: unknown;
      meta?: {
        loadedAddresses?: { writable?: unknown; readonly?: unknown };
        preTokenBalances?: unknown;
        postTokenBalances?: unknown;
      };
    };
    if (canonical(raw) !== receiptWire) fail();
    const bound = await readWarmupExecutionRootBinding(
      rawRoot,
      rawApproval,
      selector,
    );
    signal.throwIfAborted();
    const action = bound.manifest.actions[context.actionIndex];
    const pending = selectedSnapshot.pending;
    if (
      selectedSnapshot.rootId !== bound.manifest.id ||
      selectedSnapshot.rootSha256 !== bound.manifestSha256 ||
      selectedSnapshot.version !== context.expectedVersion ||
      selectedSnapshot.completedActions !== context.actionIndex ||
      selectedSnapshot.totalActions !== bound.manifest.actions.length ||
      selectedSnapshot.expiresAt !== bound.manifest.expiresAt ||
      selectedSnapshot.nextActionId !== context.actionId ||
      pending.actionId !== context.actionId ||
      pending.inputRaw !== context.inputRaw ||
      pending.lotReceiptId !== context.lotReceiptId ||
      pending.prepared.packetSha256 !== context.packetSha256 ||
      pending.prepared.minimumOutputRaw !== context.minimumOutputRaw ||
      pending.authorization.id !== context.authorizationId ||
      pending.signed.signedPacketSha256 !== context.signedPacketSha256 ||
      pending.signed.signature !== context.signature ||
      pending.signed.dispatchId !== context.dispatchId ||
      (pending.state === 'dispatch-intent' &&
        pending.signed.dispatchId === null) ||
      pending.prepared.qualificationEvidenceSha256 !==
        pending.qualification.evidenceSha256 ||
      pending.authorization.qualificationEvidenceSha256 !==
        pending.qualification.evidenceSha256
    )
      fail();
    if (
      !action ||
      context.rootId !== bound.manifest.id ||
      context.rootSha256 !== bound.rootSha256 ||
      context.manifestSha256 !== bound.manifestSha256 ||
      context.actionId !== action.id ||
      review.id !== context.authorizationId ||
      review.sha256 !== context.packetSha256 ||
      review.wallet !== action.wallet ||
      review.inputRaw !== context.inputRaw ||
      review.minimumOutputRaw !== context.minimumOutputRaw ||
      context.now < Date.parse(bound.approval.approvedAt) ||
      (action.side === 'Buy' &&
        (review.inputMint !== 'So11111111111111111111111111111111111111112' ||
          review.outputMint !== action.mint ||
          review.inputRaw !== action.inputLamports)) ||
      (action.side === 'Sell' &&
        (review.inputMint !== action.mint ||
          review.outputMint !== 'So11111111111111111111111111111111111111112'))
    )
      fail();
    if (
      action.side === 'Buy'
        ? context.lotReceiptId !== null
        : context.lotReceiptId === null ||
          (action.source.kind === 'saved-buy' &&
            (context.lotReceiptId !== action.source.receiptId ||
              bound.manifest.savedLots.find(
                (l) => l.receiptId === context.lotReceiptId,
              )?.remainingRaw !== context.inputRaw))
    )
      fail();
    if (
      !Array.isArray(raw?.transaction) ||
      raw.transaction.length !== 2 ||
      raw.transaction[1] !== 'base64' ||
      typeof raw.transaction[0] !== 'string'
    )
      fail();
    const encoded = raw.transaction[0];
    if (
      encoded.length > 1644 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      fail();
    const bytes = getBase64Encoder().encode(encoded),
      tx = getTransactionDecoder().decode(bytes),
      roundtrip = getTransactionEncoder().encode(tx);
    if (
      bytes.length > 1232 ||
      getBase64Decoder().decode(bytes) !== encoded ||
      roundtrip.length !== bytes.length ||
      roundtrip.some((v, i) => v !== bytes[i])
    )
      fail();
    const signedPacketSha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    if (signedPacketSha256 !== context.signedPacketSha256) fail();
    const failure = await decodeSwapFailure(raw, review, context.signature);
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    const loaded = raw.meta?.loadedAddresses;
    const keys = [
      ...message.staticAccounts,
      ...z
        .array(address)
        .max(256)
        .parse(loaded?.writable ?? []),
      ...z
        .array(address)
        .max(256)
        .parse(loaded?.readonly ?? []),
    ];
    const programs = new Map([[action.mint, action.tokenProgram]]);
    const before = warmupAccountTokens(
      keys,
      action.wallet,
      raw.meta?.preTokenBalances,
      programs,
    );
    const after = warmupAccountTokens(
      keys,
      action.wallet,
      raw.meta?.postTokenBalances,
      programs,
    );
    if (before.size !== after.size) fail();
    for (const [index, token] of before) {
      const next = after.get(index);
      if (
        !next ||
        token.mint !== next.mint ||
        token.program !== next.program ||
        token.decimals !== next.decimals ||
        token.amount !== next.amount ||
        (token.mint === action.mint && token.decimals !== action.decimals)
      )
        fail();
    }
    signal.throwIfAborted();
    const rawReceiptSha256 = await digest(canonical(raw));
    const selectedSnapshotSha256 = await digest(canonical(selectedSnapshot));
    const evidence = {
      format: 'wallet-warmup-execution-failure-v1' as const,
      context,
      rawReceiptSha256,
      selectedSnapshotSha256,
      observation: {
        slot: failure.slot,
        blockTime: failure.blockTime,
        error: failure.error,
        networkFeeLamports: failure.networkFeeLamports,
        reviewedFeeLimitExceeded: failure.feeLimitExceeded,
        actualInputRaw: '0',
        actualOutputRaw: '0',
        actualAmountsBasis: 'failed-transaction-rollback-inference' as const,
        tokenMetadataScope:
          'reported-wallet-token-balances-must-agree' as const,
        observedWalletTokenReserveIncreases: '0',
        observedWalletTokenReserveDecreases: '0',
        rentScope: 'observed-fee-only-rollback-not-gross-cpi-spending' as const,
      },
    };
    const sourceSha256 = await digest(canonical(evidence));
    const event = parseWarmupExecutionLedgerEvent({
      operation: 'settle',
      expectedRootSha256: context.manifestSha256,
      expectedVersion: context.expectedVersion,
      now: context.now,
      packetSha256: context.packetSha256,
      signedPacketSha256,
      receiptId: context.receiptId,
      sourceSha256,
      signature: context.signature,
      inputRaw: '0',
      outputRaw: '0',
      networkFeeLamports: failure.networkFeeLamports,
      rentDebitLamports: '0',
      rentRefundLamports: '0',
      landedFailure: true,
    });
    if (event.operation !== 'settle') fail();
    signal.throwIfAborted();
    return {
      evidence,
      sourceSha256,
      event,
      scope: 'failure-bookkeeping-candidate-only' as const,
      ...flags,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
