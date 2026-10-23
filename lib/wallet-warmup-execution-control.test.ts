import { expect, it, vi } from 'vitest';
import { executionAuditFixture } from '../test/warmup-execution-audit-fixture';
import { executionHash } from '../test/warmup-execution-ledger-fixture';
import {
  deriveWarmupExecutionControlAppend as derive,
  auditSavedWarmupExecutionPrefix as audit,
  WARMUP_EXECUTION_EVENT_BYTES,
  warmupExecutionAuditGenesis,
} from './wallet-warmup-execution-audit';

type Fixture = Awaited<ReturnType<typeof executionAuditFixture>>;
type Control = { operation: 'pause' | 'resume' | 'stop'; now: number };
const signal = () => new AbortController().signal;
const flags = {
  receiptEvidenceVerified: false,
  currentSourceVerified: false,
  currentHeadVerified: false,
  financialReservationVerified: false,
  signingAllowed: false,
  executionAllowed: false,
  automaticExecutionAllowed: false,
};
async function append(f: Fixture, control: Control) {
  const previous = await f.head(),
    before = f.wires.length;
  const result = await derive(
    f.bound.root,
    f.approval,
    f.selector,
    previous,
    [...f.wires],
    control,
    signal(),
  );
  expect(result.previousHead).toEqual(previous);
  expect(result.replayedEvents).toBe(before);
  expect(result.wireBytes).toBe(
    f.wires.reduce((sum, w) => sum + new TextEncoder().encode(w).byteLength, 0),
  );
  f.time(control.now);
  const independentlyApplied = await f.step(control.operation);
  expect(result.wire).toBe(independentlyApplied.wire);
  expect(result.head).toEqual(await f.head());
  const reaudited = await audit(
    f.bound.root,
    f.approval,
    f.selector,
    result.head,
    [...f.wires],
    signal(),
  );
  expect(result.checkpoint).toEqual(reaudited.checkpoint);
  expect(result.projection).toEqual(reaudited.projection);
  expect(result.projection.snapshot).toEqual(f.ledger.snapshot(control.now));
  expect(result).toMatchObject({
    scope: 'control-append-derivation-only',
    ...flags,
  });
  expect(result.checkpoint).toMatchObject({
    resumable: false,
    scope: 'audit-summary-not-resumable',
  });
  expect(result.projection.snapshot).toMatchObject({
    completedActions: 0,
    totalQualifications: 0,
    pending: null,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  return result;
}
const run = async (
  f: Fixture,
  control: unknown,
  head?: unknown,
  wires?: Iterable<unknown> | AsyncIterable<unknown>,
  s = signal(),
) =>
  derive(
    f.bound.root,
    f.approval,
    f.selector,
    head ?? (await f.head()),
    wires ?? [...f.wires],
    control,
    s,
  );

// Actual root/approval binding, actual genesis, shared real ledger and generic
// audit replay. The retained fixture is synthetic historical model input only;
// it establishes no owned SQL storage, provider, human or financial authority.
it('derives pause, resume and stop exactly as the shared ledger and full generic audit', async () => {
  const f = await executionAuditFixture();
  const paused = await append(f, { operation: 'pause', now: f.defaultTime });
  expect(paused.projection.snapshot.phase).toBe('paused');
  const resumed = await append(f, {
    operation: 'resume',
    now: f.defaultTime + 1,
  });
  expect(resumed.projection.snapshot.phase).toBe('queued');
  const stopped = await append(f, {
    operation: 'stop',
    now: f.defaultTime + 2,
  });
  expect(stopped.projection.snapshot.phase).toBe('stopped');
  expect(stopped.head.version).toBe(3);
  expect(stopped.head.createdAt).toBe(f.initial.head.createdAt);
  expect(stopped.head.rootSha256).toBe(f.bound.rootSha256);
  expect(stopped.head.manifestSha256).toBe(f.bound.manifestSha256);
});
it('permits a late stop without renewing original expiry or creating financial state', async () => {
  const f = await executionAuditFixture(),
    expiry = Date.parse(f.bound.manifest.expiresAt);
  const result = await append(f, { operation: 'stop', now: expiry + 1 });
  expect(result.projection.snapshot.phase).toBe('stopped');
  expect(result.projection.snapshot.expiresAt).toBe(f.bound.manifest.expiresAt);
  expect(result.checkpoint.modelTime).toBe(expiry + 1);
});
it.each(['pause', 'resume'] as const)(
  'refuses %s at the original exclusive expiry',
  async (operation) => {
    const f = await executionAuditFixture();
    if (operation === 'resume')
      await append(f, { operation: 'pause', now: f.defaultTime });
    const before = await f.head();
    await expect(
      run(f, { operation, now: Date.parse(f.bound.manifest.expiresAt) }),
    ).rejects.toThrow();
    expect(await f.head()).toEqual(before);
  },
);
it.each([
  'duplicate-pause',
  'resume-while-running',
  'duplicate-stop',
  'pause-after-stop',
  'resume-after-stop',
] as const)('refuses %s with no published successor', async (kind) => {
  const f = await executionAuditFixture();
  if (kind === 'duplicate-pause')
    await append(f, { operation: 'pause', now: f.defaultTime });
  if (kind.includes('stop'))
    await append(f, { operation: 'stop', now: f.defaultTime });
  const operation = kind.startsWith('resume')
    ? 'resume'
    : kind === 'duplicate-stop'
      ? 'stop'
      : 'pause';
  const before = await f.head();
  await expect(run(f, { operation, now: f.defaultTime + 1 })).rejects.toThrow();
  expect(await f.head()).toEqual(before);
});
it('the first control cannot predate the independently retained genesis even when it follows manifest creation', async () => {
  const f = await executionAuditFixture();
  const retainedAt = f.defaultTime + 8000;
  const genesis = await warmupExecutionAuditGenesis(
    f.bound.root,
    f.approval,
    f.selector,
    new Date(retainedAt).toISOString(),
    signal(),
  );
  const earlierThanGenesis = f.defaultTime + 3000;
  expect(earlierThanGenesis).toBeGreaterThan(
    Date.parse(f.bound.manifest.createdAt),
  );
  expect(earlierThanGenesis).toBeLessThan(retainedAt);
  await expect(
    run(f, { operation: 'pause', now: earlierThanGenesis }, genesis.head, []),
  ).rejects.toThrow();
  const equal = await run(
    f,
    { operation: 'pause', now: retainedAt },
    genesis.head,
    [],
  );
  const reaudited = await audit(
    f.bound.root,
    f.approval,
    f.selector,
    equal.head,
    [equal.wire],
    signal(),
  );
  expect(equal.previousHead).toEqual(genesis.head);
  expect(equal.head.createdAt).toBe(new Date(retainedAt).toISOString());
  expect(equal.projection.modelTime).toBe(retainedAt);
  expect(equal.projection.snapshot.phase).toBe('paused');
  expect(equal.projection).toEqual(reaudited.projection);
  expect(equal.checkpoint).toEqual(reaudited.checkpoint);
  expect(equal).toMatchObject(flags);
});

it('refuses a backwards model clock and admits equal-time legal controls', async () => {
  const f = await executionAuditFixture();
  await append(f, { operation: 'pause', now: f.defaultTime + 10 });
  await expect(
    run(f, { operation: 'resume', now: f.defaultTime + 9 }),
  ).rejects.toThrow();
  await append(f, { operation: 'resume', now: f.defaultTime + 10 });
});
it.each([
  'root',
  'owner',
  'root-hash',
  'manifest',
  'head-event',
  'checkpoint',
  'head-version',
  'head-created',
] as const)('refuses independently selected %s mismatch', async (kind) => {
  const f = await executionAuditFixture(),
    head = await f.head(),
    selector = { ...f.selector };
  const root = structuredClone(f.bound.root);
  if (kind === 'root') root.terms.intent.id = crypto.randomUUID();
  if (kind === 'owner') selector.ownerId = 'different-owner';
  if (kind === 'root-hash') head.rootSha256 = executionHash(999);
  if (kind === 'manifest') head.manifestSha256 = executionHash(999);
  if (kind === 'head-event') head.eventSha256 = executionHash(999);
  if (kind === 'checkpoint') head.checkpointSha256 = executionHash(999);
  if (kind === 'head-version') head.version = 1;
  if (kind === 'head-created')
    head.createdAt = new Date(f.defaultTime + 1).toISOString();
  await expect(
    derive(
      root,
      f.approval,
      selector,
      head,
      [],
      { operation: 'pause', now: f.defaultTime + 2 },
      signal(),
    ),
  ).rejects.toThrow();
});
it.each([
  'missing',
  'reordered',
  'extra',
  'changed-wire',
  'oversized',
] as const)(
  'refuses %s prefix rather than advancing from its summary',
  async (kind) => {
    const f = await executionAuditFixture();
    await append(f, { operation: 'pause', now: f.defaultTime });
    await append(f, { operation: 'resume', now: f.defaultTime + 1 });
    const wires = [...f.wires];
    if (kind === 'missing') wires.pop();
    if (kind === 'reordered') wires.reverse();
    if (kind === 'extra') wires.push(wires[0]!);
    if (kind === 'changed-wire')
      wires[0] = wires[0]!.replace('pause', 'resume');
    if (kind === 'oversized')
      wires[0] = ' '.repeat(WARMUP_EXECUTION_EVENT_BYTES + 1);
    await expect(
      run(f, { operation: 'pause', now: f.defaultTime + 2 }, undefined, wires),
    ).rejects.toThrow();
  },
);
it('rejects an otherwise valid generic-audited financial prefix', async () => {
  const f = await executionAuditFixture();
  await f.step('reserve');
  const head = await f.head();
  expect(
    (
      await audit(
        f.bound.root,
        f.approval,
        f.selector,
        head,
        [...f.wires],
        signal(),
      )
    ).projection.snapshot.pending,
  ).not.toBeNull();
  await expect(
    run(f, { operation: 'pause', now: f.defaultTime + 1 }),
  ).rejects.toThrow();
});
it('rejects a self-consistent generic signed-dispatch and settlement history on the control-only path', async () => {
  const f = await executionAuditFixture();
  await f.ready();
  await f.settle();
  const head = await f.head();
  expect(
    (
      await audit(
        f.bound.root,
        f.approval,
        f.selector,
        head,
        [...f.wires],
        signal(),
      )
    ).projection.snapshot.completedActions,
  ).toBe(1);
  await expect(
    run(f, { operation: 'stop', now: f.defaultTime + 1 }),
  ).rejects.toThrow();
});
it.each([
  'reserve',
  'qualify',
  'prepare',
  'authorize',
  'dispatch-intent',
  'recover-signed',
  'settle',
  'unknown',
  'cancel-unsigned',
])('refuses proposed non-control operation %s', async (operation) => {
  const f = await executionAuditFixture();
  await expect(run(f, { operation, now: f.defaultTime })).rejects.toThrow();
});
it.each([
  'expectedVersion',
  'expectedRootSha256',
  'signature',
  'packetSha256',
  'evidenceSha256',
  'executionAllowed',
])('refuses caller-supplied %s in a proposed control', async (key) => {
  const f = await executionAuditFixture();
  await expect(
    run(f, {
      operation: 'pause',
      now: f.defaultTime,
      [key]: key === 'expectedVersion' ? 0 : 'untrusted',
    }),
  ).rejects.toThrow();
});
it.each([NaN, Infinity, -1, 1.5])(
  'refuses invalid proposed clock %s',
  async (now) => {
    const f = await executionAuditFixture();
    await expect(run(f, { operation: 'pause', now })).rejects.toThrow();
  },
);
it('detaches returned previous-head metadata from the independently selected caller head', async () => {
  const f = await executionAuditFixture(),
    head = await f.head(),
    original = structuredClone(head);
  const result = await run(f, { operation: 'pause', now: f.defaultTime }, head);
  result.previousHead.version = 99;
  expect(head).toEqual(original);
  expect(result.head.version).toBe(1);
});
it('an already aborted request cannot consume the prefix or publish a derived control', async () => {
  const f = await executionAuditFixture(),
    controller = new AbortController(),
    next = vi.fn(() => ({ done: true as const, value: undefined }));
  controller.abort(Error('Synthetic caller cancellation'));
  await expect(
    run(
      f,
      { operation: 'pause', now: f.defaultTime },
      undefined,
      { [Symbol.iterator]: () => ({ next }) },
      controller.signal,
    ),
  ).rejects.toThrow('Synthetic caller cancellation');
  expect(next).not.toHaveBeenCalled();
});
it('cancels a pending prefix read and closes the original iterator without a partial successor', async () => {
  const f = await executionAuditFixture(),
    controller = new AbortController();
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const stream = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        started();
        return new Promise<IteratorResult<string>>(() => {});
      },
      return: close,
    }),
  };
  const pending = run(
    f,
    { operation: 'pause', now: f.defaultTime },
    undefined,
    stream,
    controller.signal,
  );
  await waiting;
  controller.abort(Error('Synthetic streaming cancellation'));
  await expect(pending).rejects.toThrow('Synthetic streaming cancellation');
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});
