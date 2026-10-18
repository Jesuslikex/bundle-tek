import { expect, it } from 'vitest';
import { sortWalletRoster } from './wallet-roster-view';
import type { WorkspaceWallet } from './wallet-workspace';
import type { WalletBalance } from './wallet-balance-format';
const wallet = (address: string, label = address): WorkspaceWallet => ({
  chain: 'Solana',
  address,
  label,
  folderId: '',
  role: 'Recipient',
  revision: 1,
  archived: false,
  updatedAt: '',
});
const balance = (
  address: string,
  raw: string,
  decimals = 9,
): WalletBalance => ({
  chain: 'Solana',
  address,
  raw,
  decimals,
  amount: 'not used',
  currency: 'SOL',
  blockNumber: 1,
  blockHash: null,
  snapshotId: 'saved',
  source: 'synthetic',
  commitment: 'confirmed',
  observedAt: '2026-10-18T00:00:00Z',
});
it('sorts exact raw native amounts above safe integer precision without mutating saved order', () => {
  const rows = [wallet('a'), wallet('b'), wallet('c')];
  const observations = [
    balance('a', '9007199254740992'),
    balance('b', '9007199254740993'),
  ];
  expect(
    sortWalletRoster(rows, observations, 'balance-high').map((w) => w.address),
  ).toEqual(['b', 'a', 'c']);
  expect(
    sortWalletRoster(rows, observations, 'balance-low').map((w) => w.address),
  ).toEqual(['a', 'b', 'c']);
  expect(rows.map((w) => w.address)).toEqual(['a', 'b', 'c']);
});
it('compares decimals exactly and keeps missing or invalid observations after zero', () => {
  const rows = [
    wallet('unknown'),
    wallet('bad'),
    wallet('high'),
    wallet('zero'),
    wallet('low'),
  ];
  const observations = [
    balance('high', '2', 0),
    balance('low', '1500000000'),
    balance('zero', '0'),
    balance('bad', '-1'),
  ];
  expect(
    sortWalletRoster(rows, observations, 'balance-high').map((w) => w.address),
  ).toEqual(['high', 'low', 'zero', 'bad', 'unknown']);
  expect(
    sortWalletRoster(rows, observations, 'balance-low').map((w) => w.address),
  ).toEqual(['zero', 'low', 'high', 'bad', 'unknown']);
});
it('does not use another chain balance and gives tied rows a deterministic address order', () => {
  const rows = [wallet('b'), wallet('a')];
  expect(
    sortWalletRoster(
      rows,
      [{ ...balance('b', '999'), chain: 'Ethereum' }],
      'balance-high',
    ).map((w) => w.address),
  ).toEqual(['a', 'b']);
  expect(sortWalletRoster(rows, [], 'saved')).toEqual(rows);
  expect(sortWalletRoster(rows, [], 'saved')).not.toBe(rows);
  expect(
    sortWalletRoster([wallet('b', 'Z'), wallet('a', 'A')], [], 'name').map(
      (w) => w.address,
    ),
  ).toEqual(['a', 'b']);
});
