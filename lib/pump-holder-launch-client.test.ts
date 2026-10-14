import { expect, it } from 'vitest';
import { pumpHolderClientFixture } from '../test/pump-holder-client-fixture';
import {
  holderAmountRaw,
  holderDisplayRaw,
  holderSizing,
  parseHolderLaunch,
} from './pump-holder-launch-client';
it('preserves exact human units, zero decimals and rejects rounding or invalid raw caps', () => {
  expect(holderAmountRaw('1.000000001', 9)).toBe('1000000001');
  expect(holderDisplayRaw('123', 0)).toBe('123');
  expect(holderDisplayRaw('1000000001', 9)).toBe('1.000000001');
  for (const [v, d] of [
    ['1.0000001', 6],
    ['01', 9],
    ['0', 9],
    ['1e2', 9],
    ['18446744073709551616', 0],
  ] as const)
    expect(() => holderAmountRaw(v, d)).toThrow();
});
for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`reconstructs exact complete reviews and zero holder slots (${stock}, token22=${token22})`, async () => {
    const f = await pumpHolderClientFixture(undefined, stock, token22);
    expect(await parseHolderLaunch(f.launch, f.project.id)).toEqual(f.launch);
    const targets = holderSizing(
      f.project,
      f.releaseId,
      f.launch.review.input.create.mint,
      'https://bundle.test',
      f.observation,
    );
    expect(targets.map((r) => r.kind)).toEqual([
      'exact-base-output',
      'exact-base-output',
      'none',
    ]);
    expect(targets.map((r) => r.raw)).toEqual([
      '2000000000000',
      '1000000000000',
      '0',
    ]);
    await expect(parseHolderLaunch(f.launch, 'other')).rejects.toThrow();
    expect(() =>
      holderSizing(
        f.project,
        f.releaseId,
        'wrong',
        'https://bundle.test',
        f.observation,
      ),
    ).toThrow();
  });
it('rejects changed packet context, partial simulation rows and cost-over-cap responses before keys unlock', async () => {
  const f = await pumpHolderClientFixture();
  for (const mutate of [
    (v: typeof f.launch) => {
      v.review.contextSha256 = '0'.repeat(64);
    },
    (v: typeof f.launch) => {
      v.simulation.allWalletSimulation.accounting.wallets.pop();
    },
    (v: typeof f.launch) => {
      v.simulation.allWalletSimulation.accounting.wallets[0].quoteDebitRaw =
        '18446744073709551615';
    },
    (v: typeof f.launch) => {
      v.simulation.allWalletSimulation.sourceBankMatched = false as never;
    },
    (v: typeof f.launch) => {
      v.completeLaunch = true;
    },
  ]) {
    const value = structuredClone(f.launch);
    mutate(value);
    await expect(parseHolderLaunch(value, f.project.id)).rejects.toThrow();
  }
});
it('accepts expired recovery history without claiming success or resolving unknown fees', async () => {
  const f = await pumpHolderClientFixture();
  const value = structuredClone(f.launch);
  value.state = 'cancelled';
  value.receipt = {
    kind: 'expired-unobserved',
    network: 'mainnet',
    commitment: 'finalized',
    packetSha256: value.review.sha256,
    contextSha256: value.review.contextSha256,
    networkFeeUnresolved: true,
    mintAbsent: true,
    finalizedBlockHeight: '1033',
    mintObservedSlot: '2001',
  };
  expect(await parseHolderLaunch(value, f.project.id)).toMatchObject({
    state: 'cancelled',
    completeLaunch: false,
  });
});
