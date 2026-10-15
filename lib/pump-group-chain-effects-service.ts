import { readPumpLaunchGroupReview } from './pump-launch-group-review-service';
import { canonicalPumpHolderJson } from './pump-holder-review';
import { PumpPreflightError } from './owned-pump-preflight';
import { collectPumpGroupChainEffects } from './pump-group-chain-effects';
import type { PumpLaunchRpc } from './pump-launch-simulation';

/** Owner-scoped manual read. Never changes saved history, reservations, approvals or transaction state. */
export async function readOwnedPumpGroupChainEffects(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  const before = await readPumpLaunchGroupReview(db, owner, id);
  if (!before.signedEvidence)
    throw new PumpPreflightError(
      'Retain the exact complete signed group before reading its finalized wallet results.',
      409,
    );
  const result = await collectPumpGroupChainEffects(
    before.review,
    before.signedEvidence,
    signal,
    rpc,
  );
  signal.throwIfAborted();
  const after = await readPumpLaunchGroupReview(db, owner, id);
  signal.throwIfAborted();
  if (canonicalPumpHolderJson(before) !== canonicalPumpHolderJson(after))
    throw new PumpPreflightError(
      'Saved group changed while reading finalized wallet results. Reload its history.',
      409,
    );
  return result;
}
