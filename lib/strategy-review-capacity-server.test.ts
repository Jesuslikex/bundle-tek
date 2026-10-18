import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { strategyCapacityStorage } from '../test/strategy-capacity-storage';
import {
  strategyInput,
  strategyProject,
  strategyWallet,
} from '../test/strategy-session-fixture';
import {
  saveStrategyDraft,
  archiveStrategyDraft,
} from './strategy-session-drafts';
import {
  readStrategyReviewCapacity,
  changeStrategyReviewCapacity,
} from './strategy-review-capacity-server';
import type { StrategySessionInput } from './strategy-session-plan';
const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  draftId = id(99);
let store: Awaited<ReturnType<typeof strategyCapacityStorage>>,
  input: StrategySessionInput;
const get = () =>
  readStrategyReviewCapacity(store.db, 'owner', strategyProject, draftId);
const change = (
  revision: number,
  event: Parameters<typeof changeStrategyReviewCapacity>[5],
) =>
  changeStrategyReviewCapacity(
    store.db,
    'owner',
    strategyProject,
    draftId,
    revision,
    event,
  );
const hold = (n: number, candidate = 0, strategy = 0) => ({
  kind: 'hold' as const,
  id: id(n),
  strategyId: input.strategies[strategy].id,
  candidate,
});
beforeEach(async () => {
  store = await strategyCapacityStorage();
  input = strategyInput();
  input.startAt = new Date(Date.now() + 1800000).toISOString();
  await saveStrategyDraft(store.db, 'owner', draftId, input);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  store.client.close();
});
it('reads without writes, then persists and recovers exactly once across service calls', async () => {
  expect(await get()).toMatchObject({
    revision: 0,
    summary: { heldRaw: '0' },
    state: { holds: [] },
  });
  expect(
    (
      await store.client.execute(
        'SELECT count(*) n FROM strategy_review_capacity',
      )
    ).rows[0].n,
  ).toBe(0);
  const saved = await change(0, hold(1));
  expect(saved).toMatchObject({
    revision: 1,
    summary: { heldRaw: '5000000', remainingRaw: '25000000' },
    executionAllowed: false,
  });
  expect(await get()).toEqual(saved);
  expect(await change(0, hold(1))).toEqual(saved);
  const released = await change(1, { kind: 'release', id: id(1) });
  expect(released).toMatchObject({ revision: 2, summary: { heldRaw: '0' } });
  expect(await change(0, hold(1))).toEqual(released);
  expect(await change(1, { kind: 'release', id: id(1) })).toEqual(released);
});
it('serializes concurrent writers instead of overwriting another candidate or oversubscribing', async () => {
  const results = await Promise.allSettled([
    change(0, hold(1)),
    change(0, hold(2, 0, 1)),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await get()).state.holds).toHaveLength(1);
  const current = await get();
  const next = current.state.holds[0].id === id(1) ? hold(2, 0, 1) : hold(1);
  expect(await change(current.revision, next)).toMatchObject({
    revision: 2,
    summary: { heldRaw: '15000000' },
  });
});
it('enforces shared limits atomically and frees only explicitly released review capacity', async () => {
  input.maxAmount = '0.01';
  await saveStrategyDraft(store.db, 'owner', id(98), input);
  const run = (r: number, e: Parameters<typeof change>[1]) =>
    changeStrategyReviewCapacity(
      store.db,
      'owner',
      strategyProject,
      id(98),
      r,
      e,
    );
  const first = await run(0, hold(1, 0, 1));
  await expect(run(first.revision, hold(2))).rejects.toThrow(
    'shared input cap',
  );
  const freed = await run(1, { kind: 'release', id: id(1) });
  expect((await run(freed.revision, hold(2))).summary.heldRaw).toBe('5000000');
});
it.each(['project', 'wallet', 'archive'] as const)(
  'refuses new claims after %s changes but preserves history and release',
  async (kind) => {
    await change(0, hold(1));
    if (kind === 'project')
      await store.client.execute(
        'UPDATE imported_token_projects SET revision=2,archived=1',
      );
    if (kind === 'wallet')
      await store.client.execute({
        sql: 'UPDATE workspace_wallets SET revision=2,archived=1 WHERE address=?',
        args: [strategyWallet],
      });
    if (kind === 'archive')
      await archiveStrategyDraft(
        store.db,
        'owner',
        strategyProject,
        draftId,
        1,
        true,
      );
    await expect(change(1, hold(2, 1))).rejects.toThrow(/changed|Archived/);
    expect((await get()).state.holds[0].state).toBe('held');
    expect(
      (await change(1, { kind: 'release', id: id(1) })).summary.heldRaw,
    ).toBe('0');
  },
);
it('rechecks wallet context at the SQL write after hashing', async () => {
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let changed = false;
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(
    async (algorithm, data) => {
      const text = new TextDecoder().decode(data as ArrayBuffer);
      if (!changed && text.includes('strategy-review-capacity-v1')) {
        changed = true;
        await store.client.execute('UPDATE workspace_wallets SET archived=1');
      }
      return original(algorithm, data);
    },
  );
  await expect(change(0, hold(1))).rejects.toThrow('context changed');
  expect((await get()).revision).toBe(0);
});
it('uses the database clock at admission even if the application clock is stale', async () => {
  const actual = Date.now();
  input.startAt = new Date(actual - 120000).toISOString();
  input.durationSeconds = 60;
  await saveStrategyDraft(store.db, 'owner', id(97), input);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(actual - 120000);
  await expect(
    changeStrategyReviewCapacity(
      store.db,
      'owner',
      strategyProject,
      id(97),
      0,
      hold(1),
    ),
  ).rejects.toThrow('context changed');
});
it.each(['project', 'draft'] as const)(
  'rechecks %s context at the exact write after all application reads',
  async (kind) => {
    const prepare = store.db.prepare.bind(store.db);
    let injected = false;
    vi.spyOn(store.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query);
      if (!query.startsWith('INSERT OR IGNORE INTO strategy_review_capacity'))
        return statement;
      return {
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          return {
            run: async () => {
              if (!injected) {
                injected = true;
                await store.client.execute(
                  kind === 'project'
                    ? "UPDATE imported_token_projects SET document=json_set(document,'$.changed',1)"
                    : 'UPDATE strategy_session_drafts SET archived=1,revision=revision+1',
                );
              }
              return bound.run();
            },
          };
        },
      } as unknown as D1PreparedStatement;
    });
    await expect(change(0, hold(1))).rejects.toThrow('context changed');
    expect((await get()).revision).toBe(0);
  },
);
it('persists and releases token input atoms above the signed SQLite integer range exactly', async () => {
  input.side = 'Sell';
  input.maxAmount = '18446744073709.551615';
  const base = input.strategies[1];
  input.strategies = [
    {
      ...base,
      kind: 'Limit',
      amount: input.maxAmount,
      marketCapUsd: '1',
      direction: 'at-or-above',
      maxAmount: null,
    },
  ];
  await saveStrategyDraft(store.db, 'owner', id(96), input);
  const run = (r: number, e: Parameters<typeof change>[1]) =>
    changeStrategyReviewCapacity(
      store.db,
      'owner',
      strategyProject,
      id(96),
      r,
      e,
    );
  const saved = await run(0, hold(1));
  expect(saved.summary).toMatchObject({
    heldRaw: '18446744073709551615',
    remainingRaw: '0',
  });
  expect(
    (await run(1, { kind: 'release', id: id(1) })).summary.remainingRaw,
  ).toBe('18446744073709551615');
});
it('refuses foreign owners and identity reuse for different candidates', async () => {
  await expect(
    readStrategyReviewCapacity(store.db, 'other', strategyProject, draftId),
  ).rejects.toMatchObject({ status: 404 });
  await change(0, hold(1));
  await expect(change(1, hold(1, 1))).rejects.toThrow('differs');
  await expect(change(0, hold(2, 1))).rejects.toThrow('another tab');
});
it('retains SQL history and disabled authority independently of application updates', async () => {
  await change(0, hold(1));
  await expect(
    store.client.execute('DELETE FROM strategy_review_capacity'),
  ).rejects.toThrow('retained');
  await expect(
    store.client.execute(
      "UPDATE strategy_review_capacity SET plan_sha256='different',revision=2",
    ),
  ).rejects.toThrow();
  await expect(
    store.client.execute(
      "UPDATE strategy_review_capacity SET document=json_set(document,'$.executionAllowed',json('true')),revision=2",
    ),
  ).rejects.toThrow();
  await expect(
    store.client.execute(
      "UPDATE strategy_review_capacity SET document=json_set(document,'$.holds[0].unitsRaw','1'),revision=2",
    ),
  ).rejects.toThrow('retained');
  await change(1, { kind: 'release', id: id(1) });
  await expect(
    store.client.execute(
      "UPDATE strategy_review_capacity SET document=json_set(document,'$.holds[0].state','held','$.holds[0].releasedAt',NULL),revision=3",
    ),
  ).rejects.toThrow('retained');
});
