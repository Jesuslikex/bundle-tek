import { createHash } from 'node:crypto';

export const stockReferenceHash = (value) =>
  createHash('sha256').update(value).digest('hex');

export function stockReferenceFixture(text, asset) {
  const value = JSON.parse(text);
  if (
    value.format !== 'stock-public-reference-fixture-v1' ||
    value.readOnly !== true ||
    !['SOL', 'USDC'].includes(asset) ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.references?.[asset] ?? '') ||
    value.referenceHashes?.[asset] !==
      stockReferenceHash(value.references[asset])
  )
    throw Error('Invalid pinned public reference fixture.');
  return value.references[asset];
}
