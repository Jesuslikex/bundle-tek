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

export const STOCK_REFERENCE_POOL_MAX = 16;

/**
 * Candidate public references for one asset. A single-reference fixture yields
 * one candidate; a pool yields up to sixteen distinct, individually hashed
 * candidates. Callers still apply the idle, funded and stable checks.
 */
export function stockReferencePool(text, asset) {
  const value = JSON.parse(text);
  if (value.format === 'stock-public-reference-fixture-v1')
    return [stockReferenceFixture(text, asset)];
  const keys = value.references?.[asset],
    hashes = value.referenceHashes?.[asset];
  if (
    value.format !== 'stock-public-reference-pool-v1' ||
    value.readOnly !== true ||
    !['SOL', 'USDC'].includes(asset) ||
    !Array.isArray(keys) ||
    !Array.isArray(hashes) ||
    keys.length < 1 ||
    keys.length > STOCK_REFERENCE_POOL_MAX ||
    hashes.length !== keys.length ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key, i) =>
        typeof key !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key) ||
        hashes[i] !== stockReferenceHash(key),
    )
  )
    throw Error('Invalid pinned public reference pool.');
  return [...keys];
}
