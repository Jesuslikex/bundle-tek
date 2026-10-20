import { expect, it } from 'vitest';
import { isMarketplaceOperator } from './marketplace-operator-policy';
it('authorizes only exact verified session IDs explicitly configured on the server', () => {
  const config = {
    MARKETPLACE_OPERATOR_USER_IDS: '["founder_1","operator-2"]',
  };
  expect(isMarketplaceOperator('founder_1', config)).toBe(true);
  expect(isMarketplaceOperator('operator-2', config)).toBe(true);
  expect(isMarketplaceOperator('Founder_1', config)).toBe(false);
  expect(isMarketplaceOperator('buyer', config)).toBe(false);
  expect(isMarketplaceOperator('founder@example.com', config)).toBe(false);
});
it.each([
  undefined,
  '',
  '*',
  'founder_1',
  'null',
  '{}',
  '[]',
  '["*"]',
  '[" founder_1"]',
  '["founder_1","founder_1"]',
  '[true]',
  '["founder@example.com"]',
  JSON.stringify(Array.from({ length: 21 }, (_, i) => `user${i}`)),
  ' '.repeat(4097),
])('fails closed on missing or malformed seller policy: %s', (raw) => {
  expect(
    isMarketplaceOperator('founder_1', { MARKETPLACE_OPERATOR_USER_IDS: raw }),
  ).toBe(false);
});
