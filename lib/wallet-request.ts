export async function walletRequest(
  request: Request,
  limit = 4096,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new Error('Cross-origin wallet request rejected.');
  if (Number(request.headers.get('content-length') ?? 0) > limit)
    throw new Error('Wallet request too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing wallet request.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  // Signal-aware callers opt in and map cancellation explicitly. Existing
  // callers keep their established request-validation/error ordering.
  signal?.addEventListener('abort', cancel, { once: true });
  let bytes = 0,
    text = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        cancel();
        throw new Error('Wallet request too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Invalid wallet request.');
  return body as Record<string, unknown>;
}
