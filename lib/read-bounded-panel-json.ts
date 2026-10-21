/** Cancellable bounded JSON for explicit public-metadata panel reads. */
export const PANEL_JSON_RESPONSE_BYTES = 1048576;
export async function readBoundedPanelJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error('The panel response is unavailable.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The panel response is unavailable.');
  let finished = false,
    cancelled = false,
    size = 0,
    text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => {
    if (!cancelled) {
      cancelled = true;
      void reader.cancel().catch(() => {});
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        finished = true;
        break;
      }
      size += next.value.byteLength;
      if (size > PANEL_JSON_RESPONSE_BYTES)
        throw new Error('The panel response is unavailable.');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error('The panel response is unavailable.');
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}
