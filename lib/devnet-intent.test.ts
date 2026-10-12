import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVNET_GENESIS_HASH,
  DevnetIntentScope,
  isCurrentPreflight,
  requireDevnet,
} from './devnet-intent';

afterEach(() => vi.useRealTimers());

describe('devnet approval boundary', () => {
  it('checks network identity afresh for every approval', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(DEVNET_GENESIS_HASH)
      .mockResolvedValueOnce('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    const rpc = { getGenesisHash: () => ({ send }) };
    await requireDevnet(rpc);
    await expect(requireDevnet(rpc)).rejects.toThrow('not Solana devnet');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails closed when identity is unavailable or malformed', async () => {
    await expect(
      requireDevnet({ getGenesisHash: () => ({ send: async () => null }) }),
    ).rejects.toThrow('blocked');
    await expect(
      requireDevnet({
        getGenesisHash: () => ({
          send: async () => {
            throw new Error('offline');
          },
        }),
      }),
    ).rejects.toThrow('offline');
  });

  it('bounds the check even when a provider ignores cancellation', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const operation = requireDevnet({
      getGenesisHash: () => ({
        send: (options) => {
          signal = options?.abortSignal;
          return new Promise(() => {});
        },
      }),
    });
    const rejection = expect(operation).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects stale, expired and unbounded prepared actions', () => {
    const prepared = {
      identity: 'wallet:mint:manifest',
      expiresAt: 61_000,
      revision: 2,
    };
    expect(isCurrentPreflight(prepared, prepared.identity, 2, 1_000)).toBe(
      true,
    );
    expect(
      isCurrentPreflight(prepared, 'other-wallet:mint:manifest', 2, 1_000),
    ).toBe(false);
    expect(isCurrentPreflight(prepared, prepared.identity, 2, 61_000)).toBe(
      false,
    );
    // Returning to the same inputs cannot revive an older review.
    expect(isCurrentPreflight(prepared, prepared.identity, 4, 1_000)).toBe(
      false,
    );
    expect(
      isCurrentPreflight(
        { ...prepared, expiresAt: Infinity },
        prepared.identity,
        2,
        1_000,
      ),
    ).toBe(false);
    expect(isCurrentPreflight(prepared, prepared.identity, 2, 0)).toBe(false);
  });

  it('invalidates pending provider results after an input change or unmount', () => {
    const scope = new DevnetIntentScope();
    const captured = scope.capture();
    scope.assertCurrent(captured);
    scope.invalidate();
    expect(scope.isCurrent(captured)).toBe(false);
    expect(() => scope.assertCurrent(captured)).toThrow('changed');
    scope.assertCurrent(scope.capture());
  });
});
