import { createWalletWarmupV2Provider } from './wallet-warmup-session-v2-provider';
import {
  requireActiveWarmupRuntimePurpose,
  type WarmupRuntimeMaterial,
} from './wallet-warmup-session-v2-runtime-storage';
import {
  collectWalletWarmupRuntimeOrder,
  walletWarmupRuntimeOrderRequestDigest,
  type WarmupRuntimeOrderDependencies,
  type WarmupRuntimeOrderRequest,
} from './wallet-warmup-runtime-order';
import { inspectWarmupSellInventory } from './warmup-sell-inventory';
import { WARMUP_SESSION_PREPARATION_TIMEOUT_MS } from './wallet-warmup-session-provider';
import type { WarmupV2AttemptRow } from './wallet-warmup-session-v2-attempt-types';
import type { WarmupSessionPreparationCandidate } from './wallet-warmup-session-preparation';
import { readWarmupRuntimeReceiptFloor } from './wallet-warmup-runtime-receipt-floor';
export type WarmupRuntimeProviderDependencies = {
  runtime?: Omit<WarmupRuntimeOrderDependencies, 'signal' | 'apiKey'>;
  inventory?: typeof inspectWarmupSellInventory;
};
/** Trusted runtime-only adapter. Its mode is fixed in SQL before any provider read. */
export function createWalletWarmupV2RuntimeProvider(
  db: D1Database,
  owner: string,
  key: string | undefined,
  leaseValue: WarmupV2AttemptRow,
  deps: WarmupRuntimeProviderDependencies = {},
) {
  const lease = structuredClone(leaseValue);
  return async (
    value: WarmupSessionPreparationCandidate,
    parentSignal: AbortSignal,
  ) => {
    const candidate = structuredClone(value),
      controller = new AbortController(),
      signal = AbortSignal.any([
        parentSignal,
        controller.signal,
        AbortSignal.timeout(
          Math.max(
            1,
            Math.min(
              WARMUP_SESSION_PREPARATION_TIMEOUT_MS,
              Date.parse(lease.expires_at) - Date.now(),
            ),
          ),
        ),
      ]);
    let inventory: Awaited<
        ReturnType<typeof inspectWarmupSellInventory>
      > | null = null,
      material: WarmupRuntimeMaterial | null = null;
    try {
      await requireActiveWarmupRuntimePurpose(db, lease, signal);
      const run = createWalletWarmupV2Provider(db, owner, key, lease, {
        inventory: async (wallet, mint, readSignal, amount) => {
          const minimumSlot = await readWarmupRuntimeReceiptFloor(
            db,
            lease,
            candidate,
            readSignal,
          );
          inventory = await (deps.inventory ?? inspectWarmupSellInventory)(
            wallet,
            mint,
            readSignal,
            amount,
            undefined,
            minimumSlot,
          );
          if (
            inventory.minSlot < minimumSlot ||
            inventory.mintSlot === null ||
            inventory.mintSlot < minimumSlot
          )
            throw Error('Inventory predates a recorded finalized receipt.');
          return inventory;
        },
        quote: async (input, apiKey, readSignal) => {
          if (
            input.wallet !== candidate.action.wallet ||
            input.tokenMint !== candidate.action.mint ||
            input.side !== candidate.action.side
          )
            throw Error('Runtime action changed.');
          const request: WarmupRuntimeOrderRequest = {
            requestSha256: '0'.repeat(64),
            wallet: input.wallet,
            mint: input.tokenMint,
            side: input.side,
            inputRaw:
              candidate.action.side === 'Buy'
                ? candidate.action.inputLamports
                : candidate.sellSource!.remainingRaw,
            feeAndRentLimitRaw: candidate.budget.remainingReserveLamports,
            deadline: candidate.deadline,
            inventory,
          };
          request.requestSha256 =
            await walletWarmupRuntimeOrderRequestDigest(request);
          const result = await collectWalletWarmupRuntimeOrder(request, {
            ...deps.runtime,
            signal: readSignal,
            apiKey,
          });
          material = { request, result };
          return result.order;
        },
        simulate: async (order, readSignal) => {
          readSignal.throwIfAborted();
          const retained = material as WarmupRuntimeMaterial | null;
          if (
            !retained ||
            order.preparation.sha256 !==
              retained.result.order.preparation.sha256
          )
            throw Error('Original runtime packet is unavailable.');
          return retained.result.simulation;
        },
      });
      const result = await run(candidate, signal);
      await requireActiveWarmupRuntimePurpose(db, lease, signal);
      if (!material) throw Error('Runtime observations are unavailable.');
      return { ...result, runtimeEvidence: material as WarmupRuntimeMaterial };
    } finally {
      controller.abort();
    }
  };
}
