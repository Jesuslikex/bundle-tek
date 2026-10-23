import { expect, it, vi } from 'vitest';
import { canonicalPumpHolderJson } from './pump-holder-review';
import { walletWarmupSessionDigest } from './wallet-warmup-session-digest';
import {
  auditSavedWarmupExecutionPrefix as audit,
  bindWarmupExecutionAuditEvent as bind,
  warmupExecutionAuditGenesis as genesis,
  WARMUP_EXECUTION_EVENT_BYTES,
  WARMUP_EXECUTION_AUDIT_BYTES,
  WARMUP_EXECUTION_CHECKPOINT_BYTES,
  WarmupExecutionAuditError,
} from './wallet-warmup-execution-audit';
import { executionAuditFixture as fixture } from '../test/warmup-execution-audit-fixture';
import { executionCapacityManifest } from '../test/warmup-execution-capacity-fixture';
import {
  executionNow as t,
  executionHash as hash,
  executionId as id,
  executionSignature,
} from '../test/warmup-execution-ledger-fixture';
const signal = () => new AbortController().signal;
async function replay(
  f: Awaited<ReturnType<typeof fixture>>,
  wires: Iterable<unknown> | AsyncIterable<unknown> = f.wires,
  head?: unknown,
) {
  return audit(
    f.bound.root,
    f.approval,
    f.selector,
    head ?? (await f.head()),
    wires,
    signal(),
  );
}

it('replays exact Buy -> linked Sell without granting receipt or execution authority', async () => {
  const f = await fixture();
  await f.ready();
  await f.settle();
  f.time(t + 32000);
  await f.ready(2);
  await f.settle(2);
  const result = await replay(f);
  expect(result.replayedEvents).toBe(12);
  expect(result.projection.modelTime).toBe(t + 32000);
  expect(result.checkpoint.modelTime).toBe(t + 32000);
  expect(result.projection.snapshot).toEqual(f.ledger.snapshot());
  expect(result.projection.lots).toMatchObject([
    { receiptId: id(50001), bookedRemainingRaw: '0' },
  ]);
  expect(result.projection.outcomes).toMatchObject([
    { disposition: 'applied', side: 'Buy' },
    { disposition: 'applied', side: 'Sell', lotReceiptId: id(50001) },
  ]);
  expect(result).toMatchObject({
    receiptEvidenceVerified: false,
    currentSourceVerified: false,
    currentHeadVerified: false,
    financialReservationVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(result.checkpoint).not.toHaveProperty('lots');
  expect(result.checkpoint).not.toHaveProperty('outcomes');
  expect(result.checkpoint).toMatchObject({
    format: 'wallet-warmup-execution-audit-summary-v1',
    scope: 'audit-summary-not-resumable',
    resumable: false,
  });
  expect(result.checkpoint.snapshot).not.toBe(result.projection.snapshot);
});
it('admits each immutable iterator value once, without coercing a replacement object', async () => {
  const f = await fixture();
  await f.step('reserve');
  let values = 0;
  const coercion = vi.fn(() => 'x'.repeat(1000000));
  const stream = {
    [Symbol.iterator]() {
      let sent = false;
      return {
        next() {
          if (sent) return { done: true as const, value: undefined };
          sent = true;
          return {
            done: false as const,
            get value() {
              return ++values === 1 ? f.wires[0] : { toString: coercion };
            },
          };
        },
      };
    },
  };
  expect((await replay(f, stream)).replayedEvents).toBe(1);
  expect(values).toBe(1);
  expect(coercion).not.toHaveBeenCalled();
});
it('does not alias genesis and recovered summary snapshots to their projections', async () => {
  const f = await fixture();
  for (const result of [f.initial, await replay(f)]) {
    const original = structuredClone(result.projection.snapshot);
    result.checkpoint.snapshot.version = 100;
    expect(result.projection.snapshot).toEqual(original);
  }
});
it('binds historical model time independently of the aggregate snapshot', async () => {
  const f = await fixture();
  const head = await f.head();
  head.checkpointSha256 = await walletWarmupSessionDigest(
    canonicalPumpHolderJson({
      ...f.initial.checkpoint,
      modelTime: f.defaultTime + 1,
    }),
  );
  await expect(replay(f, [], head)).rejects.toBeInstanceOf(
    WarmupExecutionAuditError,
  );
});
it('refuses saved audit heads created before approval or at original expiry', async () => {
  const f = await fixture();
  for (const createdAt of [
    new Date(t).toISOString(),
    f.bound.manifest.expiresAt,
  ]) {
    await expect(
      replay(f, [], { ...f.initial.head, createdAt }),
    ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
  }
});
it('cancels genesis before publishing its locally computed head', async () => {
  const f = await fixture(),
    controller = new AbortController();
  const reading = genesis(
    f.bound.root,
    f.approval,
    f.selector,
    f.initial.head.createdAt,
    controller.signal,
  );
  controller.abort();
  await expect(reading).rejects.toBe(controller.signal.reason);
});
it('separates the approved outer root hash from the model flat-manifest hash', async () => {
  const f = await fixture();
  expect(f.bound.rootSha256).not.toBe(f.bound.manifestSha256);
  await expect(
    bind({
      format: 'wallet-warmup-execution-event-v1',
      rootId: f.selector.id,
      rootSha256: f.bound.rootSha256,
      manifestSha256: f.bound.manifestSha256,
      sequence: 1,
      previousSha256: f.initial.head.eventSha256,
      event: {
        operation: 'reserve',
        expectedRootSha256: f.bound.rootSha256,
        expectedVersion: 0,
        now: f.defaultTime,
      },
    }),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
});
it.each([
  'missing',
  'extra',
  'reordered',
  'changed',
  'noncanonical',
  'duplicate-key',
])(
  'refuses a %s prefix against the independently pinned head',
  async (kind) => {
    const f = await fixture();
    await f.ready();
    await f.settle();
    const wires = [...f.wires];
    if (kind === 'missing') wires.pop();
    else if (kind === 'extra') wires.push(wires[0]);
    else if (kind === 'reordered') [wires[0], wires[1]] = [wires[1], wires[0]];
    else if (kind === 'changed')
      wires[0] = wires[0].replace('"reserve"', '"stop"');
    else if (kind === 'noncanonical') wires[0] = ' ' + wires[0];
    else
      wires[0] = wires[0].replace(
        '{',
        '{"format":"wallet-warmup-execution-event-v1",',
      );
    await expect(replay(f, wires)).rejects.toBeInstanceOf(
      WarmupExecutionAuditError,
    );
  },
);
it('refuses a valid hash chain with a different cached checkpoint and never trusts a verified marker', async () => {
  const f = await fixture();
  await f.step('reserve');
  await expect(
    replay(f, f.wires, { ...(await f.head()), checkpointSha256: hash(999) }),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
  const row = JSON.parse(f.wires[0]);
  row.verified = true;
  await expect(replay(f, [JSON.stringify(row)])).rejects.toBeInstanceOf(
    WarmupExecutionAuditError,
  );
});
it('refuses self-rehashed events that violate the original state machine', async () => {
  const f = await fixture();
  const event = await bind({
    format: 'wallet-warmup-execution-event-v1',
    rootId: f.selector.id,
    rootSha256: f.bound.rootSha256,
    manifestSha256: f.bound.manifestSha256,
    sequence: 1,
    previousSha256: f.initial.head.eventSha256,
    event: {
      operation: 'authorize',
      expectedRootSha256: f.bound.manifestSha256,
      expectedVersion: 0,
      now: f.defaultTime,
      id: id(100),
      packetSha256: hash(100),
      recheckSha256: hash(101),
    },
  });
  await expect(
    replay(f, [event.wire], {
      ...f.initial.head,
      version: 1,
      eventSha256: event.sha256,
    }),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
});
it('keeps the original 30-second gap measured from actual qualification rather than review creation', async () => {
  const f = await fixture();
  await f.ready();
  await f.settle();
  f.time(t + 30000);
  await f.step('reserve');
  const previous = await f.head(),
    row = await bind({
      format: 'wallet-warmup-execution-event-v1',
      rootId: f.selector.id,
      rootSha256: f.bound.rootSha256,
      manifestSha256: f.bound.manifestSha256,
      sequence: 8,
      previousSha256: previous.eventSha256,
      event: {
        operation: 'qualify',
        expectedRootSha256: f.bound.manifestSha256,
        expectedVersion: 7,
        now: t + 30000,
        evidenceSha256: hash(60002),
      },
    });
  await expect(
    replay(f, [...f.wires, row.wire], {
      ...previous,
      version: 8,
      eventSha256: row.sha256,
    }),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
});
it('admits maximum-sized values for every existing event operation within the per-frame bound', async () => {
  const f = await fixture(),
    u64 = '18446744073709551615',
    packetSha256 = hash(100),
    signedPacketSha256 = hash(101),
    signature = executionSignature(255);
  const fields = [
    ...['reserve', 'cancel-unsigned', 'pause', 'resume', 'stop', 'unknown'].map(
      (operation) => ({ operation }),
    ),
    { operation: 'qualify', evidenceSha256: hash(102) },
    {
      operation: 'prepare',
      qualificationEvidenceSha256: hash(103),
      packetSha256,
      minimumOutputRaw: u64,
    },
    {
      operation: 'authorize',
      id: id(100),
      packetSha256,
      recheckSha256: hash(104),
    },
    {
      operation: 'dispatch-intent',
      id: id(101),
      authorizationId: id(100),
      packetSha256,
      signedPacketSha256,
      signature,
    },
    {
      operation: 'recover-signed',
      packetSha256,
      signedPacketSha256,
      signature,
    },
    {
      operation: 'settle',
      packetSha256,
      signedPacketSha256,
      signature,
      receiptId: id(102),
      sourceSha256: hash(105),
      inputRaw: u64,
      outputRaw: u64,
      networkFeeLamports: u64,
      rentDebitLamports: u64,
      rentRefundLamports: u64,
      landedFailure: false,
    },
  ];
  for (const part of fields) {
    const row = await bind({
      format: 'wallet-warmup-execution-event-v1',
      rootId: f.selector.id,
      rootSha256: f.bound.rootSha256,
      manifestSha256: f.bound.manifestSha256,
      sequence: 76100,
      previousSha256: hash(106),
      event: {
        expectedRootSha256: f.bound.manifestSha256,
        expectedVersion: 76099,
        now: 8640000000000000 - 60000,
        ...part,
      },
    });
    expect(new TextEncoder().encode(row.wire).length).toBeLessThanOrEqual(
      WARMUP_EXECUTION_EVENT_BYTES,
    );
  }
});
it('retains a held positive Buy and exact gross fee exposure above SQLite signed and unsigned integer ranges', async () => {
  const f = await fixture();
  await f.ready();
  await f.settle(1, {
    networkFeeLamports: '18446744073709551615',
    rentDebitLamports: '1',
  });
  const result = await replay(f);
  expect(result.projection.snapshot).toMatchObject({
    phase: 'held',
    completedActions: 0,
    heldAcquisition: { observedRaw: '9' },
    wallets: [{ heldFeeRentLamports: '18446744073709551616' }],
  });
  expect(result.projection.outcomes[0]).toMatchObject({
    disposition: 'held',
    reason: 'fee-rent-overrun',
  });
  expect(result.projection.lots).toHaveLength(0);
});
it('preserves unknown exposure through Pause/Stop rather than releasing or resending', async () => {
  const f = await fixture();
  await f.ready();
  await f.step('unknown');
  await f.step('stop');
  const result = await replay(f);
  expect(result.projection.snapshot).toMatchObject({
    phase: 'recovery-required',
    stopped: true,
    completedActions: 0,
    pending: { state: 'unknown', signed: { signature: expect.any(String) } },
  });
  expect(result.projection.outcomes).toEqual([]);
});
it('does not accept a backdated creation timestamp or event before original approval/root creation', async () => {
  const f = await fixture();
  await expect(
    genesis(
      f.bound.root,
      f.approval,
      f.selector,
      new Date(t).toISOString(),
      signal(),
    ),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
  const row = await bind({
    format: 'wallet-warmup-execution-event-v1',
    rootId: f.selector.id,
    rootSha256: f.bound.rootSha256,
    manifestSha256: f.bound.manifestSha256,
    sequence: 1,
    previousSha256: f.initial.head.eventSha256,
    event: {
      operation: 'reserve',
      expectedRootSha256: f.bound.manifestSha256,
      expectedVersion: 0,
      now: t,
    },
  });
  await expect(
    replay(f, [row.wire], {
      ...f.initial.head,
      version: 1,
      eventSha256: row.sha256,
    }),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
});
it('owns root/head selectors across async work and admits no partial output after stream mutation', async () => {
  const f = await fixture();
  await f.step('reserve');
  const root = structuredClone(f.bound.root),
    head = await f.head(),
    selector = { ...f.selector };
  const reading = audit(root, f.approval, selector, head, f.wires, signal());
  root.terms.intent.wallets[0].maximumBuyLamports = '1';
  head.version = 0;
  selector.ownerId = 'changed';
  expect((await reading).replayedEvents).toBe(1);
});
it('cancels a non-cooperating pending iterator without waiting for it and closes best-effort', async () => {
  const f = await fixture(),
    controller = new AbortController();
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          entered();
          return new Promise<IteratorResult<unknown>>(() => {});
        },
        return: close,
      };
    },
  };
  const reading = audit(
    f.bound.root,
    f.approval,
    f.selector,
    f.initial.head,
    stream,
    controller.signal,
  );
  await pending;
  controller.abort();
  await expect(reading).rejects.toThrow();
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});
it('rejects oversized frames and closes without exposing parser diagnostics or cleanup errors', async () => {
  const f = await fixture();
  await f.step('reserve');
  const stream = {
    [Symbol.iterator]() {
      return {
        next() {
          return {
            done: false as const,
            value: 'x'.repeat(WARMUP_EXECUTION_EVENT_BYTES + 1),
          };
        },
        return() {
          throw Error('private cleanup diagnostics');
        },
      };
    },
  };
  await expect(replay(f, stream)).rejects.toBeInstanceOf(
    WarmupExecutionAuditError,
  );
});
it('does not replace the audit refusal when the iterator cleanup getter throws', async () => {
  const f = await fixture();
  await f.step('reserve');
  const cleanup = vi.fn(() => {
    throw Error('private cleanup getter');
  });
  const stream = {
    [Symbol.iterator]() {
      return {
        next() {
          return { done: false as const, value: 'x' };
        },
        get return() {
          return cleanup();
        },
      };
    },
  };
  await expect(replay(f, stream)).rejects.toBeInstanceOf(
    WarmupExecutionAuditError,
  );
  await Promise.resolve();
  expect(cleanup).toHaveBeenCalledOnce();
});
it('keeps all 4800 original lots while the checkpoint stays bounded independently of history', async () => {
  const f = await fixture(executionCapacityManifest('saved', 'unicode'));
  const result = await replay(f);
  expect(result.projection.lots).toHaveLength(4800);
  expect(
    new TextEncoder().encode(JSON.stringify(result.checkpoint)).length,
  ).toBeLessThan(WARMUP_EXECUTION_CHECKPOINT_BYTES);
  expect(WARMUP_EXECUTION_EVENT_BYTES * 76100).toBeLessThanOrEqual(
    WARMUP_EXECUTION_AUDIT_BYTES,
  );
});
it('audits a complete 4800-action saved-lot prefix without truncation', async () => {
  const f = await fixture(executionCapacityManifest());
  let n = 0;
  for (const action of f.bound.manifest.actions) {
    f.time(Math.max(f.defaultTime, Date.parse(action.scheduledAt)));
    await f.ready(++n);
    await f.settle(n);
  }
  const result = await replay(f);
  expect(result.replayedEvents).toBe(28800);
  expect(result.projection.snapshot).toMatchObject({
    phase: 'complete',
    completedActions: 4800,
    totalActions: 4800,
  });
  expect(result.projection.lots).toHaveLength(4800);
  expect(
    result.projection.lots.every((l) => l.bookedRemainingRaw === '0'),
  ).toBe(true);
}, 120000);
