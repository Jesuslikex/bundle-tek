import { describe, expect, it } from 'vitest';
import { importedTokenDocument } from './imported-token-project';
import type { ImportedToken } from './token-import';
const token: ImportedToken = {
  chain: 'Base',
  address: '0x1111111111111111111111111111111111111111',
  name: 'Token',
  symbol: 'TOK',
  decimals: 18,
  totalSupplyRaw: ((1n << 256n) - 1n).toString(),
  metadataUri: '',
  observedAt: '2026-10-10T08:00:00Z',
  source: 'https://rpc.example.test',
  blockNumber: 1,
};
describe('imported project identity', () => {
  it('preserves the full ERC20 uint256 range', () => {
    expect(importedTokenDocument(token, token).token.totalSupplyRaw).toBe(
      token.totalSupplyRaw,
    );
  });
  it('rejects mismatched identity, invalid context and out of range supplies', () => {
    for (const patch of [
      { address: '0x2222222222222222222222222222222222222222' },
      { blockNumber: -1 },
      { totalSupplyRaw: (1n << 256n).toString() },
      { source: 'https://user:password@rpc.example.test' },
    ])
      expect(() =>
        importedTokenDocument(token, { ...token, ...patch }),
      ).toThrow();
  });
});
