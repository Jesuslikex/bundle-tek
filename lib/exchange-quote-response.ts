export class ExchangeQuoteResponseError extends Error {}

/** Parse provider SOL decimals from their original JSON tokens, never rounded numbers. */
export async function readExactExchangeQuoteResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const limit = 65_536;
  const fail = (): never => {
    throw new ExchangeQuoteResponseError(
      'The exchange returned an unreadable, oversized or inexact quote.',
    );
  };
  if (Number(response.headers.get('content-length')) > limit) return fail();
  const reader = response.body?.getReader();
  if (!reader) return fail();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) return fail();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        (name: string, value: unknown, context?: { source?: string }) => {
          if (
            (name === 'fromAmount' || name === 'toAmount') &&
            typeof value === 'number'
          ) {
            if (
              !context?.source ||
              !/^(0|[1-9]\d{0,9})(\.\d{1,9})?$/.test(context.source)
            )
              return fail();
            return context.source;
          }
          return value;
        },
      );
    } catch {
      return fail();
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
