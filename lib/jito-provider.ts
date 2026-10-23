import { JITO_ENDPOINT } from './jito-bundle';
import { walletAddress } from './wallet-workspace';
import { readJitoJson } from './jito-json';

export async function jitoRpc(
  method: 'getTipAccounts' | 'sendBundle' | 'getBundleStatuses',
  params: unknown[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  signal.throwIfAborted();
  const response = await fetcher(JITO_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    redirect: 'error',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Jito request failed (${response.status}).`);
  }
  const data = (await readJitoJson(response.body, signal, 32768)) as Record<
    string,
    unknown
  >;
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.jsonrpc !== '2.0' ||
    data.id !== 1 ||
    data.error ||
    !Object.hasOwn(data, 'result')
  )
    throw new Error('Jito response unavailable.');
  return data.result as unknown;
}
export async function getJitoTipAccounts(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const raw = await jitoRpc('getTipAccounts', [], signal, fetcher);
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 32 ||
    new Set(raw).size !== raw.length
  )
    throw new Error('Jito tip accounts unavailable.');
  return raw.map((value) => walletAddress(value, 'Solana'));
}
