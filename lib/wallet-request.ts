export async function walletRequest(
  request: Request,
  limit = 4096,
): Promise<Record<string, unknown>> {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new Error('Cross-origin wallet request rejected.');
  if (Number(request.headers.get('content-length') ?? 0) > limit)
    throw new Error('Wallet request too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing wallet request.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('Wallet request too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Invalid wallet request.');
  return body as Record<string, unknown>;
}
