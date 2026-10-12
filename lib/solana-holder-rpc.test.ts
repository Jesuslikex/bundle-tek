import { afterEach, expect, it } from 'vitest';
import { env } from '../test/cloudflare-workers';
import {
  getSolanaHolderRpcEndpoint,
  getSolanaIndexerRpcEndpoint,
  getSolanaRpcEndpoint,
} from './solana-rpc';
const keys = [
  'SOLANA_HOLDER_RPC_URL',
  'SOLANA_INDEXER_RPC_URL',
  'SOLANA_MAINNET_RPC_URL',
];
const prior = Object.fromEntries(keys.map((key) => [key, env[key]]));
afterEach(() => {
  for (const key of keys) {
    if (prior[key] === undefined) delete env[key];
    else env[key] = prior[key];
  }
});
it('isolates holder reads from existing balance and signing providers', () => {
  env.SOLANA_HOLDER_RPC_URL = 'https://holders.example/v2/test';
  env.SOLANA_INDEXER_RPC_URL = 'https://indexer.example/?api-key=test';
  env.SOLANA_MAINNET_RPC_URL = 'https://signing.example/?api-key=test';
  expect(getSolanaHolderRpcEndpoint()).toBe(env.SOLANA_HOLDER_RPC_URL);
  expect(getSolanaIndexerRpcEndpoint()).toBe(env.SOLANA_INDEXER_RPC_URL);
  expect(getSolanaRpcEndpoint('mainnet')).toBe(env.SOLANA_MAINNET_RPC_URL);
});
it('preserves indexer fallback without an explicit holder endpoint', () => {
  delete env.SOLANA_HOLDER_RPC_URL;
  env.SOLANA_INDEXER_RPC_URL = 'https://indexer.example';
  expect(getSolanaHolderRpcEndpoint()).toBe(env.SOLANA_INDEXER_RPC_URL);
});
it('fails closed on invalid holder configuration instead of silently falling back', () => {
  for (const endpoint of [
    'invalid',
    'http://holders.example',
    'https://user:pass@holders.example',
    'https://holders.example/#secret',
  ]) {
    env.SOLANA_HOLDER_RPC_URL = endpoint;
    expect(() => getSolanaHolderRpcEndpoint()).toThrow();
  }
});
