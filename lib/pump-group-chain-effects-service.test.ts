import { afterEach, expect, it, vi } from 'vitest';
import { readPumpLaunchGroupReview } from './pump-launch-group-review-service';
import { collectPumpGroupChainEffects } from './pump-group-chain-effects';
import { readOwnedPumpGroupChainEffects } from './pump-group-chain-effects-service';
vi.mock('./pump-launch-group-review-service', () => ({
  readPumpLaunchGroupReview: vi.fn(),
}));
vi.mock('./pump-group-chain-effects', () => ({
  collectPumpGroupChainEffects: vi.fn(),
}));
const read = vi.mocked(readPumpLaunchGroupReview),
  collect = vi.mocked(collectPumpGroupChainEffects);
// This unit boundary tests the orchestration only; HTTP/local SQL and complete
// cryptographic/receipt validation are exercised separately without these mocks.
const view = {
  review: { id: 'saved-group' },
  signedEvidence: { packets: [] },
  state: 'signed',
} as unknown as Awaited<ReturnType<typeof readPumpLaunchGroupReview>>;
const result = { reservationsChanged: false } as Awaited<
  ReturnType<typeof collectPumpGroupChainEffects>
>;
const db = {
  prepare: () => {
    throw new Error('Effects wrapper must not issue database writes');
  },
} as unknown as D1Database;
afterEach(() => vi.resetAllMocks());
it('uses only the owner-selected signed group and returns a read without mutating state', async () => {
  read.mockResolvedValue(structuredClone(view));
  collect.mockResolvedValue(result);
  const signal = new AbortController().signal,
    rpc = vi.fn();
  expect(
    await readOwnedPumpGroupChainEffects(
      db,
      'alice',
      'saved-group',
      signal,
      rpc,
    ),
  ).toBe(result);
  expect(read.mock.calls).toEqual([
    [db, 'alice', 'saved-group'],
    [db, 'alice', 'saved-group'],
  ]);
  expect(collect).toHaveBeenCalledWith(
    view.review,
    view.signedEvidence,
    signal,
    rpc,
  );
  expect(rpc).not.toHaveBeenCalled();
});
it('refuses unsigned or unavailable owner history before any provider collection', async () => {
  read.mockResolvedValueOnce({ ...view, signedEvidence: null });
  await expect(
    readOwnedPumpGroupChainEffects(
      db,
      'alice',
      'saved-group',
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('Retain');
  read.mockRejectedValueOnce(new Error('Owned group not found'));
  await expect(
    readOwnedPumpGroupChainEffects(
      db,
      'bob',
      'saved-group',
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('not found');
  expect(collect).not.toHaveBeenCalled();
});
it('discards a result if saved group state changes or ownership disappears during provider reads', async () => {
  collect.mockResolvedValue(result);
  read
    .mockResolvedValueOnce(view)
    .mockResolvedValueOnce({ ...view, state: 'finalized' });
  await expect(
    readOwnedPumpGroupChainEffects(
      db,
      'alice',
      'saved-group',
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('changed');
  read
    .mockResolvedValueOnce(view)
    .mockRejectedValueOnce(new Error('Owned group not found'));
  await expect(
    readOwnedPumpGroupChainEffects(
      db,
      'alice',
      'saved-group',
      new AbortController().signal,
      vi.fn(),
    ),
  ).rejects.toThrow('not found');
});
it('discards a completed provider result when the caller cancels', async () => {
  const controller = new AbortController();
  read.mockResolvedValue(view);
  collect.mockImplementation(async () => {
    controller.abort();
    return result;
  });
  await expect(
    readOwnedPumpGroupChainEffects(
      db,
      'alice',
      'saved-group',
      controller.signal,
      vi.fn(),
    ),
  ).rejects.toThrow();
  expect(read).toHaveBeenCalledOnce();
});
