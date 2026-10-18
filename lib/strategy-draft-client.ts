import { UUID } from './wallet-operation';
import { requireStrategySessionPlan } from './strategy-session-plan';
import type { SavedStrategyDraft } from './strategy-session-drafts';
export function readSavedStrategyDraft(
  value: unknown,
  projectId: string,
): SavedStrategyDraft {
  const d = value as SavedStrategyDraft;
  if (
    !d ||
    !UUID.test(d.id) ||
    !Number.isSafeInteger(d.revision) ||
    d.revision < 1 ||
    typeof d.archived !== 'boolean' ||
    typeof d.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(d.createdAt))
  )
    throw new Error('Saved strategy draft unavailable.');
  const plan = requireStrategySessionPlan(d.plan);
  if (plan.input.projectId !== projectId)
    throw new Error('Strategy draft belongs to a different project.');
  return {
    id: d.id,
    revision: d.revision,
    archived: d.archived,
    createdAt: d.createdAt,
    plan,
  };
}
export async function strategyDraftRequest(
  url: string,
  body: object | undefined,
  signal: AbortSignal,
  subject: 'drafts' | 'capacity' = 'drafts',
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>,
    cancel = () => {};
  const stop = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(
        new Error(
          body
            ? subject === 'capacity'
              ? 'Review slot outcome not confirmed. Reload review slots before retrying the same request.'
              : 'Save outcome not confirmed. Reload drafts before retrying the same save.'
            : subject === 'capacity'
              ? 'Review slot request cancelled. Reload review slots to try again.'
              : 'Draft request cancelled. Reload to try again.',
        ),
      );
    };
    timer = setTimeout(cancel, 15000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([
      stop,
      (async () => {
        const response = await fetch(url, {
          ...(body
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }
            : { cache: 'no-store' }),
          signal: controller.signal,
        });
        if (response.status === 401)
          throw new Error(
            subject === 'capacity'
              ? 'Sign in again to review strategy capacity.'
              : 'Sign in again to open strategy drafts.',
          );
        const data: unknown = await response.json().catch(() => null);
        if (!data || typeof data !== 'object' || Array.isArray(data))
          throw new Error(
            subject === 'capacity'
              ? 'Review capacity unavailable. Reload review slots before retrying.'
              : 'Strategy drafts unavailable. Reload before retrying.',
          );
        const record = data as Record<string, unknown>;
        if (!response.ok)
          throw new Error(
            typeof record.error === 'string' && record.error.length <= 300
              ? record.error
              : 'Strategy draft request failed.',
          );
        if (record.planningOnly !== true || record.executionAllowed !== false)
          throw new Error('Strategy draft response authority differs.');
        return record;
      })(),
    ]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', cancel);
  }
}
