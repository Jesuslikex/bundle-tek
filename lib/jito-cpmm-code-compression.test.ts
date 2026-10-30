import { expect, it } from 'vitest';
import { zstdCompressSync } from 'node:zlib';
import { decodeJitoCpmmCompressedAccounts } from './jito-cpmm-code-compression';
function fixture(size = 600000) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  const value = {
    context: { slot: '102' },
    value: [
      {
        owner: 'owner',
        executable: false,
        lamports: '18446744073709551615',
        space: String(size),
        data: [
          Buffer.from(zstdCompressSync(bytes)).toString('base64'),
          'base64+zstd',
        ],
      },
    ],
  };
  return { bytes, value };
}
it('preserves every decoded byte and exact metadata without modifying wire observations', () => {
  const f = fixture(),
    before = structuredClone(f.value);
  const result = decodeJitoCpmmCompressedAccounts(f.value, 1, {
    offset: 0,
    length: 600000,
  });
  expect(result).toEqual({
    ...f.value,
    value: [
      { ...f.value.value[0], data: [f.bytes.toString('base64'), 'base64'] },
    ],
  });
  expect(f.value).toEqual(before);
});
it('accepts exact empty slices and absent accounts without supplying missing observations', () => {
  const f = fixture(0);
  expect(
    decodeJitoCpmmCompressedAccounts(f.value, 1, { offset: 0, length: 45 })
      .value,
  ).toEqual([{ ...f.value.value[0], data: ['', 'base64'] }]);
  expect(
    decodeJitoCpmmCompressedAccounts(
      { context: { slot: '102' }, value: [null] },
      1,
      { offset: 0, length: 45 },
    ).value,
  ).toEqual([null]);
});
it('refuses a compressed output bomb within the existing slice and memory caps', () => {
  const f = fixture(4 * 1024 * 1024);
  expect(() =>
    decodeJitoCpmmCompressedAccounts(f.value, 1, { offset: 0, length: 737280 }),
  ).toThrow();
});
it.each([
  'newline',
  'padding',
  'truncated-frame',
  'wrong-magic',
  'trailing-junk',
  'too-long',
  'too-short',
  'wrong-encoding',
  'missing-space',
  'huge-space',
  'wrong-count',
])('refuses %s without returning decoded evidence', (mode) => {
  const f = fixture(500),
    a = f.value.value[0];
  if (mode === 'newline') a.data[0] += '\n';
  if (mode === 'padding') a.data[0] += '=';
  if (mode === 'truncated-frame')
    a.data[0] = Buffer.from(a.data[0], 'base64')
      .subarray(0, 6)
      .toString('base64');
  if (mode === 'wrong-magic') a.data[0] = Buffer.alloc(10).toString('base64');
  if (mode === 'trailing-junk')
    a.data[0] = Buffer.concat([
      Buffer.from(a.data[0], 'base64'),
      Buffer.from([0]),
    ]).toString('base64');
  if (mode === 'too-long') a.space = '499';
  if (mode === 'too-short') a.space = '501';
  if (mode === 'wrong-encoding') a.data[1] = 'base64';
  if (mode === 'missing-space') delete (a as Partial<typeof a>).space;
  if (mode === 'huge-space') a.space = '18446744073709551615';
  expect(() =>
    decodeJitoCpmmCompressedAccounts(f.value, mode === 'wrong-count' ? 2 : 1, {
      offset: 0,
      length: 1000,
    }),
  ).toThrow();
});
it.each([
  { offset: 0, length: 737281 },
  { offset: -1, length: 45 },
  { offset: 10485806, length: 45 },
  { offset: 0, length: 0 },
  { offset: 0, length: 600000 },
])('keeps slice and aggregate output bounds $offset/$length', (slice) => {
  expect(() =>
    decodeJitoCpmmCompressedAccounts(
      { context: { slot: '102' }, value: [null, null] },
      2,
      slice,
    ),
  ).toThrow();
});
