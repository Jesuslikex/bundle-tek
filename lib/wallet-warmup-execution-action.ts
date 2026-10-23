import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { deriveWarmupExecutionActionReservation } from './wallet-warmup-execution-audit';

type Arguments = Parameters<typeof deriveWarmupExecutionActionReservation>;

export class WarmupExecutionActionError extends Error {
  constructor() {
    super(
      'The exact original warmup action is not due or requires recovery. No runtime request or execution is authorized.',
    );
  }
}
function fail(): never {
  throw new WarmupExecutionActionError();
}

/** Select ONE original action through complete shared-ledger replay and a local
 * reserve derivation. The derived reserve is not recorded or a financial hold.
 *
 * The head/selector and server time must independently come from owned storage
 * in a future caller. Replayed receipt/evidence hashes remain opaque bookkeeping
 * inputs: they do not prove finalized tokens, current custody or live balances.
 * A durable same-head/root/lease admission must precede any runtime read, and a
 * Sell additionally needs its exact receipt floor and fresh supported inventory.
 * No database, provider, key, signer, timer or send callback is invoked here. */
export async function deriveWarmupExecutionAction(
  rawRoot: Arguments[0],
  rawApproval: Arguments[1],
  selector: Arguments[2],
  rawHead: Arguments[3],
  stream: Arguments[4],
  value: Arguments[5],
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    const reservation = await deriveWarmupExecutionActionReservation(
      rawRoot,
      rawApproval,
      selector,
      rawHead,
      stream,
      value,
      signal,
    );
    signal.throwIfAborted();
    const { action, wallet, inputRaw, lotReceiptId, lot } = reservation,
      snapshot = reservation.projection.snapshot,
      pending = snapshot.pending;
    if (
      !pending ||
      reservation.actionIndex !== snapshot.completedActions ||
      snapshot.nextActionId !== action.id ||
      pending.actionId !== action.id ||
      pending.state !== 'reviewing' ||
      snapshot.phase !== 'pending' ||
      reservation.head.version + 3 >= reservation.policy.modelSteps - 4 ||
      BigInt(action.maximumFeeRentLamports) <= 0n ||
      Math.max(
        snapshot.nextQualificationAt,
        reservation.projection.modelTime,
      ) >= Date.parse(reservation.expiresAt) ||
      pending.inputRaw !== inputRaw ||
      pending.lotReceiptId !== lotReceiptId ||
      pending.qualification !== null ||
      pending.prepared !== null ||
      pending.authorization !== null ||
      pending.signed !== null ||
      pending.outcome !== null ||
      wallet.wallet !== action.wallet ||
      BigInt(inputRaw) <= 0n
    )
      fail();
    const budget = snapshot.wallets.find((w) => w.wallet === action.wallet);
    if (!budget || budget.revision !== wallet.revision) fail();
    if (action.side === 'Buy') {
      if (
        inputRaw !== action.inputLamports ||
        lotReceiptId !== null ||
        lot !== null
      )
        fail();
    } else {
      if (
        !lot ||
        !lotReceiptId ||
        lot.receiptId !== lotReceiptId ||
        lot.wallet !== action.wallet ||
        lot.mint !== action.mint ||
        lot.tokenProgram !== action.tokenProgram ||
        lot.decimals !== action.decimals ||
        lot.bookedRemainingRaw !== inputRaw ||
        lot.heldRaw !== inputRaw ||
        lot.availableRaw !== '0' ||
        lot.reconciliationRequired ||
        (action.source.kind === 'saved-buy'
          ? lotReceiptId !== action.source.receiptId
          : lot.buyActionId !== action.source.actionId)
      )
        fail();
    }
    // These are selected terms, deliberately not a collector request: no
    // requestSha256, inventory object or renewed qualification deadline exists.
    const readSelection = {
      wallet: action.wallet,
      mint: action.mint,
      side: action.side,
      inputRaw,
      feeAndRentLimitRaw: action.maximumFeeRentLamports,
      sessionExpiresAt: reservation.expiresAt,
    };
    const inventoryRequirement = lot
      ? {
          kind: 'fresh-booked-lot-inventory-required' as const,
          receiptId: lot.receiptId,
          wallet: lot.wallet,
          mint: lot.mint,
          tokenProgram: lot.tokenProgram,
          decimals: lot.decimals,
          sourceSha256: lot.sourceSha256,
          buyActionId: lot.buyActionId ?? null,
          bookedRemainingRaw: lot.bookedRemainingRaw,
          requestedRaw: inputRaw,
          minimumReceiptSlotRequired: true as const,
          evidenceVerified: false as const,
        }
      : null;
    const nextQualificationAt = snapshot.nextQualificationAt;
    const selection = {
      format: 'wallet-warmup-execution-action-selection-v1' as const,
      previousHead: reservation.previousHead,
      proposedHead: reservation.head,
      actionIndex: reservation.actionIndex,
      action,
      wallet,
      inputRaw,
      lotReceiptId,
      lot,
      expiresAt: reservation.expiresAt,
      policy: reservation.policy,
      nextQualificationAt,
      readSelection,
      inventoryRequirement,
    };
    const sha256 = await digest(canonical(selection));
    signal.throwIfAborted();
    return {
      ...reservation,
      format: 'wallet-warmup-execution-action-v1' as const,
      nextQualificationAt,
      readSelection,
      inventoryRequirement,
      sha256,
      scope: 'next-action-selection-only' as const,
      reservationRecorded: false as const,
      currentLeaseVerified: false as const,
      providerReadAllowed: false as const,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
