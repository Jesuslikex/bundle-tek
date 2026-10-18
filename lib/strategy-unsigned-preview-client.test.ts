import { afterEach, expect, it, vi } from 'vitest';
import { strategyPreviewFixture } from '../test/strategy-preview-fixture';
import { checkHoldId } from '../test/strategy-check-fixture';
import {
  readStrategyUnsignedPreview,
  requestStrategyUnsignedPreview,
} from './strategy-unsigned-preview-client';
import { buildStrategyUnsignedPreview } from './strategy-unsigned-preview';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('rebuilds the entire preview and rejects altered identity, authority, amounts, fees, slots and expiry', async () => {
  const f = await strategyPreviewFixture();
  const read = (v: unknown) =>
    readStrategyUnsignedPreview(v, f.draft, f.capacity, checkHoldId, null);
  expect(await read(f.preview)).toEqual(f.preview);
  for (const mutate of [
    (v: typeof f.preview) => (v.executionAllowed = true as false),
    (v: typeof f.preview) => (v.signingAllowed = true as false),
    (v: typeof f.preview) => (v.fundingAllowed = true as false),
    (v: typeof f.preview) =>
      (v.checks.wallet = 'So11111111111111111111111111111111111111112'),
    (v: typeof f.preview) => (v.quote.inputRaw = '1'),
    (v: typeof f.preview) => (v.quote.platformFeeBps = 51),
    (v: typeof f.preview) =>
      (v.quote.outputMint = '11111111111111111111111111111111'),
    (v: typeof f.preview) => (v.simulation.maximumNativeDebitLamports = '0'),
    (v: typeof f.preview) => (v.simulation.slot = 99),
    (v: typeof f.preview) => (v.balance.nativeRaw = '0'),
    (v: typeof f.preview) => (v.expiresAt = '2099-01-01T00:00:00.000Z'),
    (v: typeof f.preview) => (v.sha256 = 'b'.repeat(64)),
  ]) {
    const changed = structuredClone(f.preview);
    mutate(changed);
    await expect(read(changed)).rejects.toThrow();
  }
  await expect(read({ ...f.preview, transaction: 'packet' })).rejects.toThrow();
  for (const field of ['quote', 'balance', 'simulation'] as const) {
    await expect(
      read({ ...f.preview, [field]: null }),
    ).rejects.not.toBeInstanceOf(TypeError);
  }
});
it('clips expiry to the earliest quote/check deadline and refuses stale or insufficient evidence', async () => {
  const f = await strategyPreviewFixture();
  const at = new Date(Date.parse(f.at) + 25000).toISOString();
  const value = await buildStrategyUnsignedPreview(
    f.preview.checks,
    null,
    f.evidence,
    at,
    f.at,
  );
  expect(value.expiresAt).toBe(f.evidence.quote.expiresAt);
  await expect(
    buildStrategyUnsignedPreview(
      f.preview.checks,
      null,
      f.evidence,
      new Date(Date.parse(f.at) + 30000).toISOString(),
      f.at,
    ),
  ).rejects.toThrow();
  const e = structuredClone(f.evidence);
  e.simulation.maximumNativeDebitLamports = f.preview.checks.unitsRaw;
  await expect(
    buildStrategyUnsignedPreview(f.preview.checks, null, e, f.at),
  ).rejects.toThrow();
});
it.each([401, 502, 200])(
  'sanitizes non-JSON and signed-out preview responses (%s)',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('private provider body', { status })),
    );
    await expect(
      requestStrategyUnsignedPreview({}, new AbortController().signal),
    ).rejects.toThrow(status === 401 ? 'Sign in' : 'unavailable');
  },
);
it('bounds an ignored cancellation or stalled response body and never retries', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => new Promise(() => {}),
    }),
  );
  const result = expect(
    requestStrategyUnsignedPreview({}, new AbortController().signal),
  ).rejects.toThrow('No review slots changed');
  await vi.advanceTimersByTimeAsync(30000);
  await result;
  expect(fetch).toHaveBeenCalledTimes(1);
});
