import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { EVM_NETWORKS, evmChain } from './evm-network';
import { walletAddress, walletChain } from './wallet-workspace';
import { warmupDecimal, type WarmupHistory } from './wallet-warmup';

function quantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
  )
    throw new Error('Invalid RPC quantity.');
  return BigInt(value);
}
export async function observeWarmupHistory(
  chainValue: string,
  addressValue: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<WarmupHistory> {
  const chain = walletChain(chainValue),
    address = walletAddress(addressValue, chain);
  if (chain !== 'Solana') {
    const network = EVM_NETWORKS[evmChain(chain)],
      rpc = (method: string, params: unknown[]) =>
        balanceRpc(network.endpoint, method, params, signal, fetcher);
    if (quantity(await rpc('eth_chainId', [])) !== BigInt(network.id))
      throw new Error('Wrong network.');
    const header = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
      hash: string;
      number: string;
      timestamp: string;
    };
    if (!header || !/^0x[0-9a-fA-F]{64}$/.test(header.hash))
      throw new Error('Invalid block.');
    const block = quantity(header.number).toString(),
      ref = { blockHash: header.hash, requireCanonical: true };
    const blockTime = quantity(header.timestamp) * 1000n;
    const now = BigInt(Date.now());
    if (blockTime < now - 900000n || blockTime > now + 300000n)
      throw new Error('History provider block is stale or future-dated.');
    const [balance, nonce] = await Promise.all([
      rpc('eth_getBalance', [address, ref]),
      rpc('eth_getTransactionCount', [address, ref]),
    ]);
    const final = (await rpc('eth_getBlockByNumber', [
      header.number,
      false,
    ])) as { hash: string; number: string; timestamp: string };
    if (
      final?.hash !== header.hash ||
      final.number !== header.number ||
      final.timestamp !== header.timestamp
    )
      throw new Error('Block changed.');
    return {
      address,
      chain,
      source: new URL(network.endpoint).hostname,
      observedAt: new Date().toISOString(),
      nativeBalance: warmupDecimal(quantity(balance), 18),
      currency: network.currency,
      block,
      blockHash: header.hash,
      outgoingTransactions: quantity(nonce).toString(),
      sampleCount: null,
      successfulSampleCount: null,
      oldestObservedAt: null,
      latestObservedAt: null,
      coverage:
        'Canonical account nonce only. No incoming/internal transaction history or wallet age. Delegated/contract account nonce is not a trade count.',
    };
  }
  const source = getSolanaRpcEndpoint('mainnet'),
    rpc = (method: string, params: unknown[]) =>
      balanceRpc(source, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Wrong network.');
  const balance = (await rpc('getBalance', [
    address,
    { commitment: 'finalized' },
  ])) as { context: { slot: string }; value: string };
  if (
    !balance ||
    !/^(0|[1-9]\d{0,19})$/.test(balance.value) ||
    BigInt(balance.value) > 18446744073709551615n ||
    !/^(0|[1-9]\d{0,15})$/.test(balance.context?.slot)
  )
    throw new Error('Invalid balance.');
  const slot = Number(balance.context.slot);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Invalid slot.');
  const rows = (await rpc('getSignaturesForAddress', [
    address,
    { commitment: 'finalized', limit: 50, minContextSlot: slot },
  ])) as Array<{
    signature: string;
    slot: string;
    blockTime: string | null;
    err: unknown;
  }>;
  if (
    !Array.isArray(rows) ||
    rows.length > 50 ||
    rows.some(
      (r) =>
        !r ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature) ||
        !/^(0|[1-9]\d{0,15})$/.test(r.slot) ||
        BigInt(r.slot) > BigInt(slot) ||
        !(
          r.err === null ||
          (typeof r.err === 'object' && !Array.isArray(r.err))
        ) ||
        !(
          r.blockTime === null ||
          (typeof r.blockTime === 'string' &&
            /^(0|[1-9]\d{0,10})$/.test(r.blockTime) &&
            Number.isSafeInteger(Number(r.blockTime)) &&
            Number(r.blockTime) <= Date.now() / 1000 + 60)
        ),
    )
  )
    throw new Error('Invalid history.');
  if (new Set(rows.map((r) => r.signature)).size !== rows.length)
    throw new Error('Duplicate history.');
  if (
    rows.some(
      (r, index) => index > 0 && BigInt(r.slot) > BigInt(rows[index - 1].slot),
    )
  )
    throw new Error('History is not in descending slot order.');
  const times = rows
    .flatMap((r) => (r.blockTime === null ? [] : [Number(r.blockTime)]))
    .sort((a, b) => a - b);
  return {
    address,
    chain,
    source: new URL(source).hostname,
    observedAt: new Date().toISOString(),
    block: String(slot),
    nativeBalance: warmupDecimal(BigInt(balance.value), 9),
    currency: 'SOL',
    outgoingTransactions: null,
    sampleCount: rows.length,
    successfulSampleCount: rows.filter((r) => r.err === null).length,
    oldestObservedAt: times.length
      ? new Date(times[0] * 1000).toISOString()
      : null,
    latestObservedAt: times.length
      ? new Date(times[times.length - 1] * 1000).toISOString()
      : null,
    coverage:
      'Latest 50 finalized signature records only, without transaction decoding. Oldest sampled activity is not creation age. Empty results may reflect provider retention.',
  };
}
