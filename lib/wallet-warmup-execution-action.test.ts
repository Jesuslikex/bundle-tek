import { expect, it } from 'vitest';
import { deriveWarmupExecutionAction as derive } from './wallet-warmup-execution-action';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { WarmupExecutionLedger } from './wallet-warmup-execution-ledger';
import {
  auditSavedWarmupExecutionPrefix,
  deriveWarmupExecutionActionReservation,
} from './wallet-warmup-execution-audit';
import { executionAuditFixture as fixture } from '../test/warmup-execution-audit-fixture';
import {
  executionManifest,
  executionId,
  executionHash,
  executionSignature,
} from '../test/warmup-execution-ledger-fixture';

const signal = () => new AbortController().signal;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function select(
  f: Fixture,
  now = f.defaultTime,
  stream: Iterable<unknown> | AsyncIterable<unknown> = f.wires,
  head?: unknown,
  value: unknown = { now },
) {
  return derive(
    f.bound.root,
    f.approval,
    f.selector,
    head ?? (await f.head()),
    stream,
    value,
    signal(),
  );
}
it('selects the original Buy and independently audits the proposed reservation without provider or signing authority', async () => {
  const f = await fixture();
  const result = await select(f);
  expect(result).toMatchObject({
    format: 'wallet-warmup-execution-action-v1',
    scope: 'next-action-selection-only',
    actionIndex: 0,
    action: f.bound.manifest.actions[0],
    wallet: f.bound.manifest.wallets[0],
    inputRaw: '100',
    lotReceiptId: null,
    lot: null,
    inventoryRequirement: null,
    reservationRecorded: false,
    currentLeaseVerified: false,
    providerReadAllowed: false,
    currentHeadVerified: false,
    currentSourceVerified: false,
    receiptEvidenceVerified: false,
    financialReservationVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(result.readSelection).toEqual({
    wallet: result.wallet.wallet,
    mint: result.action.mint,
    side: 'Buy',
    inputRaw: '100',
    feeAndRentLimitRaw: '10',
    sessionExpiresAt: f.bound.manifest.expiresAt,
  });
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.sha256).toBe(
    await digest(
      canonical({
        format: 'wallet-warmup-execution-action-selection-v1',
        previousHead: result.previousHead,
        proposedHead: result.head,
        actionIndex: result.actionIndex,
        action: result.action,
        wallet: result.wallet,
        inputRaw: result.inputRaw,
        lotReceiptId: result.lotReceiptId,
        lot: result.lot,
        expiresAt: result.expiresAt,
        policy: result.policy,
        nextQualificationAt: result.nextQualificationAt,
        readSelection: result.readSelection,
        inventoryRequirement: result.inventoryRequirement,
      }),
    ),
  );
  expect(result.previousHead).toEqual(f.initial.head);
  expect(result.policy).toEqual(f.bound.manifest.policy);
  expect(JSON.parse(result.wire).event).toMatchObject({
    operation: 'reserve',
    expectedVersion: 0,
    now: f.defaultTime,
  });
  const independently = await auditSavedWarmupExecutionPrefix(
    f.bound.root,
    f.approval,
    f.selector,
    result.head,
    [result.wire],
    signal(),
  );
  expect(result.projection).toEqual(independently.projection);
  expect(result.checkpoint).toEqual(independently.checkpoint);
  expect(f.ledger.snapshot().version).toBe(0);
  expect(f.wires).toHaveLength(0);
  expect(await select(f)).toEqual(result);
  await f.step('reserve');
  expect(result.wire).toBe(f.wires[0]);
  expect(result.head).toEqual(await f.head());
});

it('selects the entire original saved-buy lot and requires fresh inventory rather than treating bookkeeping as evidence', async () => {
  const m = executionManifest(),
    sell = m.actions[1];
  if (sell.side !== 'Sell') throw Error('Expected fixture Sell');
  m.savedLots = [
    {
      receiptId: executionId(900),
      wallet: sell.wallet,
      mint: sell.mint,
      tokenProgram: sell.tokenProgram,
      decimals: sell.decimals,
      remainingRaw: '777',
      sourceSha256: executionHash(901),
    },
  ];
  m.actions = [
    { ...sell, source: { kind: 'saved-buy', receiptId: executionId(900) } },
  ];
  const f = await fixture(m),
    result = await select(f);
  expect(result).toMatchObject({
    actionIndex: 0,
    inputRaw: '777',
    lotReceiptId: executionId(900),
    inventoryRequirement: {
      kind: 'fresh-booked-lot-inventory-required',
      receiptId: executionId(900),
      sourceSha256: executionHash(901),
      buyActionId: null,
      bookedRemainingRaw: '777',
      requestedRaw: '777',
      minimumReceiptSlotRequired: true,
      evidenceVerified: false,
      wallet: sell.wallet,
      mint: sell.mint,
      tokenProgram: sell.tokenProgram,
      decimals: sell.decimals,
    },
  });
  expect(result.readSelection.side).toBe('Sell');
  expect(result.lot).toMatchObject({ receiptId: executionId(900) });
});

it('selects the linked action-buy lot only after complete original model settlement', async () => {
  const f = await fixture();
  await f.ready();
  await f.settle();
  const reserved = await deriveWarmupExecutionActionReservation(
    f.bound.root,
    f.approval,
    f.selector,
    await f.head(),
    f.wires,
    { now: f.defaultTime + 30000 },
    signal(),
  );
  expect(reserved.lot).toMatchObject({
    buyActionId: 'buy',
    bookedRemainingRaw: '9',
    heldRaw: '9',
    reconciliationRequired: false,
  });
  const result = await select(f, f.defaultTime + 30000);
  expect(result).toMatchObject({
    actionIndex: 1,
    inputRaw: '9',
    lotReceiptId: executionId(50001),
    inventoryRequirement: {
      kind: 'fresh-booked-lot-inventory-required',
      receiptId: executionId(50001),
      sourceSha256: executionHash(70001),
      buyActionId: 'buy',
      bookedRemainingRaw: '9',
      requestedRaw: '9',
      evidenceVerified: false,
      wallet: f.bound.manifest.actions[1].wallet,
      mint: f.bound.manifest.actions[1].mint,
      tokenProgram: f.bound.manifest.actions[1].tokenProgram,
      decimals: f.bound.manifest.actions[1].decimals,
    },
  });
  expect(result.replayedEvents).toBe(6);
  expect(result.previousHead).toEqual(await f.head());
  expect(result.receiptEvidenceVerified).toBe(false);
});

it.each(['future', 'expired', 'backwards'] as const)(
  'refuses %s model time',
  async (kind) => {
    const m = executionManifest();
    if (kind === 'future')
      m.actions.forEach(
        (a) =>
          (a.scheduledAt = new Date(
            Date.parse(m.createdAt) + 60000,
          ).toISOString()),
      );
    const f = await fixture(m);
    const now =
      kind === 'expired'
        ? Date.parse(m.expiresAt)
        : kind === 'backwards'
          ? f.defaultTime - 1
          : f.defaultTime;
    await expect(select(f, now)).rejects.toThrow();
  },
);

it.each(['pause', 'stop', 'reserve'] as const)(
  'refuses %s prefix state without another reservation',
  async (operation) => {
    const f = await fixture();
    await f.step(operation);
    await expect(select(f)).rejects.toThrow();
  },
);

it('requires the complete exact independently selected head and every historical frame', async () => {
  const f = await fixture();
  await f.step('pause');
  await f.step('resume');
  const head = await f.head();
  await expect(select(f, f.defaultTime, [], head)).rejects.toThrow();
  await expect(
    select(f, f.defaultTime, [...f.wires].reverse(), head),
  ).rejects.toThrow();
  await expect(
    select(f, f.defaultTime, f.wires, {
      ...head,
      checkpointSha256: executionHash(808),
    }),
  ).rejects.toThrow();
  const selected = await select(f);
  expect(selected.replayedEvents).toBe(2);
});

it('retains qualification exhaustion across the real complete prefix', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) {
    f.time(f.defaultTime + i * 30000);
    await f.step('reserve');
    await f.step('qualify', { evidenceSha256: executionHash(200 + i) });
    await f.step('cancel-unsigned');
  }
  await expect(select(f, f.defaultTime + 60000)).rejects.toThrow();
  expect(f.ledger.snapshot().qualificationAttempts).toBe(3);
});

it('retains the real qualification pacing floor without inventing reserve-time provider permission', async () => {
  const f = await fixture();
  await f.step('reserve');
  await f.step('qualify', { evidenceSha256: executionHash(500) });
  await f.step('cancel-unsigned');
  const selected = await select(f, f.defaultTime + 1);
  expect(selected.nextQualificationAt).toBe(f.defaultTime + 30000);
  expect(selected.providerReadAllowed).toBe(false);
  expect(selected.projection.snapshot.pending!.qualification).toBeNull();
});

it('refuses zero fee terms even though the original bookkeeping reserve remains valid', async () => {
  const m = executionManifest();
  m.actions[0].maximumFeeRentLamports = '0';
  const f = await fixture(m);
  const model = await deriveWarmupExecutionActionReservation(
    f.bound.root,
    f.approval,
    f.selector,
    f.initial.head,
    [],
    { now: f.defaultTime },
    signal(),
  );
  expect(model.projection.snapshot.pending!.state).toBe('reviewing');
  await expect(select(f)).rejects.toThrow();
  expect(f.ledger.snapshot().version).toBe(0);
});

it.each([30000, 1])(
  'refuses a next qualification floor at or beyond the original session expiry (gap %s)',
  async (gap) => {
    const f = await fixture(),
      at = Date.parse(f.bound.manifest.expiresAt) - gap;
    f.time(at);
    await f.step('reserve');
    await f.step('qualify', { evidenceSha256: executionHash(951) });
    await f.step('cancel-unsigned');
    const model = await deriveWarmupExecutionActionReservation(
      f.bound.root,
      f.approval,
      f.selector,
      await f.head(),
      f.wires,
      { now: at },
      signal(),
    );
    expect(
      model.projection.snapshot.nextQualificationAt,
    ).toBeGreaterThanOrEqual(Date.parse(f.bound.manifest.expiresAt));
    await expect(select(f, at)).rejects.toThrow();
  },
);

it('leaves actual qualification, preparation, authorization and dispatch headroom at the real model boundary', async () => {
  const f = await fixture();
  await f.step('reserve');
  await f.step('qualify', { evidenceSha256: executionHash(800) });
  await f.step('cancel-unsigned');
  for (let i = 0; i < 76088; i++)
    await f.step(i % 2 === 0 ? 'pause' : 'resume');
  const selected = await select(f, f.defaultTime + 30000);
  expect(selected.previousHead.version).toBe(76091);
  expect(selected.head.version).toBe(76092);
  const independent = await WarmupExecutionLedger.create(f.bound.manifest);
  for (const wire of f.wires) independent.apply(JSON.parse(wire).event);
  independent.apply(JSON.parse(selected.wire).event);
  const advance = (operation: string, fields: Record<string, unknown> = {}) =>
    independent.apply({
      operation,
      now: f.defaultTime + 30000,
      expectedVersion: independent.snapshot().version,
      expectedRootSha256: f.bound.manifestSha256,
      ...fields,
    });
  advance('qualify', { evidenceSha256: executionHash(801) });
  advance('prepare', {
    qualificationEvidenceSha256: executionHash(801),
    packetSha256: executionHash(802),
    minimumOutputRaw: '1',
  });
  advance('authorize', {
    id: executionId(803),
    packetSha256: executionHash(802),
    recheckSha256: executionHash(804),
  });
  advance('dispatch-intent', {
    id: executionId(805),
    authorizationId: executionId(803),
    packetSha256: executionHash(802),
    signedPacketSha256: executionHash(806),
    signature: executionSignature(4),
  });
  expect(independent.snapshot().version).toBe(76096);
  expect(independent.snapshot().pending!.state).toBe('dispatch-intent');
  await f.step('pause');
  await f.step('resume');
  expect((await f.head()).version).toBe(76093);
  await expect(select(f, f.defaultTime + 30000)).rejects.toThrow();
}, 180000);

it('keeps gross fee overrun held even when the model records a larger rent refund', async () => {
  const f = await fixture();
  await f.ready();
  await f.settle(1, {
    networkFeeLamports: '11',
    rentDebitLamports: '0',
    rentRefundLamports: '1000',
  });
  await expect(select(f, f.defaultTime + 30000)).rejects.toThrow();
  expect(f.ledger.snapshot().completedActions).toBe(0);
  expect(f.ledger.snapshot().pending).not.toBeNull();
});

it.each([
  { now: 0, operation: 'reserve' },
  { now: -1 },
  { now: 1.5 },
  {},
  { now: '0' },
])('refuses non-closed action input %j', async (value) => {
  const f = await fixture();
  await expect(
    select(f, f.defaultTime, [], f.initial.head, value),
  ).rejects.toThrow();
});

it('propagates pre-cancellation without selecting any action', async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = { cancelled: true };
  controller.abort(reason);
  await expect(
    derive(
      f.bound.root,
      f.approval,
      f.selector,
      f.initial.head,
      [],
      { now: f.defaultTime },
      controller.signal,
    ),
  ).rejects.toBe(reason);
});

it('cancels while awaiting the original prefix and closes the iterator without manufacturing a reservation', async () => {
  const f = await fixture(),
    controller = new AbortController();
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed = false;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          entered();
          return new Promise<IteratorResult<unknown>>(() => {});
        },
        return() {
          closed = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
  const reading = derive(
    f.bound.root,
    f.approval,
    f.selector,
    f.initial.head,
    stream,
    { now: f.defaultTime },
    controller.signal,
  );
  await pending;
  const reason = { abort: 'while reading' };
  controller.abort(reason);
  await expect(reading).rejects.toBe(reason);
  await Promise.resolve();
  expect(closed).toBe(true);
  expect(f.ledger.snapshot().pending).toBeNull();
});

it('captures the action clock and original identities before awaiting a nonempty async prefix', async () => {
  const f = await fixture();
  await f.step('pause');
  await f.step('resume');
  const head = await f.head(),
    root = structuredClone(f.bound.root),
    approval = structuredClone(f.approval),
    selector = { ...f.selector };
  const control = { now: f.defaultTime };
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = {
    async *[Symbol.asyncIterator]() {
      await barrier;
      yield* f.wires;
    },
  };
  const reading = derive(
    root,
    approval,
    selector,
    head,
    stream,
    control,
    signal(),
  );
  control.now = 0;
  head.version = 0;
  selector.ownerId = 'changed';
  approval.ownerId = 'changed';
  root.terms.intent.wallets[0].maximumBuyLamports = '1';
  release();
  const result = await reading;
  expect(result.replayedEvents).toBe(2);
  expect(JSON.parse(result.wire).event.now).toBe(f.defaultTime);
  expect(result.inputRaw).toBe('100');
});

it('detaches returned selections from original inputs and fresh derivations', async () => {
  const f = await fixture(),
    first = await select(f),
    original = structuredClone(first);
  first.wallet.maximumBuyLamports = '1';
  first.action.maximumFeeRentLamports = '0';
  first.readSelection.inputRaw = '1';
  first.head.eventSha256 = executionHash(700);
  expect(await select(f)).toEqual(original);
  expect(f.bound.manifest.wallets[0].maximumBuyLamports).toBe('100');
  expect(original.sha256).not.toBe((await select(f, f.defaultTime + 1)).sha256);
});
