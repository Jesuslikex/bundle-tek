import { getSolanaRpcEndpoint } from './solana-rpc';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { paceWalletRpc } from './wallet-rpc-pacing';
import { inspectToken, TOKEN_READ_RPC } from './token-import';
import { validateTokenSource } from './token-source';

/** One read-only preflight. Configuration and network proof never come from its request. */
export function createWarmupTokenInspector(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([signal, stopped.signal]);
  let network: Promise<string> | undefined;
  const endpoint = () =>
    (network ??= (async () => {
      lifetime.throwIfAborted();
      const configured = getSolanaRpcEndpoint('mainnet');
      const url = new URL(configured);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('Invalid configured token provider.');
      const genesis = await balanceRpc(
        configured,
        'getGenesisHash',
        [],
        AbortSignal.any([lifetime, AbortSignal.timeout(12000)]),
        fetcher,
        262144,
      );
      lifetime.throwIfAborted();
      if (genesis !== SOLANA_MAINNET_GENESIS)
        throw new Error('Token provider network mismatch.');
      return configured;
    })());

  return async (input: unknown) => {
    lifetime.throwIfAborted();
    const source = validateTokenSource(input);
    if (source.chain !== 'Solana') return inspectToken(source, fetcher);
    const configuredFetch: typeof fetch = async (input, init) => {
      // The existing decoder can only request its fixed account reader. Never
      // forward metadata URIs or a request-supplied destination to the provider.
      if (input !== TOKEN_READ_RPC) throw new Error('Unexpected token read.');
      const configured = await endpoint();
      const readSignal = AbortSignal.any([
        lifetime,
        ...(init?.signal ? [init.signal] : []),
      ]);
      readSignal.throwIfAborted();
      await paceWalletRpc(configured, readSignal);
      readSignal.throwIfAborted();
      const response = await fetcher(configured, {
        ...init,
        signal: readSignal,
      });
      if (response.status === 429) {
        stopped.abort(new Error('Token provider rate limited this check.'));
      }
      if (!response.ok) await response.body?.cancel().catch(() => {});
      readSignal.throwIfAborted();
      return response;
    };
    const token = await inspectToken(source, configuredFetch);
    lifetime.throwIfAborted();
    return { ...token, source: new URL(await endpoint()).hostname };
  };
}
