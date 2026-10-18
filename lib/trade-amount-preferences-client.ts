import {
  requireTradeAmountPreferenceView,
  type TradeAmountPresets,
} from './trade-amount-preferences';
export async function tradeAmountPreferenceRequest(
  ownerId: string,
  signal: AbortSignal,
  save?: { revision: number; preferences: TradeAmountPresets },
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const stopped = new Promise<never>((_, reject) => {
    const refuse = () =>
      reject(
        Error(
          save
            ? 'Preset save not confirmed. Reload saved presets before retrying.'
            : 'Preset request cancelled or timed out. Default shortcuts remain available.',
        ),
      );
    controller.signal.addEventListener('abort', refuse, { once: true });
    if (controller.signal.aborted) refuse();
    timer = setTimeout(cancel, 15000);
  });
  const run = async () => {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/trade-amount-preferences', {
      ...(save
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ownerId, ...save }),
          }
        : { cache: 'no-store' }),
      signal: controller.signal,
    });
    if (response.status === 401)
      throw Error('Sign in again to use saved presets.');
    const value: unknown = await response.json().catch(() => null);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error(
        'Saved presets unavailable. Default shortcuts remain available.',
      );
    if (!response.ok) {
      const error = (value as { error?: unknown }).error;
      throw Error(
        typeof error === 'string' && error.length <= 300
          ? error
          : 'Saved presets unavailable. Reload before saving again.',
      );
    }
    return requireTradeAmountPreferenceView(value, ownerId);
  };
  try {
    return await Promise.race([stopped, run()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}
