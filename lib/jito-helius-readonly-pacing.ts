import { paceWalletRpc } from './wallet-rpc-pacing';
/** Local unsigned research only. Opt into the existing Helius qualification
 * queue, then additionally cap actual wire admissions (batch units together)
 * at nine methods per guarded rolling second. No provider retry or settings. */
export function createJitoHeliusReadonlyPacer(
  endpoint: string,
  signal: AbortSignal,
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'mainnet.helius-rpc.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error('Helius research pacing scope refused.');
  let tail = Promise.resolve();
  const sent: { at: number; units: number }[] = [];
  return async (units: number) => {
    if (!Number.isInteger(units) || units < 1 || units > 5)
      throw Error('Helius research method count refused.');
    const pending = tail.then(async () => {
      signal.throwIfAborted();
      for (let i = 0; i < units; i++) await paceWalletRpc(endpoint, signal, 1);
      for (;;) {
        signal.throwIfAborted();
        const now = Date.now();
        while (sent.length && sent[0].at <= now - 1025) sent.shift();
        if (sent.reduce((sum, s) => sum + s.units, 0) + units <= 9) {
          sent.push({ at: now, units });
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(signal.reason);
          };
          const timer = setTimeout(
            () => {
              signal.removeEventListener('abort', abort);
              resolve();
            },
            Math.max(1, sent[0].at + 1025 - now),
          );
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    });
    tail = pending.catch(() => {});
    return pending;
  };
}
