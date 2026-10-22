import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  walletFundingTimes,
  walletFundingProximity as pairs,
  decodeWalletFundingTimes,
  fundingGapLabel,
  walletFundingSelection,
} from './wallet-funding-time';
const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const selection = [1, 2, 3].map((n) => ({ address: address(n), revision: 1 }));
function sample() {
  return walletFundingTimes.parse({
    format: 'wallet-funding-times-v1',
    network: 'mainnet',
    scope: 'most-recently-saved-native-transfer',
    capturedAt: '2026-10-22T00:00:00.000Z',
    executionAllowed: false,
    wallets: selection.map((w, i) => ({
      ...w,
      reason: null,
      funding: {
        signature: bs58.encode(new Uint8Array(64).fill(i + 1)),
        blockTime: 100000 + i * 1474,
        slot: i,
      },
    })),
  });
}
it('shows 24m34s gaps, keeps exactly 30 minutes outside the red threshold and does not invent unknown times', () => {
  const value = sample();
  expect(fundingGapLabel(1474)).toBe('24m 34s');
  expect(pairs(value)).toHaveLength(2);
  value.wallets[1].funding!.blockTime =
    value.wallets[0].funding!.blockTime + 1800;
  expect(
    pairs(value).some((p) => p.a === address(1) && p.b === address(2)),
  ).toBe(false);
  value.wallets[1] = {
    ...value.wallets[1],
    funding: null,
    reason: 'unavailable-evidence',
  };
  expect(pairs(value)).toHaveLength(0);
});
it('rejects foreign or reordered context, policy bypass, bad times and excessive selections', () => {
  expect(() =>
    decodeWalletFundingTimes(sample(), [...selection].reverse()),
  ).toThrow();
  expect(() =>
    decodeWalletFundingTimes(
      { ...sample(), executionAllowed: true },
      selection,
    ),
  ).toThrow();
  expect(() =>
    walletFundingTimes.parse({ ...sample(), capturedAt: 'bad' }),
  ).toThrow();
  expect(() =>
    walletFundingSelection.parse({ wallets: [selection[0], selection[0]] }),
  ).toThrow();
  expect(() => pairs(sample(), -1)).toThrow();
  expect(() => fundingGapLabel(NaN)).toThrow();
});
