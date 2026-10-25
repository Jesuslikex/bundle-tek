import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { newAutoSellStrategy } from './auto-sell';
import {
  autoSellProfileSha256,
  autoSellProfileTermsJson,
  type AutoSellProfileTerms,
  type SavedAutoSellProfile,
} from './auto-sell-profile';
import {
  autoSellRunAmountLimbs,
  autoSellRunLimbsRaw,
  autoSellRunOccurrenceKeys,
  createAutoSellRun,
  readAutoSellRun,
  createAutoSellRunAttempt,
  readAutoSellRunAttempt,
  readAutoSellRunAttemptInput,
  replayAutoSellRun,
  type AutoSellRun,
  type AutoSellRunAttempt,
  type AutoSellRunAttemptInput,
} from './auto-sell-run';
const uuid = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const wallet = '11111111111111111111111111111111',
  mint = 'So11111111111111111111111111111111111111112';
const date = (seconds = 0) =>
  new Date(
    Date.parse('2026-10-25T12:00:00.000Z') + seconds * 1000,
  ).toISOString();
const U64 = (1n << 64n) - 1n;
function terms(): AutoSellProfileTerms {
  const base = {
    ...newAutoSellStrategy(0),
    endMaxSupplyPercent: '',
    endDurationSeconds: 0,
    minSupplyPercentPerSell: '',
    amountUnit: 'tokens' as const,
  };
  return {
    name: 'Retained run',
    projectId: uuid(1),
    projectRevision: 1,
    token: { chain: 'Solana', mint, decimals: 0, totalSupplyRaw: '1000' },
    wallets: [{ address: wallet, revision: 1 }],
    configuration: {
      strategies: [
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
      ],
      session: {
        startDelaySeconds: 0,
        endDurationSeconds: 60,
        endMaxSupplyPercent: '10',
        maxSlippageBps: 50,
      },
    },
  };
}
async function profile(input = terms()): Promise<SavedAutoSellProfile> {
  return {
    format: 'auto-sell-profile-v1',
    id: uuid(2),
    profileId: uuid(3),
    version: 1,
    createdAt: date(),
    sha256: await autoSellProfileSha256(autoSellProfileTermsJson(input)),
    terms: input,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  };
}
async function run(input = terms()) {
  return createAutoSellRun(
    uuid(4),
    await profile(input),
    [{ address: wallet, revision: 1, archived: false }],
    date(),
  );
}
function request(
  root: AutoSellRun,
  change: Partial<AutoSellRunAttemptInput> = {},
): AutoSellRunAttemptInput {
  return {
    id: uuid(5),
    runId: root.id,
    expectedSequence: 0,
    expectedHeadSha256: root.sha256,
    strategyId: 'counter',
    wallet,
    walletRevision: 1,
    inputRaw: '10',
    occurrence: {
      kind: 'counter',
      sourceIds: ['trade-one'],
      bufferedRaw: '10',
    },
    consent: 'reserve-auto-sell-attempt-v1',
    ...change,
  };
}
async function attempt(
  root: AutoSellRun,
  change: Partial<AutoSellRunAttemptInput> = {},
  history: AutoSellRunAttempt[] = [],
  at = date(),
) {
  return createAutoSellRunAttempt(
    root,
    history,
    request(root, change),
    uuid(100 + history.length),
    at,
  );
}
function rehash<T extends { sha256: string }>(value: T, domain: string): T {
  const { sha256: ignored, ...body } = structuredClone(value);
  void ignored;
  return {
    ...body,
    sha256: createHash('sha256')
      .update(JSON.stringify([domain, body]))
      .digest('hex'),
  } as T;
}

it.each([
  '0',
  '1',
  '999999999',
  '1000000000',
  '9007199254740993',
  '9223372036854775808',
  U64.toString(),
  (U64 * 1000n).toString(),
])('round trips exact base1e9 accounting limbs %s', (value) => {
  expect(autoSellRunLimbsRaw(autoSellRunAmountLimbs(value))).toBe(value);
});
it.each(['-1', '01', '1.0', '1e3', '', (U64 * 1000n + 1n).toString()])(
  'refuses noncanonical or overflowing cumulative amount %s',
  (value) => {
    expect(() => autoSellRunAmountLimbs(value)).toThrow();
  },
);
it.each([
  { high: -1, middle: 0, low: 0 },
  { high: 0, middle: 1e9, low: 0 },
  { high: 0, middle: 0, low: 0.5 },
  { high: 0, middle: 0, low: -0 },
  { high: 0, middle: 0, low: 0, extra: 1 },
])('refuses malformed limb tuple %#', (value) => {
  expect(() => autoSellRunLimbsRaw(value)).toThrow();
});
it('retains original clocks, derived caps, full owned exclusions and false authority', async () => {
  const input = terms();
  input.configuration.session.startDelaySeconds = 5;
  input.configuration.strategies[0].endDurationSeconds = 20;
  input.configuration.strategies[0].endMaxSupplyPercent = '2';
  const root = await createAutoSellRun(
    uuid(4),
    await profile(input),
    [
      { address: mint, revision: 3, archived: true },
      { address: wallet, revision: 1, archived: false },
    ],
    date(),
  );
  expect(root).toMatchObject({
    activeAt: date(5),
    endsAt: date(65),
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
    limits: {
      sessionRaw: '100',
      strategies: [
        { id: 'counter', capRaw: '20', endsAt: date(25) },
        { id: 'dca', capRaw: null },
        { id: 'limit', capRaw: null },
      ],
    },
  });
  expect(await readAutoSellRun(root)).toEqual(root);
  expect(root.ownWallets).toHaveLength(2);
});
it.each([
  'signingAllowed',
  'executionAllowed',
  'automaticResumeAllowed',
] as const)('rejects true %s on a self-hashed run', async (field) => {
  const root = await run();
  await expect(
    readAutoSellRun(
      rehash(
        { ...root, [field]: true } as unknown as AutoSellRun,
        'auto-sell-run-v1',
      ),
    ),
  ).rejects.toThrow();
});
it('rejects a hash-consistent forged cap or delayed lifetime', async () => {
  const root = await run();
  const cap = structuredClone(root);
  cap.limits.sessionRaw = '101';
  await expect(
    readAutoSellRun(rehash(cap, 'auto-sell-run-v1')),
  ).rejects.toThrow();
  await expect(
    readAutoSellRun(rehash({ ...root, endsAt: date(999) }, 'auto-sell-run-v1')),
  ).rejects.toThrow();
});
it.each(
  [
    [{ address: wallet, revision: 2, archived: false }],
    [{ address: wallet, revision: 1, archived: true }],
    [],
    [
      { address: wallet, revision: 1, archived: false },
      { address: wallet, revision: 1, archived: false },
    ],
  ].map((roster) => ({ roster })),
)(
  'refuses missing, changed, archived or duplicated selected wallet %#',
  async ({ roster }) => {
    await expect(
      createAutoSellRun(uuid(4), await profile(), roster, date()),
    ).rejects.toThrow();
  },
);
it('detaches the original profile and roster before hashing awaits', async () => {
  const p = await profile(),
    roster = [{ address: wallet, revision: 1, archived: false }];
  const pending = createAutoSellRun(uuid(4), p, roster, date());
  p.terms.name = 'changed later';
  roster[0].archived = true;
  const root = await pending;
  expect(root.profile.terms.name).toBe('Retained run');
  expect(root.ownWallets[0].archived).toBe(false);
});
it('never invokes accessors or serializing methods on untrusted run data', async () => {
  let calls = 0;
  const bad = Object.defineProperty({}, 'format', {
    enumerable: true,
    get() {
      calls++;
      throw Error('getter');
    },
  });
  await expect(readAutoSellRun(bad)).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(
    readAutoSellRun({
      toJSON() {
        calls++;
        return {};
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
it('charges all reserved exposure and exposes no finalized/signed outcome', async () => {
  const root = await run(),
    a = await attempt(root);
  expect(await readAutoSellRunAttempt(a)).toEqual(a);
  const state = await replayAutoSellRun(root, [a]);
  expect(state.accountedRaw).toBe('10');
  expect(state.strategies[0]).toMatchObject({
    accountedRaw: '10',
    claimedKeys: ['counter:trade-one'],
  });
  expect(a.signingAllowed).toBe(false);
  expect(a.executionAllowed).toBe(false);
  expect(a.automaticResumeAllowed).toBe(false);
  expect(Object.hasOwn(a, 'soldRaw')).toBe(false);
});
it('does not permit success/failure/cancellation assertions to release reserved exposure', async () => {
  const root = await run(),
    a = await attempt(root);
  for (const extra of [
    { soldRaw: '0' },
    { failed: true },
    { cancelled: true },
    { finalized: true },
  ])
    await expect(readAutoSellRunAttempt({ ...a, ...extra })).rejects.toThrow();
  expect((await replayAutoSellRun(root, [a])).accountedRaw).toBe('10');
});
it('shares the exact cap across independent strategies and clips only to the reviewed remaining cap', async () => {
  const t = terms();
  t.configuration.session.endMaxSupplyPercent = '1.5';
  const root = await run(t),
    a = await attempt(root);
  const next = {
    id: uuid(6),
    expectedSequence: 1,
    expectedHeadSha256: a.sha256,
    strategyId: 'dca',
    occurrence: { kind: 'dca' as const, index: 0, drawRaw: '10' },
  };
  await expect(
    attempt(root, { ...next, inputRaw: '10' }, [a]),
  ).rejects.toThrow();
  const b = await attempt(root, { ...next, inputRaw: '5' }, [a]);
  expect((await replayAutoSellRun(root, [a, b])).accountedRaw).toBe('15');
  await expect(
    attempt(
      root,
      {
        id: uuid(7),
        expectedSequence: 2,
        expectedHeadSha256: b.sha256,
        occurrence: { kind: 'counter', sourceIds: ['new'], bufferedRaw: '1' },
        inputRaw: '1',
      },
      [a, b],
    ),
  ).rejects.toThrow();
});
it('retains the chosen DCA occurrence and next due time without catch-up or reroll', async () => {
  const root = await run();
  const a = await attempt(
    root,
    { strategyId: 'dca', occurrence: { kind: 'dca', index: 0, drawRaw: '10' } },
    [],
    date(25),
  );
  const next = {
    id: uuid(6),
    expectedSequence: 1,
    expectedHeadSha256: a.sha256,
    strategyId: 'dca',
    occurrence: { kind: 'dca' as const, index: 1, drawRaw: '10' },
  };
  await expect(attempt(root, next, [a], date(34))).rejects.toThrow();
  const b = await attempt(root, next, [a], date(35));
  const state = await replayAutoSellRun(root, [a, b]);
  expect(state.strategies[1]).toMatchObject({
    nextDcaIndex: 2,
    nextDcaAt: date(45),
    accountedRaw: '20',
  });
  await expect(
    attempt(
      root,
      {
        ...next,
        id: uuid(7),
        expectedSequence: 2,
        expectedHeadSha256: b.sha256,
      },
      [a, b],
      date(46),
    ),
  ).rejects.toThrow();
});
it('bounds randomized DCA choices and retains their exact selected raw amount', async () => {
  const t = terms(),
    s = t.configuration.strategies[1];
  s.dcaRandomized = true;
  s.dcaMinAmount = '3';
  s.dcaMaxAmount = '9';
  const root = await run(t);
  for (const draw of ['2', '10'])
    await expect(
      attempt(root, {
        strategyId: 'dca',
        inputRaw: draw,
        occurrence: { kind: 'dca', index: 0, drawRaw: draw },
      }),
    ).rejects.toThrow();
  const a = await attempt(root, {
    strategyId: 'dca',
    inputRaw: '7',
    occurrence: { kind: 'dca', index: 0, drawRaw: '7' },
  });
  expect(a.occurrence).toEqual({ kind: 'dca', index: 0, drawRaw: '7' });
});
it('claims limit rows once independently of whether their transaction has settled', async () => {
  const root = await run(),
    a = await attempt(root, {
      strategyId: 'limit',
      inputRaw: '3',
      occurrence: { kind: 'limit', ids: ['one'] },
    });
  await expect(
    attempt(
      root,
      {
        id: uuid(6),
        expectedSequence: 1,
        expectedHeadSha256: a.sha256,
        strategyId: 'limit',
        inputRaw: '3',
        occurrence: { kind: 'limit', ids: ['one'] },
      },
      [a],
    ),
  ).rejects.toThrow();
  const b = await attempt(
    root,
    {
      id: uuid(6),
      expectedSequence: 1,
      expectedHeadSha256: a.sha256,
      strategyId: 'limit',
      inputRaw: '4',
      occurrence: { kind: 'limit', ids: ['two'] },
    },
    [a],
  );
  expect(
    (await replayAutoSellRun(root, [a, b])).strategies[2].claimedKeys,
  ).toEqual(['limit:one', 'limit:two']);
});
it('counts an entire partial-cap limit claim as consumed without inflating the charged amount', async () => {
  const t = terms();
  t.configuration.strategies[2].endMaxTokenAmount = '5';
  const root = await run(t),
    a = await attempt(root, {
      strategyId: 'limit',
      inputRaw: '5',
      occurrence: { kind: 'limit', ids: ['one', 'two'] },
    });
  const st = (await replayAutoSellRun(root, [a])).strategies[2];
  expect(st.accountedRaw).toBe('5');
  expect(st.claimedKeys).toEqual(['limit:one', 'limit:two']);
});
it.each([
  { strategyId: 'unknown' },
  { wallet: mint },
  { walletRevision: 2 },
  { runId: uuid(99) },
  { expectedSequence: 1 },
  { expectedHeadSha256: 'a'.repeat(64) },
  { inputRaw: '9' },
])('refuses changed request bindings %#', async (change) => {
  const root = await run();
  await expect(attempt(root, change)).rejects.toThrow();
});
it.each([-1, 0.5, 1000, -0])(
  'refuses malformed expected sequence %s',
  async (expectedSequence) => {
    const root = await run();
    expect(() =>
      readAutoSellRunAttemptInput(request(root, { expectedSequence })),
    ).toThrow();
  },
);
it.each(['00', '0', '-1', (U64 + 1n).toString()])(
  'refuses malformed or overflowing input %s',
  async (inputRaw) => {
    const root = await run();
    expect(() =>
      readAutoSellRunAttemptInput(request(root, { inputRaw })),
    ).toThrow();
  },
);
it('does not drop oversized or sparse histories', async () => {
  const root = await run();
  await expect(
    replayAutoSellRun(
      root,
      Array.from({ length: 1001 }, () => ({})),
    ),
  ).rejects.toThrow();
  const sparse: unknown[] = [];
  sparse.length = 1;
  await expect(replayAutoSellRun(root, sparse)).rejects.toThrow();
});
it('rejects reordered, duplicate, reparented and self-hashed semantic corruption', async () => {
  const root = await run(),
    a = await attempt(root);
  const b = await attempt(
    root,
    {
      id: uuid(6),
      expectedSequence: 1,
      expectedHeadSha256: a.sha256,
      occurrence: {
        kind: 'counter',
        sourceIds: ['trade-two'],
        bufferedRaw: '10',
      },
    },
    [a],
  );
  for (const history of [
    [b, a],
    [a, a],
    [a, rehash({ ...b, inputRaw: '11' }, 'auto-sell-run-attempt-v1')],
    [
      a,
      rehash({ ...b, runSha256: 'a'.repeat(64) }, 'auto-sell-run-attempt-v1'),
    ],
    [
      a,
      rehash(
        { ...b, preparationId: a.preparationId },
        'auto-sell-run-attempt-v1',
      ),
    ],
  ])
    await expect(replayAutoSellRun(root, history)).rejects.toThrow();
});
it('keeps exact cumulative exposure above both2^53 and2^64', async () => {
  const t = terms();
  t.token.totalSupplyRaw = U64.toString();
  t.configuration.session.endMaxSupplyPercent = '';
  const root = await run(t);
  const first = await attempt(root, {
    inputRaw: U64.toString(),
    occurrence: {
      kind: 'counter',
      sourceIds: ['one'],
      bufferedRaw: U64.toString(),
    },
  });
  const second = await attempt(
    root,
    {
      id: uuid(6),
      expectedSequence: 1,
      expectedHeadSha256: first.sha256,
      inputRaw: U64.toString(),
      occurrence: {
        kind: 'counter',
        sourceIds: ['two'],
        bufferedRaw: U64.toString(),
      },
    },
    [first],
  );
  const state = await replayAutoSellRun(root, [first, second]);
  expect(state.accountedRaw).toBe((U64 * 2n).toString());
  expect(autoSellRunLimbsRaw(autoSellRunAmountLimbs(state.accountedRaw))).toBe(
    state.accountedRaw,
  );
});
it('preserves a configured pre-cap DCA draw above U64 while reserving only the exact existing cap', async () => {
  const input = terms();
  input.token.totalSupplyRaw = U64.toString();
  input.token.decimals = 20;
  input.configuration.session.endMaxSupplyPercent = '1';
  input.configuration.strategies[1].dcaAmount = '1';
  const root = await run(input);
  const cap = (U64 / 100n).toString();
  const a = await attempt(root, {
    strategyId: 'dca',
    inputRaw: cap,
    occurrence: { kind: 'dca', index: 0, drawRaw: '100000000000000000000' },
  });
  expect((await replayAutoSellRun(root, [a])).accountedRaw).toBe(cap);
});
it.each([
  ['before', -1],
  ['at-end', 60],
])('refuses %s active-window reservations', async (_, seconds) => {
  const root = await run();
  await expect(attempt(root, {}, [], date(Number(seconds)))).rejects.toThrow();
});
it('distinguishes occurrence namespaces without accepting duplicate or empty keys', () => {
  expect(autoSellRunOccurrenceKeys({ kind: 'limit', ids: ['dca:1'] })).toEqual([
    'limit:dca:1',
  ]);
  for (const o of [
    { kind: 'limit', ids: [] },
    { kind: 'counter', sourceIds: ['x', 'x'], bufferedRaw: '1' },
    { kind: 'dca', index: 0, drawRaw: '1', reroll: true },
  ])
    expect(() => autoSellRunOccurrenceKeys(o)).toThrow();
});
