import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSolanaIndexerRpcEndpoint,
  getSolanaRpcEndpoint,
  MAX_SOLANA_SLOT_DRIFT,
  requireConsistentSolanaSlots,
  rpcCall,
} from '@/lib/solana-rpc';
import { env } from 'cloudflare:workers';

it('prefers the dedicated holdings provider without changing native or devnet RPC selection', () => {
  const previousIndexer = env.SOLANA_INDEXER_RPC_URL;
  const previousMainnet = env.SOLANA_MAINNET_RPC_URL;
  try {
    delete env.SOLANA_INDEXER_RPC_URL;
    delete env.SOLANA_MAINNET_RPC_URL;
    expect(getSolanaIndexerRpcEndpoint()).toBe(
      'https://api.mainnet.solana.com',
    );
    env.SOLANA_MAINNET_RPC_URL = 'https://mainnet.example.test/';
    expect(getSolanaIndexerRpcEndpoint()).toBe(env.SOLANA_MAINNET_RPC_URL);
    env.SOLANA_INDEXER_RPC_URL =
      'https://indexer.example.test/?api-key=fixture';
    expect(getSolanaIndexerRpcEndpoint()).toBe(env.SOLANA_INDEXER_RPC_URL);
    expect(getSolanaRpcEndpoint('mainnet')).toBe(env.SOLANA_MAINNET_RPC_URL);
    expect(getSolanaRpcEndpoint('devnet')).toBe(
      'https://api.devnet.solana.com',
    );
  } finally {
    if (previousIndexer === undefined) delete env.SOLANA_INDEXER_RPC_URL;
    else env.SOLANA_INDEXER_RPC_URL = previousIndexer;
    if (previousMainnet === undefined) delete env.SOLANA_MAINNET_RPC_URL;
    else env.SOLANA_MAINNET_RPC_URL = previousMainnet;
  }
});

describe('rpcCall', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('attaches an abort signal so stalled RPC requests cannot hang indefinitely', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      rpcCall<{ ok: boolean }>('https://rpc.test', 'demo'),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('requireConsistentSolanaSlots', () => {
  it('returns the newest slot when the snapshot stays inside the drift window', () => {
    expect(requireConsistentSolanaSlots([100, 104, 102])).toBe(104);
  });

  it('rejects a snapshot assembled across too many slots', () => {
    expect(() =>
      requireConsistentSolanaSlots([100, 100 + MAX_SOLANA_SLOT_DRIFT + 1]),
    ).toThrow(/crossed too many slots/);
  });
});

it('uses the official public devnet endpoint by default, matching the browser client', () => {
  expect(getSolanaRpcEndpoint('devnet')).toBe('https://api.devnet.solana.com');
});
