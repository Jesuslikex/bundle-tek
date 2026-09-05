import { describe, it, expect } from 'vitest';
import { validateIntent } from './intent';
import { sample } from './testing';
describe('immutable ETH intents', () => {
  it('validates exact input and freezes nested fields', () => {
    const x = validateIntent(sample);
    expect(x.chainId).toBe(4663);
    expect(Object.isFrozen(x.socials)).toBe(true);
    expect(() =>
      validateIntent({ ...sample, mode: 'independent-multi-wallet' }),
    ).toThrow();
    expect(() => validateIntent({ ...sample, quoteInWei: '1.2' })).toThrow();
    expect(() =>
      validateIntent({ ...sample, rawTransaction: '0x1234' }),
    ).toThrow();
  });
});

it('requires explicit total ETH and gas cost ceilings', () => {
  expect(() =>
    validateIntent({ ...sample, maxTotalValueWei: undefined }),
  ).toThrow();
  expect(() => validateIntent({ ...sample, maxGasCostWei: '-1' })).toThrow();
});
