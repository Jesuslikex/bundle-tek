import { rawToDecimal } from './auto-sell';
import {
  AutoSellRunStorageError,
  readOwnedAutoSellAttempts,
  startOwnedAutoSellPreparation,
} from './auto-sell-run-storage';
import { prepareOwnedImportedSwap } from './prepare-owned-imported-swap';

/** Server-only unsigned preparation entry point. It never accepts a packet,
 * preparation ID or claimed result from the caller. An interrupted one-shot
 * start stays charged and can only be inspected by its original IDs. */
export async function prepareOwnedAutoSellRunAttempt(
  request: Request,
  owner: string,
  db: D1Database,
  runId: string,
  attemptId: string,
): Promise<Response> {
  const json = (error: string, status: number) =>
    Response.json(
      { error },
      {
        status,
        headers: { 'cache-control': 'no-store' },
      },
    );
  if (request.method !== 'POST')
    return json('An explicit unsigned preparation request is required.', 405);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json('Cross-origin request rejected.', 403);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]);
  try {
    signal.throwIfAborted();
    const history = await readOwnedAutoSellAttempts(db, owner, runId, signal);
    const attempt = history.attempts.find((value) => value.id === attemptId);
    if (
      !attempt ||
      history.stopped ||
      history.preparationStarts.some((value) => value.attemptId === attemptId)
    )
      throw new AutoSellRunStorageError(
        'The original Auto Sell attempt is stopped, unavailable or already started. Inspect its saved history.',
        409,
      );
    signal.throwIfAborted();
    const terms = history.run.profile.terms;
    // Derive input from immutable owned records. The original service checks
    // configuration, capacity and both rate gates before the lazy start below.
    // The incoming body is deliberately unused.
    const internal = new Request(request.url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(request.headers.get('origin')
          ? { origin: request.headers.get('origin')! }
          : {}),
      },
      body: JSON.stringify({
        id: terms.projectId,
        revision: terms.projectRevision,
        wallet: attempt.wallet,
        walletRevision: attempt.walletRevision,
        side: 'Sell',
        amount: rawToDecimal(BigInt(attempt.inputRaw), terms.token.decimals),
        slippageBps: terms.configuration.session.maxSlippageBps ?? 50,
      }),
    });
    return await prepareOwnedImportedSwap(internal, owner, db, () =>
      startOwnedAutoSellPreparation(db, owner, runId, attemptId, signal),
    );
  } catch (error) {
    if (error instanceof AutoSellRunStorageError)
      return json(error.message, error.status);
    return json(
      'The original unsigned Auto Sell preparation could not be confirmed. Keep its run and attempt IDs and inspect saved history. No signing or submission is enabled.',
      signal.aborted ? 408 : 503,
    );
  }
}
