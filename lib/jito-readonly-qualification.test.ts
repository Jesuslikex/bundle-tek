import { expect, it, vi } from 'vitest';
import { jitoSequentialEconomicsFixture } from '../test/jito-sequential-economics-fixture';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { captureJitoSwapSimulation } from './jito-swap-simulation-capture';
import {
  collectJitoReadOnlyQualification,
  collectJitoProviderObservedQualification,
} from './jito-readonly-qualification';
it('rejects omitted or fabricated raw baseline capsules before all provider work', async () => {
  const f = await jitoSequentialEconomicsFixture(),
    fetcher = vi.fn();
  for (const sources of [[], [{}]])
    await expect(
      collectJitoReadOnlyQualification(
        f.manifest,
        sources as never,
        new AbortController().signal,
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('provider-observed runtime also requires genuine owned raw baselines before I/O', async () => {
  const f = await jitoSequentialEconomicsFixture(),
    fetcher = vi.fn();
  for (const sources of [[], [{}]])
    await expect(
      collectJitoProviderObservedQualification(
        f.manifest,
        sources as never,
        new AbortController().signal,
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses a genuine raw capture for another packet instead of substituting a saved summary', async () => {
  const f = await jitoSequentialEconomicsFixture(),
    g = await nativeWarmupFixture(),
    capture = await captureJitoSwapSimulation(
      g.order,
      new AbortController().signal,
      g.fetcher as typeof fetch,
    ),
    fetcher = vi.fn();
  await expect(
    collectJitoReadOnlyQualification(
      f.manifest,
      [capture],
      new AbortController().signal,
      { fetcher: fetcher as typeof fetch },
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
