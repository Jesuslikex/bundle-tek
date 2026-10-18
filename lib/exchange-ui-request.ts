/** Bound the complete response, including a body reader that ignores cancellation. */
export async function exchangeUiRequest<T>(
  parent: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 30000,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let cancel = () => {};
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        cancel = () =>
          reject(new Error('Exchange read cancelled or timed out.'));
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
      }),
      read(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}
