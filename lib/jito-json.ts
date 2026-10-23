/** Bounded UTF-8 JSON for the Jito request/response boundary. No retries. */
export class JitoJsonError extends Error {
  constructor(readonly status: 400 | 408 | 413) {
    super(
      status === 413
        ? 'Jito JSON exceeds its byte limit.'
        : status === 408
          ? 'Jito JSON read interrupted.'
          : 'Jito JSON is unavailable.',
    );
  }
}
export async function readJitoJson(
  stream: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  limit: number,
): Promise<unknown> {
  if (!stream) throw new JitoJsonError(400);
  const reader = stream.getReader();
  let finished = false,
    size = 0,
    text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) {
        finished = true;
        break;
      }
      size += part.value.byteLength;
      if (size > limit) throw new JitoJsonError(413);
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (signal.aborted) throw new JitoJsonError(408);
    if (error instanceof JitoJsonError) throw error;
    throw new JitoJsonError(400);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}
