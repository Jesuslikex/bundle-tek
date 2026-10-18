import { currentStrategyReviewContext } from './strategy-review-capacity-server';
import { strategyReviewCandidate } from './strategy-review-capacity';
import {
  buildStrategyCandidateCheck,
  type StrategyCheckMarket,
} from './strategy-candidate-check';
import { observeExactStrategyMarket } from './strategy-market-exact';
import { StrategyDraftError } from './strategy-session-drafts';
export type StrategyCheckRequest = {
  projectId: string;
  draftId: string;
  revision: number;
  holdId: string;
};
/** Fresh manual snapshot only. No prepared packet, signer, reservation mutation or executor. */
export async function checkStrategyCandidate(
  db: D1Database,
  owner: string,
  input: StrategyCheckRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const started = Date.now();
  signal.throwIfAborted();
  const context = () =>
    currentStrategyReviewContext(
      db,
      owner,
      input.projectId,
      input.draftId,
      input.revision,
      input.holdId,
    );
  const first = await context(),
    terms = first.draft.plan.input.strategies.find(
      (s) => s.id === first.hold.strategyId,
    )!,
    candidate = strategyReviewCandidate(
      first.draft.plan,
      first.hold.strategyId,
      first.hold.candidate,
    );
  const initial = Date.parse(first.databaseAt),
    due =
      initial >= Date.parse(candidate.notBefore) &&
      (candidate.endsAt === null || initial < Date.parse(candidate.endsAt));
  let market: StrategyCheckMarket | null = null;
  if (due && terms.kind === 'Limit') {
    const gated = await db
      .prepare(
        'INSERT INTO market_read_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE market_read_gates.next_allowed_at<=?',
      )
      .bind(owner, initial + 15000, initial)
      .run();
    if (!gated.meta.changes)
      throw new StrategyDraftError(
        'Wait 15 seconds between market provider reads, then check again.',
        429,
      );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      cancel = () => {};
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort();
        reject(
          new StrategyDraftError(
            'Condition check cancelled or timed out. No review slots changed.',
            502,
          ),
        );
      };
      timer = setTimeout(cancel, 8000);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      const observed = await Promise.race([
        stopped,
        observeExactStrategyMarket(
          first.draft.plan.token.address,
          controller.signal,
          fetcher,
        ),
      ]);
      if (Date.parse(observed.market.observedAt) < initial - 1000)
        throw Error('Market receipt time regressed.');
      market = {
        source: 'api.dexscreener.com',
        chain: 'Solana',
        address: observed.market.address,
        observedAt: observed.market.observedAt,
        returnedPairCount: observed.market.returnedPairCount,
        quoteOnlyPairCount: observed.market.quoteOnlyPairCount,
        pairs: observed.market.pairs.map((p) => ({
          address: p.address,
          dex: p.dex,
          quoteSymbol: p.quoteSymbol,
          marketCapUsd: observed.caps[p.address],
        })),
      };
    } catch (e) {
      if (e instanceof StrategyDraftError) throw e;
      throw new StrategyDraftError(
        'Market provider unavailable or inconsistent. No review slots changed.',
        502,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
  signal.throwIfAborted();
  const final = await context(),
    checked = Date.parse(final.databaseAt);
  signal.throwIfAborted();
  if (
    final.fingerprint !== first.fingerprint ||
    Date.now() < started ||
    checked < initial
  )
    throw new StrategyDraftError(
      'Strategy context or clock changed during the check. Reload review slots.',
      409,
    );
  if (
    !due &&
    checked >= Date.parse(candidate.notBefore) &&
    (candidate.endsAt === null || checked < Date.parse(candidate.endsAt))
  )
    throw new StrategyDraftError(
      'The scheduled start was reached during the check. Check again.',
      409,
    );
  if (candidate.endsAt !== null && checked >= Date.parse(candidate.endsAt))
    market = null;
  return buildStrategyCandidateCheck(
    final.draft,
    final.capacity,
    input.holdId,
    new Date(checked).toISOString(),
    market,
  );
}
