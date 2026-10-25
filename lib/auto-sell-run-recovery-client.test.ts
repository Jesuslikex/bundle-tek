import { beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { swapPreparationSummary } from './imported-swap-preparation-history';
import { autoSellRunSummarySha256 } from './auto-sell-run-packet';
import { PANEL_JSON_RESPONSE_BYTES } from './read-bounded-panel-json';
import {
  readAutoSellRunIndex,
  readAutoSellRunAttemptPage,
  readAutoSellRunPacketRecovery,
  loadAutoSellRunIndex,
  loadAutoSellRunAttempts,
  loadAutoSellRunPacketRecovery,
  type AutoSellRunAttemptSummary,
} from './auto-sell-run-recovery-client';

const uuid = (n: number) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const projectId = uuid(1),
  runId = uuid(2),
  runSha256 = 'a'.repeat(64);
const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
const stamp = '2026-10-25T12:00:00.000Z';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let fixture: Awaited<ReturnType<typeof nativeWarmupFixture>>;
beforeAll(async () => {
  fixture = await nativeWarmupFixture({
    side: 'Sell',
    existing: true,
    v2: true,
  });
});
function attempt(n = 1): AutoSellRunAttemptSummary {
  return {
    id: uuid(100 + n),
    sequence: n,
    attemptSha256: sha('attempt-' + n),
    strategyId: 'strategy-one',
    wallet: fixture.wallet,
    walletRevision: 1,
    inputRaw: '1000',
    preparationId: uuid(2000 + n),
    reservedAt: stamp,
    preparationStarted: true,
  };
}
function context() {
  return { projectId, projectRevision: 3, mint: fixture.mint, decimals: 6 };
}
function index(count = 1) {
  return {
    projectId,
    runs: [
      {
        id: runId,
        createdAt: stamp,
        profileSaveId: uuid(3),
        profileSha256: 'b'.repeat(64),
        runSha256,
        attemptCount: count,
        accountedRaw: String(count * 1000),
        stopped: false,
      },
    ],
    nextCursor: null,
    ...authority,
  };
}
function page(sequence = 1, beforeSequence?: number) {
  const highest = beforeSequence === undefined ? sequence : beforeSequence - 1;
  const attempts = Array.from({ length: Math.min(20, highest) }, (_, i) =>
    attempt(highest - i),
  );
  return {
    runId,
    runSha256,
    context: context(),
    accounting: {
      sequence,
      headSha256: sequence === 0 ? runSha256 : attempt(sequence).attemptSha256,
      accountedRaw: String(sequence * 1000),
    },
    stopped: false,
    attempts,
    nextBeforeSequence: highest > 20 ? attempts.at(-1)!.sequence : null,
    ...authority,
  };
}
function selection() {
  return { runId, runSha256, context: context(), attempt: attempt() };
}
async function recovery() {
  const document = swapPreparationSummary(fixture.order, fixture.simulation, {
    executionAllowed: false,
    wallet: fixture.wallet,
    mint: fixture.mint,
    side: 'Sell',
    requestedRaw: '1000',
    amountCovered: true,
    preparationSupported: true,
    observedAt: new Date().toISOString(),
    source: 'fixture.invalid',
    nativeSlot: 100,
  } as Parameters<typeof swapPreparationSummary>[2]);
  const a = attempt();
  const summary = {
    id: a.preparationId,
    projectId,
    projectRevision: 3,
    walletRevision: 1,
    createdAt: stamp,
    document,
  };
  const body = {
    format: 'auto-sell-run-packet-v1' as const,
    runId,
    attemptId: a.id,
    preparationId: a.preparationId,
    runSha256,
    attemptSha256: a.attemptSha256,
    projectId,
    projectRevision: 3,
    wallet: a.wallet,
    walletRevision: 1,
    packetSha256: document.transaction.sha256,
    summarySha256: await autoSellRunSummarySha256(JSON.stringify(document)),
    transaction: fixture.order.preparation.transaction,
    packetBytes: document.transaction.bytes,
    createdAt: stamp,
    ...authority,
  };
  return {
    format: 'auto-sell-run-packet-recovery-v1' as const,
    status: 'retained' as const,
    runId,
    attemptId: a.id,
    preparationId: a.preparationId,
    summary,
    packet: {
      ...body,
      sha256: sha(JSON.stringify(['auto-sell-run-packet-v1', body])),
    },
    allowanceReleased: false as const,
    ...authority,
  };
}
const response = (value: unknown, status = 200) =>
  Response.json(value, { status });
function fetcher(value: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(response(value));
}
const signal = () => new AbortController().signal;

it('admits exact owned run discovery and complete descending attempt pages', () => {
  expect(readAutoSellRunIndex(index(), { projectId }).runs[0].id).toBe(runId);
  const latest = readAutoSellRunAttemptPage(page(25), {
    projectId,
    runId,
    runSha256,
  });
  expect(latest.attempts).toHaveLength(20);
  expect(latest.nextBeforeSequence).toBe(6);
  const older = readAutoSellRunAttemptPage(page(25, 6), {
    projectId,
    runId,
    runSha256,
    beforeSequence: 6,
  });
  expect(older.attempts.map((a) => a.sequence)).toEqual([5, 4, 3, 2, 1]);
  expect(older.nextBeforeSequence).toBeNull();
});
it('accepts the exact 1000-times-U64 cumulative allowance without numeric rounding', () => {
  const value = index(1000),
    maximum = (((1n << 64n) - 1n) * 1000n).toString();
  value.runs[0].accountedRaw = maximum;
  expect(readAutoSellRunIndex(value, { projectId }).runs[0].accountedRaw).toBe(
    maximum,
  );
});
it.each([
  'foreign-project',
  'true-authority',
  'unknown-key',
  'duplicate-run',
  'wrong-cursor',
  'wrong-order',
  'oversized-page',
] as const)('refuses %s run discovery', (fault) => {
  const value = structuredClone(index()) as unknown as Record<string, unknown>;
  if (fault === 'foreign-project') value.projectId = uuid(900);
  if (fault === 'true-authority') value.executionAllowed = true;
  if (fault === 'unknown-key') value.submissionAllowed = true;
  if (fault === 'duplicate-run')
    value.runs = [index().runs[0], index().runs[0]];
  if (fault === 'wrong-cursor')
    value.nextCursor = { id: uuid(999), createdAt: stamp };
  if (fault === 'wrong-order')
    value.runs = [
      { ...index().runs[0], id: uuid(4) },
      { ...index().runs[0], id: uuid(5) },
    ];
  if (fault === 'oversized-page')
    value.runs = Array.from({ length: 21 }, (_, i) => ({
      ...index().runs[0],
      id: uuid(100 - i),
    }));
  expect(() => readAutoSellRunIndex(value, { projectId })).toThrow(
    'unavailable',
  );
});
it('admits an exact run-index cursor only at the last full-page row', () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({
    ...index().runs[0],
    id: uuid(100 - i),
  }));
  const nextCursor = { id: runs.at(-1)!.id, createdAt: stamp };
  expect(
    readAutoSellRunIndex(
      { ...index(), runs, nextCursor },
      { projectId, before: { id: uuid(101), createdAt: stamp } },
    ).nextCursor,
  ).toEqual(nextCursor);
  expect(() =>
    readAutoSellRunIndex(
      { ...index(), runs, nextCursor },
      { projectId, before: { id: uuid(99), createdAt: stamp } },
    ),
  ).toThrow('unavailable');
});
it.each([
  'foreign-run',
  'foreign-hash',
  'foreign-project',
  'missing-row',
  'duplicate-preparation',
  'wrong-sequence',
  'wrong-next',
  'true-authority',
  'head-mismatch',
] as const)('refuses %s attempt pages', (fault) => {
  const value = page(25) as unknown as Record<string, unknown>;
  if (fault === 'foreign-run') value.runId = uuid(999);
  if (fault === 'foreign-hash') value.runSha256 = 'c'.repeat(64);
  if (fault === 'foreign-project')
    (value.context as { projectId: string }).projectId = uuid(999);
  if (fault === 'missing-row') (value.attempts as unknown[]).pop();
  if (fault === 'duplicate-preparation')
    (value.attempts as AutoSellRunAttemptSummary[])[1].preparationId = (
      value.attempts as AutoSellRunAttemptSummary[]
    )[0].preparationId;
  if (fault === 'wrong-sequence')
    (value.attempts as AutoSellRunAttemptSummary[])[1].sequence = 1;
  if (fault === 'wrong-next') value.nextBeforeSequence = 7;
  if (fault === 'true-authority') value.automaticResumeAllowed = true;
  if (fault === 'head-mismatch')
    (value.accounting as { headSha256: string }).headSha256 = 'e'.repeat(64);
  expect(() =>
    readAutoSellRunAttemptPage(value, { projectId, runId, runSha256 }),
  ).toThrow('unavailable');
});
it('allows forward accounting but refuses lower sequence, lower allowance and reopened Stop', () => {
  const minimumAccounting = {
    sequence: 1,
    accountedRaw: '1000',
    stopped: false,
  };
  expect(
    readAutoSellRunAttemptPage(page(2), {
      projectId,
      runId,
      runSha256,
      minimumAccounting,
    }).accounting.sequence,
  ).toBe(2);
  expect(() =>
    readAutoSellRunAttemptPage(page(1), {
      projectId,
      runId,
      runSha256,
      minimumAccounting: { ...minimumAccounting, sequence: 2 },
    }),
  ).toThrow();
  expect(() =>
    readAutoSellRunAttemptPage(page(2), {
      projectId,
      runId,
      runSha256,
      minimumAccounting: { ...minimumAccounting, accountedRaw: '2001' },
    }),
  ).toThrow();
  expect(() =>
    readAutoSellRunAttemptPage(page(2), {
      projectId,
      runId,
      runSha256,
      minimumAccounting: { ...minimumAccounting, stopped: true },
    }),
  ).toThrow();
});
it('refuses accounting below the visible page or different from a complete small history', () => {
  const partial = page(25);
  partial.accounting.accountedRaw = '19999';
  expect(() =>
    readAutoSellRunAttemptPage(partial, { projectId, runId, runSha256 }),
  ).toThrow();
  const complete = page(2);
  complete.accounting.accountedRaw = '2001';
  expect(() =>
    readAutoSellRunAttemptPage(complete, { projectId, runId, runSha256 }),
  ).toThrow();
});
it('does not invoke record or nested accessors while admitting responses or selections', async () => {
  let calls = 0;
  const value = index();
  Object.defineProperty(value.runs[0], 'runSha256', {
    enumerable: true,
    get() {
      calls++;
      return runSha256;
    },
  });
  expect(() => readAutoSellRunIndex(value, { projectId })).toThrow();
  const expected = { projectId };
  Object.defineProperty(expected, 'projectId', {
    enumerable: true,
    get() {
      calls++;
      return projectId;
    },
  });
  const send = fetcher(index());
  await expect(
    loadAutoSellRunIndex(expected, signal(), send),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  expect(calls).toBe(0);
});
it.each([
  'prototype',
  'sparse',
  'symbol',
  'hidden',
  'invalid-unicode',
] as const)('refuses %s response structures', (fault) => {
  const value = index();
  if (fault === 'prototype') Object.setPrototypeOf(value, { extra: true });
  if (fault === 'sparse') Reflect.deleteProperty(value.runs, '0');
  if (fault === 'symbol')
    Object.defineProperty(value, Symbol('hidden'), {
      value: true,
      enumerable: true,
    });
  if (fault === 'hidden')
    Object.defineProperty(value, 'hidden', { value: true });
  if (fault === 'invalid-unicode') value.runs[0].createdAt = '\ud800';
  expect(() => readAutoSellRunIndex(value, { projectId })).toThrow();
});
it('replays exact actual unsigned packet, summary and record hash bindings', async () => {
  const value = await recovery();
  const admitted = await readAutoSellRunPacketRecovery(value, selection());
  expect(admitted.packet?.transaction).toBe(
    fixture.order.preparation.transaction,
  );
  expect(admitted.packet?.sha256).toBe(value.packet.sha256);
  expect(admitted.executionAllowed).toBe(false);
  expect(admitted.allowanceReleased).toBe(false);
});
it.each([
  'run',
  'run-hash',
  'attempt-hash',
  'attempt',
  'preparation',
  'wallet',
  'input',
  'summary-hash',
  'packet-hash',
  'record-hash',
  'bytes',
  'signature',
  'true-authority',
  'released',
  'unknown',
] as const)('refuses altered %s recovery binding', async (fault) => {
  const value = (await recovery()) as unknown as Record<string, unknown>;
  const packet = value.packet as Record<string, unknown>;
  const summary = value.summary as {
    document: { wallet: string; inAmountRaw: string };
  };
  if (fault === 'run') value.runId = uuid(999);
  if (fault === 'run-hash') packet.runSha256 = 'f'.repeat(64);
  if (fault === 'attempt-hash') packet.attemptSha256 = 'f'.repeat(64);
  if (fault === 'attempt') value.attemptId = uuid(999);
  if (fault === 'preparation') packet.preparationId = uuid(999);
  if (fault === 'wallet')
    summary.document.wallet = '11111111111111111111111111111111';
  if (fault === 'input') summary.document.inAmountRaw = '1001';
  if (fault === 'summary-hash') packet.summarySha256 = 'f'.repeat(64);
  if (fault === 'packet-hash') packet.packetSha256 = 'f'.repeat(64);
  if (fault === 'record-hash') packet.sha256 = 'f'.repeat(64);
  if (fault === 'bytes') packet.packetBytes = 1;
  if (fault === 'signature') packet.transaction = fixture.signed.transaction;
  if (fault === 'true-authority') packet.signingAllowed = true;
  if (fault === 'released') value.allowanceReleased = true;
  if (fault === 'unknown') value.submissionAllowed = false;
  await expect(
    readAutoSellRunPacketRecovery(value, selection()),
  ).rejects.toThrow();
});
it('admits all historical availability states while refusing backward starts or inconsistent material', async () => {
  const value = await recovery();
  await expect(
    readAutoSellRunPacketRecovery(
      { ...value, status: 'summary-only', packet: null },
      selection(),
    ),
  ).resolves.toHaveProperty('status', 'summary-only');
  const notStarted = {
    ...value,
    status: 'not-started',
    summary: null,
    packet: null,
  };
  await expect(
    readAutoSellRunPacketRecovery(notStarted, selection()),
  ).rejects.toThrow();
  const expected = selection();
  expected.attempt.preparationStarted = false;
  await expect(
    readAutoSellRunPacketRecovery(notStarted, expected),
  ).resolves.toHaveProperty('status', 'not-started');
  await expect(
    readAutoSellRunPacketRecovery(value, expected),
  ).resolves.toHaveProperty('status', 'retained');
  await expect(
    readAutoSellRunPacketRecovery(
      { ...notStarted, status: 'started-without-result' },
      expected,
    ),
  ).resolves.toHaveProperty('status', 'started-without-result');
  await expect(
    readAutoSellRunPacketRecovery(
      { ...notStarted, packet: value.packet },
      expected,
    ),
  ).rejects.toThrow();
});
it('detaches response and expected association before asynchronous imports or hashing', async () => {
  const value = await recovery(),
    expected = selection();
  const pending = readAutoSellRunPacketRecovery(value, expected);
  value.packet.transaction = 'PRIVATE changed packet';
  expected.attempt.wallet = '11111111111111111111111111111111';
  await expect(pending).resolves.toHaveProperty(
    'packet.transaction',
    fixture.order.preparation.transaction,
  );
});
it('sends only explicit same-origin GET requests using the approved discriminator and cursor', async () => {
  const sendIndex = fetcher(index());
  expect(sendIndex).not.toHaveBeenCalled();
  await loadAutoSellRunIndex({ projectId }, signal(), sendIndex);
  const url = new URL(
    sendIndex.mock.calls[0][0] as string,
    'https://bundle.test',
  );
  expect([...url.searchParams]).toEqual([
    ['projectId', projectId],
    ['index', '1'],
  ]);
  expect(sendIndex.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
  });
  expect(sendIndex.mock.calls[0][1]?.body).toBeUndefined();
  const sendAttempts = fetcher(page(25, 6));
  await loadAutoSellRunAttempts(
    { projectId, runId, runSha256, beforeSequence: 6 },
    signal(),
    sendAttempts,
  );
  expect(sendAttempts.mock.calls[0][0] as string).toContain(
    'attempts=1&beforeSequence=6',
  );
  const sendRecovery = fetcher(await recovery());
  await loadAutoSellRunPacketRecovery(selection(), signal(), sendRecovery);
  expect(sendRecovery.mock.calls[0][0] as string).toContain(
    'auto-sell-run-recovery?runId=',
  );
  expect(sendRecovery.mock.calls[0][1]?.method).toBe('GET');
});
it.each([200, 202, 302, 401, 403, 404, 409, 429, 503])(
  'sanitizes HTML/error HTTP%i without returning a partial page',
  async (status) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>PRIVATE key and parser text</html>', {
        status,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(
      loadAutoSellRunIndex({ projectId }, signal(), send),
    ).rejects.toThrow('Saved Auto Sell recovery is unavailable');
  },
);
it.each(['invalid-json', 'too-large', 'truncated'] as const)(
  'sanitizes %s successful JSON responses',
  async (fault) => {
    const body =
      fault === 'too-large'
        ? 'x'.repeat(PANEL_JSON_RESPONSE_BYTES + 1)
        : fault === 'truncated'
          ? '{"runs":['
          : 'PRIVATE not JSON';
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, { headers: { 'content-type': 'application/json' } }),
      );
    await expect(
      loadAutoSellRunIndex({ projectId }, signal(), send),
    ).rejects.toThrow('unavailable');
  },
);
it('sanitizes fetch failures and cancellation reasons without any retry or HTTP write', async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockRejectedValue(Error('PRIVATE network detail'));
  await expect(
    loadAutoSellRunIndex({ projectId }, signal(), send),
  ).rejects.toThrow('unavailable');
  expect(send).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort('PRIVATE abort detail');
  const noSend = fetcher(index());
  await expect(
    loadAutoSellRunIndex({ projectId }, controller.signal, noSend),
  ).rejects.toThrow('checking stopped');
  expect(noSend).not.toHaveBeenCalled();
});
it('aborts an uncooperative pending fetch and ignores its later response', async () => {
  let resolve!: (value: Response) => void;
  const send = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const controller = new AbortController();
  const pending = loadAutoSellRunIndex({ projectId }, controller.signal, send);
  controller.abort('PRIVATE reason');
  await expect(pending).rejects.toThrow('checking stopped');
  resolve(response(index()));
  expect(send).toHaveBeenCalledTimes(1);
});
