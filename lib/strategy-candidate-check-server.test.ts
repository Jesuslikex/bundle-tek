import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { strategyCheckStorage } from '../test/strategy-check-storage';
import {
  strategyInput,
  strategyProject,
} from '../test/strategy-session-fixture';
import {
  checkDraftId,
  checkHoldId,
  strategyMarketText,
} from '../test/strategy-check-fixture';
import {
  saveStrategyDraft,
  archiveStrategyDraft,
} from './strategy-session-drafts';
import {
  changeStrategyReviewCapacity,
  readStrategyReviewCapacity,
} from './strategy-review-capacity-server';
import { checkStrategyCandidate } from './strategy-candidate-check-server';
let store: Awaited<ReturnType<typeof strategyCheckStorage>>;
const request = {
  projectId: strategyProject,
  draftId: checkDraftId,
  revision: 1,
  holdId: checkHoldId,
};
async function setup(
  kind: 'DCA' | 'Limit' = 'Limit',
  start = Date.now() - 120000,
) {
  const input = strategyInput();
  input.startAt = new Date(start).toISOString();
  await saveStrategyDraft(store.db, 'owner', checkDraftId, input);
  await changeStrategyReviewCapacity(
    store.db,
    'owner',
    strategyProject,
    checkDraftId,
    0,
    {
      kind: 'hold',
      id: checkHoldId,
      strategyId: input.strategies.find((s) => s.kind === kind)!.id,
      candidate: 0,
    },
  );
}
beforeEach(async () => {
  store = await strategyCheckStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  store.client.close();
});
it('checks fresh exact provider caps and leaves durable review capacity untouched', async () => {
  await setup();
  const before = await readStrategyReviewCapacity(
      store.db,
      'owner',
      strategyProject,
      checkDraftId,
    ),
    fetcher = vi
      .fn()
      .mockResolvedValue(new Response(strategyMarketText('100000.000000001')));
  const value = await checkStrategyCandidate(
    store.db,
    'owner',
    request,
    new AbortController().signal,
    fetcher,
  );
  expect(value).toMatchObject({
    status: 'market-observed',
    pools: [{ condition: 'met', marketCapUsd: '100000.000000001' }],
    executionAllowed: false,
  });
  expect(
    await readStrategyReviewCapacity(
      store.db,
      'owner',
      strategyProject,
      checkDraftId,
    ),
  ).toEqual(before);
  await expect(
    checkStrategyCandidate(
      store.db,
      'owner',
      request,
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['DCA', 'scheduled'] as const)(
  'does not call a provider or create a read gate for %s timing checks',
  async (kind) => {
    await setup(
      kind === 'DCA' ? 'DCA' : 'Limit',
      kind === 'scheduled' ? Date.now() + 1800000 : Date.now() - 120000,
    );
    const fetcher = vi.fn();
    const result = await checkStrategyCandidate(
      store.db,
      'owner',
      request,
      new AbortController().signal,
      fetcher,
    );
    expect(result.status).toBe(kind === 'DCA' ? 'dca-due' : 'scheduled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await store.client.execute('SELECT count(*) n FROM market_read_gates'))
        .rows[0].n,
    ).toBe(0);
  },
);
it('uses the database clock for timing even when the application wall clock is wrong', async () => {
  await setup('DCA');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2000-01-01T00:00:00.000Z');
  const result = await checkStrategyCandidate(
    store.db,
    'owner',
    request,
    new AbortController().signal,
    vi.fn(),
  );
  expect(result.status).toBe('dca-due');
  expect(result.checkedAt.startsWith('2026-')).toBe(true);
});
it.each(['wallet', 'project', 'archive', 'release'] as const)(
  'discards a provider read after %s changes during IO',
  async (kind) => {
    await setup();
    const fetcher = vi.fn(async () => {
      if (kind === 'wallet')
        await store.client.execute(
          'UPDATE workspace_wallets SET revision=revision+1',
        );
      if (kind === 'project')
        await store.client.execute(
          "UPDATE imported_token_projects SET document=json_set(document,'$.changed',1)",
        );
      if (kind === 'archive')
        await archiveStrategyDraft(
          store.db,
          'owner',
          strategyProject,
          checkDraftId,
          1,
          true,
        );
      if (kind === 'release')
        await changeStrategyReviewCapacity(
          store.db,
          'owner',
          strategyProject,
          checkDraftId,
          1,
          { kind: 'release', id: checkHoldId },
        );
      return new Response(strategyMarketText('100000'));
    });
    await expect(
      checkStrategyCandidate(
        store.db,
        'owner',
        request,
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toMatchObject({ status: 409 });
  },
);
it('rejects foreign owners or stale capacity before any provider request', async () => {
  await setup();
  const fetcher = vi.fn();
  await expect(
    checkStrategyCandidate(
      store.db,
      'foreign',
      request,
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    checkStrategyCandidate(
      store.db,
      'owner',
      { ...request, revision: 2 },
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(fetcher).not.toHaveBeenCalled();
});
it('bounds ignored transport cancellation and does not publish a late result', async () => {
  await setup();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let begin!: () => void, finish!: (v: Response) => void;
  const started = new Promise<void>((r) => (begin = r));
  const fetcher = vi.fn(() => {
    begin();
    return new Promise<Response>((r) => (finish = r));
  });
  const pending = expect(
    checkStrategyCandidate(
      store.db,
      'owner',
      request,
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toMatchObject({ status: 502 });
  await started;
  await vi.advanceTimersByTimeAsync(8000);
  await pending;
  finish(new Response(strategyMarketText()));
  expect(
    (
      await readStrategyReviewCapacity(
        store.db,
        'owner',
        strategyProject,
        checkDraftId,
      )
    ).revision,
  ).toBe(1);
});
it('bounds a stalled response body independently of transport response', async () => {
  await setup();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let begin!: () => void;
  const started = new Promise<void>((r) => (begin = r));
  const cancel = vi.fn();
  const fetcher = vi.fn(async () => {
    begin();
    return new Response(new ReadableStream({ start() {}, cancel }));
  });
  const pending = expect(
    checkStrategyCandidate(
      store.db,
      'owner',
      request,
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toMatchObject({ status: 502 });
  await started;
  await vi.advanceTimersByTimeAsync(8000);
  await pending;
  expect(cancel).toHaveBeenCalledTimes(1);
});
