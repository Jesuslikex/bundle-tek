import { afterEach, expect, it, vi } from 'vitest';
import { tradeAmountPreferenceRequest } from './trade-amount-preferences-client';
import { defaultTradeAmountPresets } from './trade-amount-preferences';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('rejects another account and never retries a preference request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        ownerId: 'bob',
        revision: 0,
        preferences: defaultTradeAmountPresets(),
        updatedAt: null,
      }),
    ),
  );
  await expect(
    tradeAmountPreferenceRequest('alice', new AbortController().signal),
  ).rejects.toThrow(/account/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([401, 200, 503])(
  'sanitizes an invalid response (%s)',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('private provider text', { status })),
    );
    await expect(
      tradeAmountPreferenceRequest('alice', new AbortController().signal),
    ).rejects.toThrow(status === 401 ? 'Sign in' : 'unavailable');
  },
);
it('bounds a stalled save body and reports the unknown outcome without retrying', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    }),
  );
  const pending = expect(
    tradeAmountPreferenceRequest('alice', new AbortController().signal, {
      revision: 1,
      preferences: defaultTradeAmountPresets(),
    }),
  ).rejects.toThrow('save not confirmed');
  await vi.advanceTimersByTimeAsync(15000);
  await pending;
  expect(fetch).toHaveBeenCalledTimes(1);
});
