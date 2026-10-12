import { expect, it } from 'vitest';
import { importedHolderSummary } from './imported-holder-summary';
import { supplyWallet } from '../test/supply-history-fixture';
const mint = supplyWallet(9),
  owner = supplyWallet(1),
  excluded = supplyWallet(2);
const value = {
  mint,
  network: 'mainnet',
  decimals: 6,
  slot: 100,
  observedAt: '2026-10-12T00:00:00Z',
  totalSupplyRaw: '1000',
  bundle: { raw: '100', walletCount: 1 },
  external: { raw: '900' },
  topExternal: [{ rank: 1, owner, raw: '200' }],
};
it('retains exact raw units and scoped sampled owners', () => {
  expect(importedHolderSummary(value, mint, 6, [excluded])).toMatchObject({
    totalSupplyRaw: '1000',
    holders: [{ owner, raw: '200' }],
  });
});
it('rejects foreign mint, precision, network and exclusion scope', () => {
  for (const changed of [
    { ...value, mint: owner },
    { ...value, decimals: 0 },
    { ...value, network: 'devnet' },
    { ...value, bundle: { raw: '100', walletCount: 0 } },
  ])
    expect(() => importedHolderSummary(changed, mint, 6, [excluded])).toThrow();
});
it('rejects duplicate or excluded owners and invalid ranking', () => {
  for (const topExternal of [
    [...value.topExternal, { rank: 2, owner, raw: '100' }],
    [{ rank: 1, owner: excluded, raw: '100' }],
    [{ rank: 2, owner, raw: '100' }],
  ])
    expect(() =>
      importedHolderSummary({ ...value, topExternal }, mint, 6, [excluded]),
    ).toThrow();
});
it('rejects inconsistent totals, malformed units and sampled shares exceeding remaining supply', () => {
  for (const changed of [
    { ...value, external: { raw: '899' } },
    { ...value, totalSupplyRaw: '1.1' },
    { ...value, topExternal: [{ rank: 1, owner, raw: '901' }] },
  ])
    expect(() => importedHolderSummary(changed, mint, 6, [excluded])).toThrow();
});
