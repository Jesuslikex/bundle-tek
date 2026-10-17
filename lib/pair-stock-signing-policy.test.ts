import { expect, it } from 'vitest';
import { pairStockSigningPolicy } from './pair-stock-signing-policy';

it('qualifies only for the exact server value true', () => {
  expect(
    pairStockSigningPolicy({ SOLANA_STOCK_SIGNING_ENABLED: 'true' }).qualified,
  ).toBe(true);
  for (const value of [
    undefined,
    '',
    'TRUE',
    'True',
    '1',
    'yes',
    'true ',
    ' true',
    'false',
  ])
    expect(
      pairStockSigningPolicy({ SOLANA_STOCK_SIGNING_ENABLED: value }),
    ).toMatchObject({
      qualified: false,
      reason: expect.stringContaining('disabled'),
    });
  expect(pairStockSigningPolicy({}).qualified).toBe(false);
  const throwing = new Proxy({} as Record<string, string>, {
    get() {
      throw Error('browser');
    },
  });
  expect(pairStockSigningPolicy(throwing).qualified).toBe(false);
});
