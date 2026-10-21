import { expect, it } from 'vitest';
import { nativeWarmupFixture } from './warmup-native-fixture';
it.each(['Buy', 'Sell'] as const)(
  'preserves default %s packet and raw-account bytes when 1000 units are explicit',
  async (side) => {
    const baseline = await nativeWarmupFixture({ side }),
      explicit = await nativeWarmupFixture({ side, tokenRaw: 1000n });
    expect(explicit.order.preparation.transaction).toBe(
      baseline.order.preparation.transaction,
    );
    expect(explicit.order.preparation.sha256).toBe(
      baseline.order.preparation.sha256,
    );
    expect(explicit.order.inAmount).toBe(baseline.order.inAmount);
    expect(explicit.order.outAmount).toBe(baseline.order.outAmount);
    expect(explicit.order.minimumOutAmount).toBe(
      baseline.order.minimumOutAmount,
    );
    expect(explicit.rawInstructions).toEqual(baseline.rawInstructions);
    expect(explicit.first).toEqual(baseline.first);
    expect(explicit.last).toEqual(baseline.last);
    expect(explicit.message).toEqual(baseline.message);
  },
);
it.each([0n, -1n, 1n << 64n])(
  'rejects a synthetic token amount outside positive u64: %s',
  async (tokenRaw) => {
    await expect(
      nativeWarmupFixture({ side: 'Sell', tokenRaw }),
    ).rejects.toThrow('u64');
  },
);
