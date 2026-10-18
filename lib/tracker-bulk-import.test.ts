import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  reviewTrackerImport,
  type TrackerImportDefaults,
} from './tracker-bulk-import';
import type { TrackedWallet } from './tracked-wallet';
const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const defaults: TrackerImportDefaults = {
  network: 'mainnet',
  label: 'Batch',
  group: 'Research',
  icon: '⭐',
  favorite: false,
};
const saved = (n: number, archived = false): TrackedWallet => ({
  ...defaults,
  address: address(n),
  archived,
  updatedAt: '2026-10-18T00:00:00.000Z',
});
it('parses newline and comma addresses without changing their public metadata defaults', () => {
  const result = reviewTrackerImport(
    ` ${address(1)},\n${address(2)}\r\n\n`,
    defaults,
    [],
  );
  expect(result.wallets).toEqual(
    [1, 2].map((n) => ({ ...defaults, address: address(n) })),
  );
  expect(result).toMatchObject({
    total: 2,
    skipped: 0,
    format: 'Address list',
  });
});
it('maps JSON names/icons/bookmarks explicitly, preserving an explicit false bookmark', () => {
  const result = reviewTrackerImport(
    JSON.stringify([
      { address: address(1), name: 'Whale', icon: '🐋', bookmark: true },
      { address: address(2), bookmark: false },
      address(3),
    ]),
    { ...defaults, favorite: true },
    [],
  );
  expect(result.wallets[0]).toEqual({
    ...defaults,
    address: address(1),
    label: 'Whale',
    icon: '🐋',
    favorite: true,
  });
  expect(result.wallets[1].favorite).toBe(false);
  expect(result.wallets[2].label).toBe('Batch');
});
it('skips active and archived existing entries without rewriting or restoring them', () => {
  const existing = [saved(1), saved(2, true)];
  const before = JSON.stringify(existing);
  const result = reviewTrackerImport(
    [1, 2, 3].map(address).join(','),
    defaults,
    existing,
  );
  expect(result).toMatchObject({ total: 3, skipped: 2, archivedSkipped: 1 });
  expect(result.wallets.map((w) => w.address)).toEqual([address(3)]);
  expect(JSON.stringify(existing)).toBe(before);
  expect(reviewTrackerImport(address(1), defaults, existing).wallets).toEqual(
    [],
  );
});
it('enforces capacity including archived rows and refuses the entire batch', () => {
  const existing = Array.from({ length: 99 }, (_, i) => saved(i, true));
  expect(() =>
    reviewTrackerImport(
      [address(100), address(101)].join(','),
      defaults,
      existing,
    ),
  ).toThrow('only 1 remain');
  expect(
    reviewTrackerImport(address(100), defaults, existing).wallets,
  ).toHaveLength(1);
});
it('requires the selected network and normalizes EVM identity before duplicate checks', () => {
  const evm = { ...defaults, network: 'Ethereum' as const };
  const raw = '0x0000000000000000000000000000000000000001';
  expect(reviewTrackerImport(raw, evm, []).wallets[0].network).toBe('Ethereum');
  expect(() => reviewTrackerImport(raw, defaults, [])).toThrow('Row 1');
  expect(() => reviewTrackerImport(`${raw},${raw}`, evm, [])).toThrow(
    'duplicate of row 1',
  );
});
for (const [title, input] of [
  ['empty', '  '],
  ['too many', Array.from({ length: 101 }, (_, i) => address(i)).join(',')],
  ['duplicate', `${address(1)},${address(1)}`],
  ['malformed JSON', '[{'],
  ['wrapped JSON', '{"wallets":[]}'],
  ['wrong row', '[null]'],
  ['array row', '[[]]'],
  [
    'secret field',
    JSON.stringify([
      { address: address(1), privateKey: 'SYNTHETIC_SECRET_MARKER' },
    ]),
  ],
  [
    'wrong bookmark',
    JSON.stringify([{ address: address(1), bookmark: 'true' }]),
  ],
  [
    'unsupported icon',
    JSON.stringify([{ address: address(1), icon: 'unknown' }]),
  ],
  ['bad name', JSON.stringify([{ address: address(1), name: 'bad\nname' }])],
  ['wrong address', JSON.stringify([{ address: 'invalid' }])],
  ['oversized', 'x'.repeat(20001)],
] as const)
  it(`refuses ${title} without echoing raw input or partial import`, () => {
    let error = '';
    try {
      reviewTrackerImport(input, defaults, []);
    } catch (reason) {
      error = (reason as Error).message;
    }
    expect(error).not.toBe('');
    expect(error).not.toContain('SYNTHETIC_SECRET_MARKER');
    expect(error).not.toContain('Unexpected token');
  });
it('accepts exactly 100 entries but refuses an expanded request above the route size limit', () => {
  const text = Array.from({ length: 100 }, (_, i) => address(i)).join(',');
  expect(
    reviewTrackerImport(text, { ...defaults, label: '', group: '' }, [])
      .wallets,
  ).toHaveLength(100);
  expect(() =>
    reviewTrackerImport(
      text,
      { ...defaults, label: 'x'.repeat(60), group: 'x'.repeat(40) },
      [],
    ),
  ).toThrow('request exceeds');
});
