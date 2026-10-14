import { expect, it } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { reviewExactOutputNativeSettlement } from './warmup-native-settlement';
import type { JupiterExactOutOrder } from './jupiter-exact-out-assessment';
async function fixture(
  options: Parameters<typeof nativeWarmupFixture>[0] = { side: 'Buy' },
) {
  const f = await nativeWarmupFixture(options),
    simulation = structuredClone(f.simulation);
  const route = simulation.instructionReview.instructions.find(
    (i) => i.program.address === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  )!;
  const bytes = Uint8Array.from(route.dataHex.match(/../g)!, (b) =>
      parseInt(b, 16),
    ),
    view = new DataView(bytes.buffer);
  bytes.set([176, 209, 105, 168, 154, 125, 69, 62]);
  view.setBigUint64(bytes.length - 19, 1000n, true);
  view.setBigUint64(bytes.length - 11, 1000000n, true);
  route.dataHex = Array.from(bytes, (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const order: JupiterExactOutOrder & {
    accountCount: number;
    lookupTableCount: number;
  } = {
    swapMode: 'ExactOut',
    wallet: f.wallet,
    inputMint: f.order.inputMint,
    outputMint: f.order.outputMint,
    quotedInputRaw: '1000000',
    outputTargetRaw: '1000',
    maximumInputRaw: '1005000',
    reviewedInputBudgetRaw: '1005000',
    slippageBps: 50,
    accountCount: f.order.preparation.accountCount,
    lookupTableCount: f.order.preparation.lookupTableCount,
  };
  return { ...f, simulation, order };
}
it.each([
  { side: 'Buy' as const },
  { side: 'Buy' as const, seed: true },
  { side: 'Buy' as const, seed: true, seedRentOnly: true },
  { side: 'Buy' as const, seed: true, initializer: 1 as const },
  { side: 'Buy' as const, lookup: true },
])(
  'reviews explicit ExactOut wrapping, rent and gross debits for %j without enabling signing',
  async (options) => {
    const f = await fixture(options);
    expect(
      await reviewExactOutputNativeSettlement(f.order, f.simulation, '6000000'),
    ).toMatchObject({
      executionAllowed: false,
      instructionsVerified: false,
      swapMode: 'ExactOut',
      actualInputRaw: '1000000',
      settlement: {
        wrappedFromNativeRaw: '1000000',
        closesWrappedAccount: true,
      },
    });
  },
);
it('allows improved actual input below the quoted input while bounding it by wrapped funding', async () => {
  const f = await fixture(),
    e = f.simulation.settlementEvidence!;
  e.after[0] = (BigInt(e.after[0]) + 1n).toString();
  f.simulation.nativeChangeRaw = (
    BigInt(e.after[0]) - BigInt(e.before[0])
  ).toString();
  expect(
    await reviewExactOutputNativeSettlement(f.order, f.simulation, '6000000'),
  ).toMatchObject({ actualInputRaw: '999999' });
});
it('rejects insufficient gross funds even when the wallet can cover the smaller net debit after rent refunds', async () => {
  const f = await fixture(),
    e = f.simulation.settlementEvidence!,
    net = BigInt(e.before[0]) - BigInt(e.after[0]);
  e.before[0] = '4000000';
  e.after[0] = (4000000n - net).toString();
  await expect(
    reviewExactOutputNativeSettlement(f.order, f.simulation, '6000000'),
  ).rejects.toThrow('sufficient SOL');
});
it('rejects a fee/rent allowance that ignores temporary wrapping-account rent', async () => {
  const f = await fixture();
  await expect(
    reviewExactOutputNativeSettlement(f.order, f.simulation, '4083559'),
  ).rejects.toThrow('sufficient SOL');
});
it('rejects unrequested transfers and excessive gross wrapping amounts despite safe-looking net balances', async () => {
  for (const change of ['destination', 'amount']) {
    const f = await fixture(),
      transfer = f.simulation.instructionReview.instructions.find(
        (i) => i.action === 'Native SOL transfer',
      )!;
    if (change === 'destination')
      transfer.accounts[1].address =
        f.simulation.accountBindings.accounts[1].address;
    else {
      const bytes = Uint8Array.from(transfer.dataHex.match(/../g)!, (b) =>
        parseInt(b, 16),
      );
      new DataView(bytes.buffer).setBigUint64(4, 1005001n, true);
      transfer.dataHex = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    }
    await expect(
      reviewExactOutputNativeSettlement(f.order, f.simulation, '6000000'),
    ).rejects.toThrow();
  }
});
it('rejects output substitutes, ExactIn bytes, unexpected compute prices and missing cleanup', async () => {
  const f = await fixture();
  await expect(
    reviewExactOutputNativeSettlement(
      { ...f.order, outputTargetRaw: '999' },
      f.simulation,
      '6000000',
    ),
  ).rejects.toThrow();
  const original = await nativeWarmupFixture({ side: 'Buy' });
  await expect(
    reviewExactOutputNativeSettlement(f.order, original.simulation, '6000000'),
  ).rejects.toThrow('matching declared route');
  const compute = structuredClone(
    f.simulation.instructionReview.instructions[0],
  );
  compute.program = {
    ...compute.program,
    address: 'ComputeBudget111111111111111111111111111111',
    signer: false,
    writable: false,
  };
  compute.accounts = [];
  compute.dataHex = '030100000000000000';
  f.simulation.instructionReview.instructions.unshift(compute);
  await expect(
    reviewExactOutputNativeSettlement(f.order, f.simulation, '6000000'),
  ).rejects.toThrow('priority fee');
  const kept = await fixture({ side: 'Buy', keepWrapped: true });
  await expect(
    reviewExactOutputNativeSettlement(kept.order, kept.simulation, '6000000'),
  ).rejects.toThrow('cleanup');
});
