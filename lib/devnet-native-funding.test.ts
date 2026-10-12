import { describe, it, expect } from 'vitest';
import { reviewDevnetNativeFunding } from './devnet-native-funding';
const account = {
  owner: '11111111111111111111111111111111',
  executable: false,
  data: ['', 'base64'] as const,
  lamports: 1000000000n,
};
const rows = [
  { address: 'public-recipient', amount: '0.300000001' },
  { address: 'second-recipient', amount: '0.1' },
];
describe('devnet native funding preparation', () => {
  it('budgets exact remaining amounts, one fee allowance per recipient and funder rent reserve', () => {
    expect(
      reviewDevnetNativeFunding(
        rows,
        account.lamports,
        890880n,
        account,
        null,
        [10n, 11n, 12n],
      ),
    ).toBe(400903681n);
    expect(
      reviewDevnetNativeFunding(
        rows.slice(1),
        account.lamports,
        890880n,
        account,
        null,
        [10n],
      ),
    ).toBe(100897280n);
    const balance = 9007199254740993000n;
    expect(
      reviewDevnetNativeFunding(
        rows,
        balance,
        890880n,
        { ...account, lamports: balance },
        null,
        [10n],
      ),
    ).toBe(400903681n);
  });
  it('rejects insufficient budgets and recipients left below rent minimum', () => {
    const balance = 400903680n;
    expect(() =>
      reviewDevnetNativeFunding(
        rows,
        balance,
        890880n,
        { ...account, lamports: balance },
        null,
        [10n],
      ),
    ).toThrow('cannot cover');
    const tiny = [{ address: 'tiny', amount: '0.000000001' }];
    expect(() =>
      reviewDevnetNativeFunding(
        tiny,
        account.lamports,
        890880n,
        account,
        null,
        [10n],
      ),
    ).toThrow('below');
    expect(
      reviewDevnetNativeFunding(
        tiny,
        account.lamports,
        890880n,
        account,
        { ...account, lamports: 890879n },
        [10n],
      ),
    ).toBe(897281n);
  });
  it('rejects program/data accounts, stale snapshots and inconsistent funder balances', () => {
    for (const bad of [
      null,
      { ...account, executable: true },
      { ...account, owner: 'other-program' },
      { ...account, data: ['AA==', 'base64'] as const },
      { ...account, lamports: account.lamports - 1n },
    ])
      expect(() =>
        reviewDevnetNativeFunding(rows, account.lamports, 890880n, bad, null, [
          10n,
        ]),
      ).toThrow('Funder');
    expect(() =>
      reviewDevnetNativeFunding(
        rows,
        account.lamports,
        890880n,
        account,
        { ...account, owner: 'other-program' },
        [10n],
      ),
    ).toThrow('recipient');
    expect(() =>
      reviewDevnetNativeFunding(
        rows,
        account.lamports,
        890880n,
        account,
        null,
        [10n, 161n],
      ),
    ).toThrow('inconsistent');
    expect(() =>
      reviewDevnetNativeFunding(rows, -1n, 890880n, account, null, [10n]),
    ).toThrow('invalid');
  });
});
