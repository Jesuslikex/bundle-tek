import { WarmupQuoteError } from './warmup-swap-quote';

/** Bounded provider JSON. Abort also cancels a body that has stalled after headers. */
export async function readCounterProviderResponse(
  response: Response,
  signal: AbortSignal,
  label: 'Counter quote' | 'Counter preparation',
  limit: number,
) {
  const reader = response.body?.getReader();
  if (!reader)
    throw new WarmupQuoteError(`Empty ${label} response.`, 'INVALID_RESPONSE');
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let text = '',
    size = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    if (signal.aborted) throw new WarmupQuoteError(`${label} was cancelled.`);
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new WarmupQuoteError(`${label} was cancelled.`);
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new WarmupQuoteError(
          `${label} response exceeds its size limit.`,
          'INVALID_RESPONSE',
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    cancel();
    if (error instanceof WarmupQuoteError) throw error;
    throw new WarmupQuoteError(
      `${label} response could not be read.`,
      'INVALID_RESPONSE',
    );
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new WarmupQuoteError(
      `${label} service returned invalid data.`,
      'INVALID_RESPONSE',
    );
  }
}
