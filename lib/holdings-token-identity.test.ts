import { expect, it } from 'vitest';
import { holdingsTokenIdentity } from './holdings-token-identity';
import { TOKEN_PROGRAMS, type TokenHolding } from './wallet-holdings';
import { formatNativeBalance } from './wallet-balance-format';

const holding: TokenHolding = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  program: TOKEN_PROGRAMS[0],
  raw: '9007199254740993',
  amount: '9007199254.740993',
  decimals: 6,
  accounts: [],
};
const token = () => ({
  chain: 'Solana',
  address: holding.mint,
  tokenProgram: holding.program,
  name: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
  totalSupplyRaw: '18446744073709551615',
  contextSlot: 100,
  observedAt: '2026-10-10T07:00:00.000Z',
  metadataKind: 'Metaplex',
  source: 'https://rpc.example.test/path?api-key=fixture',
});
it('matches the exact held mint/program/decimals and preserves full u64 supply without exposing the provider URL', () => {
  const result = holdingsTokenIdentity(token(), holding);
  expect(result.totalSupplyRaw).toBe('18446744073709551615');
  expect(formatNativeBalance(result.totalSupplyRaw, result.decimals)).toBe(
    '18446744073709.551615',
  );
  expect(result.source).toBe('rpc.example.test');
  expect(JSON.stringify(result)).not.toContain('api-key');
});
it('rejects an unrelated mint, chain, program or decimal precision instead of naming the wrong holding', () => {
  for (const patch of [
    { address: 'So11111111111111111111111111111111111111112' },
    { chain: 'Base' },
    { tokenProgram: TOKEN_PROGRAMS[1] },
    { tokenProgram: undefined },
    { decimals: 9 },
  ])
    expect(() =>
      holdingsTokenIdentity({ ...token(), ...patch }, holding),
    ).toThrow(/match/);
});
it('rejects malformed supply/context/source and accepts correctly linked Token-2022 identity', () => {
  for (const patch of [
    { totalSupplyRaw: '18446744073709551616' },
    { totalSupplyRaw: Number.MAX_SAFE_INTEGER + 1 },
    { totalSupplyRaw: '1e9' },
    { contextSlot: -1 },
    { contextSlot: Number.MAX_SAFE_INTEGER + 1 },
    { observedAt: 'invalid' },
    { source: 'javascript:alert(1)' },
    { source: 'https://user:secret@rpc.example.test/' },
  ])
    expect(() =>
      holdingsTokenIdentity({ ...token(), ...patch }, holding),
    ).toThrow();
  expect(
    holdingsTokenIdentity(
      {
        ...token(),
        tokenProgram: TOKEN_PROGRAMS[1],
        metadataKind: 'Token-2022',
      },
      { ...holding, program: TOKEN_PROGRAMS[1] },
    ).metadataKind,
  ).toBe('Token-2022');
});
