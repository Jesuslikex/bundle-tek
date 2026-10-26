import { describe, expect, it, vi } from 'vitest';
import {
  profileTerms,
  savedProfile,
  profileWallet,
} from '@/test/auto-sell-profile-fixture';
import {
  createAutoSellRun,
  createAutoSellRunAttempt,
  type AutoSellRunAttempt,
  type AutoSellRunAttemptInput,
  type AutoSellRun,
} from './auto-sell-run';
import {
  readAutoSellRunProgress as read,
  AUTO_SELL_RUN_PROGRESS_MAX_BYTES,
} from './auto-sell-run-progress';
const id = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const date = (n = 0) =>
  new Date(Date.parse('2026-10-25T12:00:00.000Z') + n * 1000).toISOString();
const flags = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
  allowanceReleased: false,
} as const;
async function root(delay = 0) {
  const terms = profileTerms();
  terms.token.decimals = 0;
  terms.token.totalSupplyRaw = '1000';
  const base = {
    ...terms.configuration.strategies[0],
    endMaxSupplyPercent: '',
    endDurationSeconds: 0,
    minSupplyPercentPerSell: '',
    amountUnit: 'tokens' as const,
  };
  terms.configuration.strategies = [
    { ...base, id: 'counter', mode: 'counter', replicationPercent: '100' },
    {
      ...base,
      id: 'dca',
      mode: 'dca',
      dcaAmount: '10',
      dcaIntervalSeconds: 10,
    },
    {
      ...base,
      id: 'limit',
      mode: 'limit',
      limitOrders: [
        { id: 'one', amount: '3', marketCapUsd: '1000' },
        { id: 'two', amount: '4', marketCapUsd: '2000' },
      ],
    },
  ];
  terms.configuration.session = {
    startDelaySeconds: delay,
    endDurationSeconds: 60,
    endMaxSupplyPercent: '10',
    maxSlippageBps: 50,
  };
  return createAutoSellRun(
    id(1),
    await savedProfile({ terms }),
    [{ address: profileWallet.address, revision: 1, archived: false }],
    date(),
  );
}
async function append(
  run: AutoSellRun,
  prior: AutoSellRunAttempt[] = [],
  change: Partial<AutoSellRunAttemptInput> = {},
  at = date(),
) {
  const n = prior.length;
  return createAutoSellRunAttempt(
    run,
    prior,
    {
      id: id(10 + n),
      runId: run.id,
      expectedSequence: n,
      expectedHeadSha256: prior.at(-1)?.sha256 ?? run.sha256,
      strategyId: 'counter',
      wallet: profileWallet.address,
      walletRevision: 1,
      inputRaw: '10',
      occurrence: {
        kind: 'counter',
        sourceIds: ['trade-' + n],
        bufferedRaw: '10',
      },
      consent: 'reserve-auto-sell-attempt-v1',
      ...change,
    },
    id(100 + n),
    at,
  );
}
function evidence(run: AutoSellRun, attempts: AutoSellRunAttempt[] = []) {
  return {
    format: 'auto-sell-run-progress-evidence-v1',
    run,
    attempts,
    head: {
      sequence: attempts.length,
      headSha256: attempts.at(-1)?.sha256 ?? run.sha256,
    },
    preparationStarts: [] as {
      attemptId: string;
      preparationId: string;
      headSequence: number;
      headSha256: string;
      createdAt: string;
    }[],
    stop: null as null | {
      format: string;
      id: string;
      runId: string;
      runSha256: string;
      createdAt: string;
      signingAllowed: false;
      executionAllowed: false;
      automaticResumeAllowed: false;
    },
    observedAt: date(20),
    ...flags,
  };
}
function start(a: AutoSellRunAttempt, head = a, at = date(1)) {
  return {
    attemptId: a.id,
    preparationId: a.preparationId,
    headSequence: head.sequence,
    headSha256: head.sha256,
    createdAt: at,
  };
}
describe('independent saved Auto Sell progress projection', () => {
  it('retains original clocks and zero reserved exposure without constructing a queue', async () => {
    const run = await root(30);
    const p = await read(evidence(run));
    expect(p.lifecycle).toBe('scheduled');
    expect(p.run.activeAt).toBe(date(30));
    expect(p.run.endsAt).toBe(date(90));
    expect(p.accounting.accountedRaw).toBe('0');
    expect(p.strategies[1].nextDcaAt).toBe(date(30));
    expect(p).toMatchObject({
      ...flags,
      unavailable: {
        historicalQueue: true,
        skippedTriggers: true,
        randomDecisions: true,
        finalizedSales: true,
      },
    });
    expect(p).not.toHaveProperty('soldRaw');
    expect(p).not.toHaveProperty('bufferedRaw');
  });
  it('permanently charges reserved unknowns and records consumed occurrence identities', async () => {
    const run = await root();
    const a = await append(run);
    const p = await read(evidence(run, [a]));
    expect(p.accounting.accountedRaw).toBe('10');
    expect(p.strategies[0]).toMatchObject({
      chargedRaw: '10',
      remainingRaw: '90',
      consumedKeys: ['counter:trade-0'],
    });
    expect(p.unresolvedAttempts).toEqual([
      {
        id: a.id,
        sequence: 1,
        strategyId: 'counter',
        wallet: a.wallet,
        walletRevision: 1,
        inputRaw: '10',
        preparationId: a.preparationId,
        attemptSha256: a.sha256,
        preparationStarted: false,
      },
    ]);
  });
  it('replays DCA cursor and limit identities with no redraw, interval catch-up or resale', async () => {
    const run = await root();
    const d = await append(
      run,
      [],
      {
        strategyId: 'dca',
        occurrence: { kind: 'dca', index: 0, drawRaw: '10' },
      },
      date(5),
    );
    const l = await append(
      run,
      [d],
      {
        strategyId: 'limit',
        inputRaw: '7',
        occurrence: { kind: 'limit', ids: ['one', 'two'] },
      },
      date(6),
    );
    const p = await read(evidence(run, [d, l]));
    expect(p.strategies[1]).toMatchObject({
      nextDcaIndex: 1,
      nextDcaAt: date(15),
      consumedKeys: ['dca:0'],
      chargedRaw: '10',
    });
    expect(p.strategies[2]).toMatchObject({
      consumedKeys: ['limit:one', 'limit:two'],
      chargedRaw: '7',
    });
    expect(p.accounting.accountedRaw).toBe('17');
  });
  it('distinguishes a preparation-start marker from execution or finalized sale proof', async () => {
    const run = await root();
    const a = await append(run);
    const input = evidence(run, [a]);
    input.preparationStarts = [start(a)];
    const p = await read(input);
    expect(p.unresolvedAttempts[0].preparationStarted).toBe(true);
    expect(p.unavailable.finalizedSales).toBe(true);
    expect(p.accounting.accountedRaw).toBe('10');
    expect(p.allowanceReleased).toBe(false);
  });
  it('expires at the original end without changing charged allowance', async () => {
    const run = await root();
    const a = await append(run);
    const input = evidence(run, [a]);
    input.observedAt = date(60);
    const p = await read(input);
    expect(p.lifecycle).toBe('expired');
    expect(p.accounting.accountedRaw).toBe('10');
    expect(p.run.endsAt).toBe(date(60));
  });
  it('accepts exact original Stop while retaining unresolved attempts and allowance', async () => {
    const run = await root();
    const a = await append(run);
    const input = evidence(run, [a]);
    input.preparationStarts = [start(a)];
    input.stop = {
      format: 'auto-sell-run-stop-v1',
      id: id(80),
      runId: run.id,
      runSha256: run.sha256,
      createdAt: date(2),
      signingAllowed: false,
      executionAllowed: false,
      automaticResumeAllowed: false,
    };
    const p = await read(input);
    expect(p.lifecycle).toBe('stopped');
    expect(p.unresolvedAttempts).toHaveLength(1);
    expect(p.accounting.accountedRaw).toBe('10');
  });
  it.each([
    'head-sequence',
    'head-hash',
    'prefix',
    'reorder',
    'duplicate',
    'foreign-run',
    'tamper',
  ])('rejects %s chain corruption', async (kind) => {
    const run = await root();
    const a = await append(run);
    const b = await append(run, [a], {}, date(1));
    const input = evidence(run, [a, b]);
    if (kind === 'head-sequence') input.head.sequence = 1;
    if (kind === 'head-hash') input.head.headSha256 = 'f'.repeat(64);
    if (kind === 'prefix') input.attempts.pop();
    if (kind === 'reorder') input.attempts.reverse();
    if (kind === 'duplicate') input.attempts = [a, a];
    if (kind === 'foreign-run')
      input.run = await createAutoSellRun(
        id(2),
        run.profile,
        run.ownWallets,
        date(),
      );
    if (kind === 'tamper') input.attempts[0].inputRaw = '9';
    await expect(read(input)).rejects.toThrow();
  });
  it.each([
    'foreign-attempt',
    'wrong-preparation',
    'head-hash',
    'before-head',
    'after-observed',
    'duplicate',
    'after-expiry',
  ])('rejects %s preparation evidence', async (kind) => {
    const run = await root();
    const a = await append(run);
    const input = evidence(run, [a]);
    const s = start(a);
    input.preparationStarts = [s];
    if (kind === 'foreign-attempt') s.attemptId = id(90);
    if (kind === 'wrong-preparation') s.preparationId = id(90);
    if (kind === 'head-hash') s.headSha256 = 'f'.repeat(64);
    if (kind === 'before-head') s.createdAt = date(-1);
    if (kind === 'after-observed') s.createdAt = date(21);
    if (kind === 'duplicate') input.preparationStarts.push(s);
    if (kind === 'after-expiry') {
      s.createdAt = date(60);
      input.observedAt = date(61);
    }
    await expect(read(input)).rejects.toThrow();
  });
  it.each([
    'foreign',
    'before-root',
    'after-observed',
    'wrong-hash',
    'authority',
  ])('rejects %s Stop evidence', async (kind) => {
    const run = await root();
    const a = await append(run);
    const input = evidence(run, [a]);
    input.preparationStarts = [start(a)];
    input.stop = {
      format: 'auto-sell-run-stop-v1',
      id: id(80),
      runId: run.id,
      runSha256: run.sha256,
      createdAt: date(2),
      signingAllowed: false,
      executionAllowed: false,
      automaticResumeAllowed: false,
    };
    if (kind === 'foreign') input.stop.runId = id(90);
    if (kind === 'before-root') input.stop.createdAt = date(-1);
    if (kind === 'after-observed') input.stop.createdAt = date(21);
    if (kind === 'wrong-hash') input.stop.runSha256 = 'f'.repeat(64);
    if (kind === 'authority')
      Object.assign(input.stop, { signingAllowed: true });
    await expect(read(input)).rejects.toThrow();
  });
  it('admits a delayed Stop commit whose sampled clock precedes an attempt and preparation start', async () => {
    const run = await root();
    const a = await append(run, [], {}, date(3));
    const input = evidence(run, [a]);
    input.preparationStarts = [start(a, a, date(4))];
    input.stop = {
      format: 'auto-sell-run-stop-v1',
      id: id(80),
      runId: run.id,
      runSha256: run.sha256,
      createdAt: date(2),
      signingAllowed: false,
      executionAllowed: false,
      automaticResumeAllowed: false,
    };
    const p = await read(input);
    expect(p.lifecycle).toBe('stopped');
    expect(p.accounting.accountedRaw).toBe('10');
    expect(p.unresolvedAttempts[0].preparationStarted).toBe(true);
    expect(p).toMatchObject(flags);
    expect(p.unavailable.finalizedSales).toBe(true);
  });
  it.each([
    'accessor',
    'hidden',
    'symbol',
    'prototype',
    'sparse',
    'authority',
    'accounting',
  ])('refuses %s input without trusting browser accounting', async (kind) => {
    const input = evidence(await root());
    const getter = vi.fn(() => date(20));
    if (kind === 'accessor')
      Object.defineProperty(input, 'observedAt', {
        enumerable: true,
        get: getter,
      });
    if (kind === 'hidden')
      Object.defineProperty(input, 'observedAt', {
        enumerable: false,
        value: date(20),
      });
    if (kind === 'symbol')
      Object.defineProperty(input, Symbol('hidden'), { value: true });
    if (kind === 'prototype') Object.setPrototypeOf(input, { invalid: true });
    if (kind === 'sparse') input.attempts = Array(1);
    if (kind === 'authority') Object.assign(input, { allowanceReleased: true });
    if (kind === 'accounting')
      Object.assign(input, { accounting: { accountedRaw: '0' } });
    await expect(read(input)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('bounds complete evidence without truncating or admitting oversized text', async () => {
    const input = evidence(await root());
    Object.assign(input, {
      excess: 'x'.repeat(AUTO_SELL_RUN_PROGRESS_MAX_BYTES),
    });
    await expect(read(input)).rejects.toThrow();
  });
  it('captures caller objects before asynchronous decoding', async () => {
    const input = evidence(await root());
    const pending = read(input);
    input.run.createdAt = date(-100);
    input.head.headSha256 = 'f'.repeat(64);
    const p = await pending;
    expect(p.run.createdAt).toBe(date());
    expect(p.accounting.headSha256).toBe(p.run.sha256);
  });
  it('uses the smaller remaining session or strategy allowance, never signed output', async () => {
    const original = await root();
    const terms = structuredClone(original.profile.terms);
    terms.configuration.strategies[0].endMaxTokenAmount = '15';
    const run = await createAutoSellRun(
      id(1),
      await savedProfile({ terms }),
      original.ownWallets,
      date(),
    );
    const a = await append(run);
    const p = await read(evidence(run, [a]));
    expect(p.strategies[0].remainingRaw).toBe('5');
    expect(p.strategies[1].remainingRaw).toBe('90');
  });
  it('retains null for genuinely uncapped allowance and original independent strategy deadlines', async () => {
    const original = await root();
    const terms = structuredClone(original.profile.terms);
    terms.configuration.session.endMaxSupplyPercent = '';
    terms.configuration.strategies[0].endDurationSeconds = 10;
    const run = await createAutoSellRun(
      id(1),
      await savedProfile({ terms }),
      original.ownWallets,
      date(),
    );
    const p = await read(evidence(run));
    expect(p.lifecycle).toBe('open');
    expect(p.strategies[0].lifecycle).toBe('expired');
    expect(p.strategies[0].endsAt).toBe(date(10));
    expect(p.strategies[1].remainingRaw).toBeNull();
  });
  it('records exhaustion from permanent reservations while finalized sales stay unavailable', async () => {
    const run = await root();
    const a = await append(run, [], {
      inputRaw: '100',
      occurrence: { kind: 'counter', sourceIds: ['large'], bufferedRaw: '100' },
    });
    const p = await read(evidence(run, [a]));
    expect(p.lifecycle).toBe('allowance-exhausted');
    expect(p.strategies.every((s) => s.remainingRaw === '0')).toBe(true);
    expect(p.unavailable.finalizedSales).toBe(true);
    expect(p.allowanceReleased).toBe(false);
  });
  it('refuses a preparation-start history whose head moves backwards', async () => {
    const run = await root();
    const a = await append(run);
    const b = await append(run, [a], {}, date(1));
    const input = evidence(run, [a, b]);
    input.preparationStarts = [start(b, b, date(2)), start(a, a, date(3))];
    await expect(read(input)).rejects.toThrow();
  });
  it('allows an older reserved attempt to start at the actual later immutable head', async () => {
    const run = await root();
    const a = await append(run);
    const b = await append(run, [a], {}, date(1));
    const input = evidence(run, [a, b]);
    input.preparationStarts = [start(a, b, date(2))];
    const p = await read(input);
    expect(p.unresolvedAttempts[0].preparationStarted).toBe(true);
    expect(p.unresolvedAttempts[1].preparationStarted).toBe(false);
  });
  it('accepts storage tie ordering for starts with the same SQL timestamp', async () => {
    const run = await root();
    const a = await append(run);
    const b = await append(run, [a], {}, date(1));
    const input = evidence(run, [a, b]);
    input.preparationStarts = [start(b, b, date(2)), start(a, a, date(2))];
    const p = await read(input);
    expect(p.unresolvedAttempts.every((a) => a.preparationStarted)).toBe(true);
  });
});
