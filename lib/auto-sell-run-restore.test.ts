import { describe, expect, it } from 'vitest';
import { newAutoSellStrategy } from './auto-sell';
import { AutoSellRunner } from './auto-sell-runner';
import {
  AUTO_SELL_RESTORE_UNAVAILABLE,
  autoSellRunRestore,
  type AutoSellRunRestore,
} from './auto-sell-run-restore';
import type { AutoSellRunProgress } from './auto-sell-run-progress';

const SUPPLY = 1_000_000_000_000_000n;
const OWN = 'Own1111111111111111111111111111111111111111';
const AT = Date.parse('2026-10-28T00:00:00.000Z');

function progress(patch: Partial<AutoSellRunProgress> = {}): AutoSellRunProgress {
  return {
    run: {
      id: 'run-1',
      activeAt: new Date(AT).toISOString(),
      endsAt: null,
    },
    lifecycle: 'open',
    evidence: {
      stop: null,
      head: { sequence: 3, headSha256: 'a'.repeat(64) },
    },
    strategies: [
      {
        id: 'a',
        chargedRaw: '500000000',
        remainingRaw: '500000000',
        endsAt: null,
        nextDcaIndex: 2,
        nextDcaAt: new Date(AT + 60_000).toISOString(),
        consumedKeys: ['limit-1'],
        lifecycle: 'open',
      },
    ],
    unresolvedAttempts: [],
    ...patch,
  } as unknown as AutoSellRunProgress;
}

function runner() {
  return new AutoSellRunner({
    strategies: [
      { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '50' },
      { ...newAutoSellStrategy(1), id: 'b', replicationPercent: '10' },
    ],
    decimals: 6,
    totalSupplyRaw: SUPPLY,
    ownWallets: new Set([OWN]),
    readTrades: async () => [],
    sell: async (amount: bigint) => ({
      soldRaw: amount,
      signature: 'sig',
      wallet: OWN,
    }),
    onUpdate: () => {},
    now: () => AT,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
  });
}

describe('autoSellRunRestore', () => {
  it('carries charged units, the DCA position and consumed limit rows', () => {
    const restore = autoSellRunRestore(progress(), AT);
    const state = restore.states.get('a')!;
    expect(state.soldRaw).toBe(500_000_000n);
    expect(state.nextDcaAt).toBe(AT + 60_000);
    expect(state.filledLimitIds).toEqual(['limit-1']);
    expect(state.status).toBe('running');
    expect(restore.paused).toBe(false);
    expect(restore.unavailable).toEqual(AUTO_SELL_RESTORE_UNAVAILABLE);
  });

  it('treats a future activeAt as paused and a stopped run as stopped', () => {
    const scheduled = autoSellRunRestore(
      progress({
        run: { id: 'r', activeAt: new Date(AT + 600_000).toISOString(), endsAt: null },
      } as never),
      AT,
    );
    expect(scheduled.paused).toBe(true);

    const stopped = autoSellRunRestore(progress({ lifecycle: 'stopped' }), AT);
    expect(stopped.stoppedReason).toBe('Stopped');
    expect(stopped.states.get('a')!.status).toBe('stopped');
  });

  it('ends a strategy whose own allowance or duration ran out', () => {
    const exhausted = autoSellRunRestore(
      progress({
        strategies: [
          {
            id: 'a',
            chargedRaw: '1000000000',
            remainingRaw: '0',
            endsAt: null,
            nextDcaIndex: 0,
            nextDcaAt: null,
            consumedKeys: [],
            lifecycle: 'allowance-exhausted',
          },
        ],
      } as never),
      AT,
    );
    expect(exhausted.states.get('a')!.status).toBe('ended');
    expect(exhausted.states.get('a')!.endedReason).toMatch(/allowance/i);
  });

  it('refuses malformed amounts and timestamps instead of guessing', () => {
    expect(() =>
      autoSellRunRestore(
        progress({
          strategies: [{ ...progress().strategies[0], chargedRaw: '1.5' }],
        } as never),
        AT,
      ),
    ).toThrow(/could not be restored/);
    expect(() =>
      autoSellRunRestore(
        progress({ run: { id: 'r', activeAt: 'nope', endsAt: null } } as never),
        AT,
      ),
    ).toThrow(/could not be restored/);
  });
});

describe('AutoSellRunner restore', () => {
  it('seeds the restored counters and reports what is not durable', () => {
    const r = runner();
    r.start(autoSellRunRestore(progress(), AT));
    const snapshot = r.snapshot();
    expect(snapshot.states.a.soldRaw).toBe(500_000_000n);
    expect(snapshot.states.a.filledLimitIds).toEqual(['limit-1']);
    // An untouched strategy still starts clean.
    expect(snapshot.states.b.soldRaw).toBe(0n);
    expect(snapshot.restored?.unavailable).toEqual(AUTO_SELL_RESTORE_UNAVAILABLE);
    expect(snapshot.log.some((e) => /not durable/.test(e.text))).toBe(true);
  });

  it('restores a stopped run without watching for buys', () => {
    const r = runner();
    const restore: AutoSellRunRestore = autoSellRunRestore(
      progress({ lifecycle: 'stopped' }),
      AT,
    );
    r.start(restore);
    const snapshot = r.snapshot();
    expect(snapshot.running).toBe(false);
    expect(snapshot.states.a.status).toBe('stopped');
  });

  it('still starts clean when no restore is passed', () => {
    const r = runner();
    r.start();
    expect(r.snapshot().restored).toBeNull();
    expect(r.snapshot().states.a.soldRaw).toBe(0n);
  });
});
