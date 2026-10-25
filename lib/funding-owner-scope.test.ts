import { expect, it } from 'vitest';
import {
  fundingOwnerScope,
  FUNDING_OWNER_SCOPE_HEADER,
} from './funding-owner-scope';
it('returns a stable purpose-separated opaque namespace without returning the owner identifier', () => {
  const a = fundingOwnerScope('account-alice');
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).toBe(fundingOwnerScope('account-alice'));
  expect(a).not.toBe(fundingOwnerScope('account-bob'));
  expect(a).not.toContain('alice');
  expect(FUNDING_OWNER_SCOPE_HEADER).toBe('x-bundle-funding-owner-scope');
});
it('refuses an absent authenticated owner rather than falling back to a shared namespace', () => {
  for (const value of ['', null, undefined, 1])
    expect(() => fundingOwnerScope(value as string)).toThrow('signed-in');
});
