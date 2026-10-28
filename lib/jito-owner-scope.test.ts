import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { JITO_OWNER_SCOPE_HEADER, jitoOwnerScope } from './jito-owner-scope';

it('computes the same domain-separated marker for each valid owner without exposing its ID', async () => {
  const owner = 'owner-😀';
  const expected = createHash('sha256')
    .update(JSON.stringify(['jito-bundle-owner-scope-v1', owner]), 'utf8')
    .digest('hex');
  expect(JITO_OWNER_SCOPE_HEADER).toBe('x-jito-owner-scope');
  expect(await jitoOwnerScope(owner)).toBe(expected);
  expect(await jitoOwnerScope('another-owner')).not.toBe(expected);
  expect(expected).not.toContain(owner);
});

it.each(['', 'x'.repeat(129), '\ud800', '\udc00', 'x\ud800y'])(
  'rejects missing, oversized or ill-formed owner identity %j',
  async (owner) => {
    await expect(jitoOwnerScope(owner)).rejects.toThrow(
      'Jito account scope unavailable.',
    );
  },
);
