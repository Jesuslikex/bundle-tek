import { autoSellRunId } from './auto-sell-run';
import {
  AutoSellRunStorageError,
  readOwnedAutoSellAttempts,
} from './auto-sell-run-storage';
import {
  AUTO_SELL_RUN_PROGRESS_MAX_BYTES,
  readAutoSellRunProgress,
  type AutoSellRunProgressEvidence,
} from './auto-sell-run-progress';

export class AutoSellRunProgressStorageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export const autoSellRunProgressCapacityMessage =
  'This complete saved-progress history exceeds the recovery display capacity. No partial progress or restored allowance was returned. Keep the original run and attempt IDs.';
function fail(message: string, status: number): never {
  throw new AutoSellRunProgressStorageError(message, status);
}
function active(signal: AbortSignal) {
  if (signal.aborted)
    fail(
      'Waiting stopped. Inspect the same original saved run again; no allowance was released.',
      408,
    );
}
export async function readOwnedAutoSellRunProgress(
  db: D1Database,
  owner: string,
  projectId: string,
  runId: string,
  signal: AbortSignal,
): Promise<AutoSellRunProgressEvidence> {
  active(signal);
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128)
    fail('Choose the original signed-in account.', 400);
  try {
    autoSellRunId(projectId);
    autoSellRunId(runId);
  } catch {
    fail('Choose one complete original project and run ID.', 400);
  }
  try {
    const history = await readOwnedAutoSellAttempts(db, owner, runId, signal);
    if (history.run.profile.terms.projectId !== projectId)
      fail('Original saved run is unavailable for this project.', 404);
    active(signal);
    const evidenceAt = (observedAt: string) => ({
      format: 'auto-sell-run-progress-evidence-v1',
      run: history.run,
      head: {
        sequence: history.accounting.sequence,
        headSha256: history.accounting.headSha256,
      },
      attempts: history.attempts,
      preparationStarts: history.preparationStarts,
      stop: history.stop,
      observedAt,
      signingAllowed: false,
      executionAllowed: false,
      automaticResumeAllowed: false,
      allowanceReleased: false,
    });
    // Capacity is checked before the second full replay. The fixed-width value
    // is used only to count bytes; it is never returned as observation evidence.
    if (
      new TextEncoder().encode(
        JSON.stringify(evidenceAt('2000-01-01T00:00:00.000Z')),
      ).byteLength > AUTO_SELL_RUN_PROGRESS_MAX_BYTES
    )
      fail(autoSellRunProgressCapacityMessage, 409);
    const before = JSON.stringify(history);
    const clock = await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
      .first<{ now: string }>();
    active(signal);
    if (!clock || typeof clock.now !== 'string')
      throw Error('Observation clock unavailable');
    const after = await readOwnedAutoSellAttempts(db, owner, runId, signal);
    active(signal);
    if (JSON.stringify(after) !== before)
      fail(
        'Saved progress changed during inspection. Inspect the same original run again; no allowance was released.',
        503,
      );
    const evidence = evidenceAt(clock.now);
    const parsed = await readAutoSellRunProgress(evidence);
    active(signal);
    return parsed.evidence;
  } catch (error) {
    active(signal);
    if (error instanceof AutoSellRunProgressStorageError) throw error;
    if (error instanceof AutoSellRunStorageError && error.status === 404)
      fail('Original saved run is unavailable for this account.', 404);
    fail(
      'Complete saved-progress evidence is unavailable or differs. Keep the original run and attempt IDs.',
      503,
    );
  }
}
