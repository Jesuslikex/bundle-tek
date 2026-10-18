import type { SavedStrategyDraft } from './strategy-session-drafts';
import type { StrategyCapacityView } from './strategy-capacity-client';
import { requireStrategyCandidateCheck } from './strategy-candidate-check';
import {
  buildStrategyUnsignedPreview,
  type StrategyUnsignedPreview,
} from './strategy-unsigned-preview';
import { capacityKeys } from './strategy-review-capacity';

export async function readStrategyUnsignedPreview(
  raw: unknown,
  draft: SavedStrategyDraft,
  capacity: StrategyCapacityView,
  holdId: string,
  pool: string | null,
) {
  capacityKeys(
    raw,
    'balance,checks,conditionPool,executionAllowed,expiresAt,format,fundingAllowed,planningOnly,previewedAt,quote,sha256,signingAllowed,simulation,startedAt',
  );
  const v = raw as StrategyUnsignedPreview;
  const checks = requireStrategyCandidateCheck(
    v.checks,
    draft,
    capacity,
    holdId,
  );
  if (v.conditionPool !== pool)
    throw Error('Preview token or condition pool differs.');
  const rebuilt = await buildStrategyUnsignedPreview(
    checks,
    pool,
    { quote: v.quote, balance: v.balance, simulation: v.simulation },
    v.previewedAt,
    v.startedAt,
  );
  if (
    (checks.side === 'Buy'
      ? rebuilt.quote.outputMint
      : rebuilt.quote.inputMint) !== draft.plan.token.address
  )
    throw Error('Preview token differs. Request a fresh preview.');
  if (JSON.stringify(rebuilt) !== JSON.stringify(v))
    throw Error('Unsigned preview response differs.');
  return rebuilt;
}
export async function requestStrategyUnsignedPreview(
  body: object,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const stopped = new Promise<never>((_, reject) => {
    const refuse = () =>
      reject(Error('Preview cancelled or timed out. No review slots changed.'));
    controller.signal.addEventListener('abort', refuse, { once: true });
    if (controller.signal.aborted) refuse();
    timer = setTimeout(cancel, 30000);
  });
  const run = async () => {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/imported-projects/strategy-previews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 401)
      throw Error('Sign in again to preview this strategy.');
    const data: unknown = await response.json().catch(() => null);
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw Error('Unsigned preview unavailable. Try again when ready.');
    if (!response.ok) {
      const e = (data as { error?: unknown }).error;
      throw Error(
        typeof e === 'string' && e.length <= 300
          ? e
          : 'Unsigned preview unavailable. No review slots changed.',
      );
    }
    return data;
  };
  try {
    return await Promise.race([stopped, run()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}
