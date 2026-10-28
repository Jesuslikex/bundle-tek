import type { LaunchChain } from './launch-plan';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { paceWalletRpc } from './wallet-rpc-pacing';
import { isJitoRetainedRpcReplay } from './jito-retained-rpc-replay';
import { walletAddress, walletChain } from './wallet-workspace';
import {
  formatNativeBalance,
  type BalanceSnapshot,
} from './wallet-balance-format';
export type { WalletBalance, BalanceSnapshot } from './wallet-balance-format';

import { EVM_NETWORKS as EVM_BALANCE_NETWORKS } from './evm-network';
export { EVM_NETWORKS as EVM_BALANCE_NETWORKS } from './evm-network';
export const SOLANA_MAINNET_GENESIS =
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export function validateBalanceRequest(body: unknown) {
  if (!body || typeof body !== 'object')
    throw new Error('Choose wallet addresses.');
  const value = body as Record<string, unknown>;
  const chain = walletChain(value.chain);
  if (
    !Array.isArray(value.addresses) ||
    !value.addresses.length ||
    value.addresses.length > 100
  )
    throw new Error('Refresh between 1 and 100 wallets.');
  const addresses = value.addresses.map((a) => walletAddress(a, chain));
  if (new Set(addresses).size !== addresses.length)
    throw new Error('Remove duplicate wallet addresses.');
  return { chain, addresses };
}
// Modern JSON.parse exposes the original numeric token to the reviver. Preserve
// integer spelling before Number rounding; older engines only admit safe integers.
export function parseBalanceJson(text: string): unknown {
  return JSON.parse(
    text,
    (key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      if (context?.source)
        return /^-?(0|[1-9]\d*)$/.test(context.source) ? context.source : value;
      if (Number.isSafeInteger(value)) return String(value);
      throw new Error('RPC integer precision unavailable.');
    },
  );
}
export class WalletRpcError extends Error {
  constructor(public readonly status: number) {
    super('Balance provider unavailable.');
  }
}
/** Only the fixed code is retained; provider message/data and IDs stay private. */
export class WalletRpcJsonRateLimitError extends WalletRpcError {
  readonly rpcRateLimited = true;
  constructor() {
    super(429);
  }
}
export function hasWalletRpcRateLimit(value: unknown): boolean {
  const replies = Array.isArray(value) ? value : [value];
  return replies.some((reply) => {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply))
      return false;
    const error = (reply as { error?: unknown }).error;
    if (!error || typeof error !== 'object' || Array.isArray(error))
      return false;
    const code = (error as { code?: unknown }).code;
    return code === 429 || code === '429';
  });
}
export async function balanceRpc(
  endpoint: string,
  method: string,
  params: unknown[] | Record<string, unknown>,
  signal: AbortSignal,
  fetcher: typeof fetch,
  maxResponseBytes = 524288,
) {
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 2097152
  )
    throw new Error('Invalid RPC response bound.');
  for (let attempt = 0; ; attempt += 1) {
    if (!/^(eth_|net_|web3_)/.test(method) && !isJitoRetainedRpcReplay(fetcher))
      await paceWalletRpc(endpoint, signal);
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) throw new WalletRpcError(response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty balance provider response.');
    let size = 0,
      text = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          throw new Error('Balance response too large.');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const result = parseBalanceJson(text) as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (hasWalletRpcRateLimit(result)) throw new WalletRpcJsonRateLimitError();
    // A JSON-RPC level error is usually the provider throttling a burst; retry
    // briefly before surfacing it as an invalid response.
    if (result && result.jsonrpc === '2.0' && result.error && attempt < 2) {
      // Keep the whole ladder inside a one second caller budget, and stop
      // sleeping as soon as the caller aborts.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 250 * (attempt + 1));
        function done() {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        }
        signal.addEventListener('abort', done, { once: true });
      });
      signal.throwIfAborted();
      continue;
    }
    if (
      !result ||
      result.jsonrpc !== '2.0' ||
      result.id !== '1' ||
      result.error ||
      result.result === undefined
    )
      throw new Error('Invalid balance provider response.');
    return result.result;
  }
}
function decimalUint(value: unknown, max: bigint) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,77})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid balance provider integer.');
  return value;
}
function hexUint(value: unknown, max: bigint) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid EVM balance quantity.');
  return BigInt(value);
}
export async function observeWalletBalances(
  chain: LaunchChain,
  addresses: string[],
  signal: AbortSignal = AbortSignal.timeout(25000),
  fetcher: typeof fetch = fetch,
): Promise<BalanceSnapshot> {
  const request = validateBalanceRequest({ chain, addresses });
  addresses = request.addresses;
  let raw: string[],
    blockNumber: number,
    blockHash: string | null = null,
    currency: string,
    source: string,
    commitment: string,
    decimals: number;
  if (chain === 'Solana') {
    const endpoint = getSolanaRpcEndpoint('mainnet');
    source = new URL(endpoint).hostname;
    currency = 'SOL';
    decimals = 9;
    commitment = 'confirmed';
    if (
      (await balanceRpc(endpoint, 'getGenesisHash', [], signal, fetcher)) !==
      SOLANA_MAINNET_GENESIS
    )
      throw new Error('Balance provider network mismatch.');
    const result = (await balanceRpc(
      endpoint,
      'getMultipleAccounts',
      [
        addresses,
        {
          commitment: 'confirmed',
          encoding: 'base64',
          dataSlice: { offset: 0, length: 0 },
        },
      ],
      signal,
      fetcher,
    )) as { context?: { slot?: unknown }; value?: unknown };
    blockNumber = Number(
      decimalUint(result?.context?.slot, BigInt(Number.MAX_SAFE_INTEGER)),
    );
    if (
      !Array.isArray(result?.value) ||
      result.value.length !== addresses.length
    )
      throw new Error('Incomplete Solana balance snapshot.');
    raw = result.value.map((account: { lamports?: unknown } | null) =>
      account === null ? '0' : decimalUint(account?.lamports, (1n << 64n) - 1n),
    );
  } else {
    const network = EVM_BALANCE_NETWORKS[chain];
    const endpoint = network.endpoint;
    source = new URL(endpoint).hostname;
    currency = network.currency;
    decimals = 18;
    commitment = 'latest block';
    if (
      hexUint(
        await balanceRpc(endpoint, 'eth_chainId', [], signal, fetcher),
        BigInt(Number.MAX_SAFE_INTEGER),
      ) !== BigInt(network.id)
    )
      throw new Error('Balance provider network mismatch.');
    const header = (await balanceRpc(
      endpoint,
      'eth_getBlockByNumber',
      ['latest', false],
      signal,
      fetcher,
    )) as { number?: unknown; hash?: unknown; timestamp?: unknown };
    blockNumber = Number(
      hexUint(header?.number, BigInt(Number.MAX_SAFE_INTEGER)),
    );
    if (
      typeof header?.hash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(header.hash)
    )
      throw new Error('Invalid balance block hash.');
    blockHash = header.hash;
    const timestamp =
      Number(hexUint(header.timestamp, BigInt(Number.MAX_SAFE_INTEGER))) * 1000;
    if (timestamp > Date.now() + 300000 || timestamp < Date.now() - 900000)
      throw new Error('Balance provider block is stale.');
    // Eight workers, all pinned to one canonical block hash (EIP-1898).
    raw = Array.from({ length: addresses.length }, () => '');
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, addresses.length) }, async () => {
        while (next < addresses.length) {
          const index = next++;
          raw[index] = hexUint(
            await balanceRpc(
              endpoint,
              'eth_getBalance',
              [addresses[index], { blockHash, requireCanonical: true }],
              signal,
              fetcher,
            ),
            (1n << 256n) - 1n,
          ).toString();
        }
      }),
    );
  }
  const observedAt = new Date().toISOString(),
    snapshotId = crypto.randomUUID();
  const items = addresses.map((address, index) => ({
    chain,
    address,
    raw: raw[index],
    amount: formatNativeBalance(raw[index], decimals),
    currency,
    decimals,
    blockNumber,
    blockHash,
    observedAt,
    snapshotId,
    source,
    commitment,
  }));
  return {
    chain,
    items,
    total: formatNativeBalance(
      raw.reduce((sum, v) => sum + BigInt(v), 0n).toString(),
      decimals,
    ),
    currency,
    blockNumber,
    blockHash,
    observedAt,
    snapshotId,
    source,
    commitment,
  };
}
