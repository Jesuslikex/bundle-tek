import { expect, it, vi } from 'vitest';
import {
  auditSavedWarmupExecutionPrefix,
  deriveWarmupExecutionControlAppend as derive,
  WarmupExecutionAuditError,
} from '../lib/wallet-warmup-execution-audit';
import { executionAuditFixture as fixture } from './warmup-execution-audit-fixture';

const signal = () => new AbortController().signal;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function append(
  f: Fixture,
  stream: Iterable<unknown> | AsyncIterable<unknown> = f.wires,
  control: unknown = { operation: 'resume', now: f.defaultTime },
  head?: unknown,
) {
  return derive(
    f.bound.root,
    f.approval,
    f.selector,
    head ?? (await f.head()),
    stream,
    control,
    signal(),
  );
}

it('derives one canonical immutable wire and independently replays its complete prefix', async () => {
  const f = await fixture();
  await f.step('pause');
  const oldHead = await f.head();
  const result = await append(f);
  expect(typeof result.wire).toBe('string');
  expect(result.previousHead).toEqual(oldHead);
  expect(result.replayedEvents).toBe(1);
  expect(result.wireBytes).toBe(new TextEncoder().encode(f.wires[0]).length);
  expect(result).toMatchObject({
    scope: 'control-append-derivation-only',
    receiptEvidenceVerified: false,
    currentSourceVerified: false,
    currentHeadVerified: false,
    financialReservationVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  const independently = await auditSavedWarmupExecutionPrefix(
    f.bound.root,
    f.approval,
    f.selector,
    result.head,
    [...f.wires, result.wire],
    signal(),
  );
  expect(independently.checkpoint).toEqual(result.checkpoint);
  expect(independently.projection).toEqual(result.projection);
  expect(f.wires).toHaveLength(1);
  expect(f.ledger.snapshot().version).toBe(1);
});

it('derives pause, resume and stop from genesis and each exact subsequent full prefix', async () => {
  const f = await fixture();
  let head = f.initial.head;
  const stream: string[] = [];
  for (const operation of ['pause', 'resume', 'stop'] as const) {
    const result = await append(
      f,
      stream,
      { operation, now: f.defaultTime },
      head,
    );
    stream.push(result.wire);
    head = result.head;
    expect(result.replayedEvents).toBe(stream.length - 1);
    expect(JSON.parse(result.wire).event.operation).toBe(operation);
  }
  await expect(
    append(f, stream, { operation: 'resume', now: f.defaultTime }, head),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
});

it.each([
  [
    'sparse',
    () => {
      const a: unknown[] = [];
      a.length = 1;
      return a;
    },
  ],
  ['object', () => [{}]],
  ['number', () => [0]],
  ['empty frame', () => ['']],
  ['trailing empty frame', (wire: string) => [wire, '']],
  ['duplicate frame', (wire: string) => [wire, wire]],
  ['malformed JSON', () => ['{']],
  ['noncanonical whitespace', (wire: string) => [wire + ' ']],
] as const)(
  'refuses %s without deriving a partial event',
  async (_name, make) => {
    const f = await fixture();
    await f.step('pause');
    await expect(append(f, make(f.wires[0]))).rejects.toBeInstanceOf(
      WarmupExecutionAuditError,
    );
  },
);

it.each(['truncated', 'reordered', 'hash drift'] as const)(
  'refuses %s original prefix',
  async (kind) => {
    const f = await fixture();
    await f.step('pause');
    await f.step('resume');
    const stream = [...f.wires];
    if (kind === 'truncated') stream.pop();
    if (kind === 'reordered') stream.reverse();
    if (kind === 'hash drift') {
      const row = JSON.parse(stream[0]);
      row.sha256 = 'a'.repeat(64);
      stream[0] = JSON.stringify(row);
    }
    await expect(append(f, stream)).rejects.toBeInstanceOf(
      WarmupExecutionAuditError,
    );
  },
);

it.each([
  { operation: 'reserve', now: 0 },
  { operation: 'pause' },
  { operation: 'pause', now: -1 },
  { operation: 'pause', now: 1.5 },
  { operation: 'pause', now: 0, unexpected: true },
])('admits only the closed control input %j', async (control) => {
  const f = await fixture();
  await expect(append(f, [], control, f.initial.head)).rejects.toBeInstanceOf(
    WarmupExecutionAuditError,
  );
});

it('reads a yielded immutable value once and never coerces a second getter value', async () => {
  const f = await fixture();
  await f.step('pause');
  let yielded = false;
  const coercion = vi.fn();
  let values = 0;
  const stream = {
    [Symbol.iterator]() {
      return {
        next() {
          if (yielded) return { done: true as const, value: undefined };
          yielded = true;
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
  expect((await append(f, stream)).replayedEvents).toBe(1);
  expect(values).toBe(1);
  expect(coercion).not.toHaveBeenCalled();
});

it('does not read EOF value and keeps iterator cleanup receiver binding', async () => {
  const f = await fixture();
  const eofValue = vi.fn(() => {
    throw Error('EOF value must not be read');
  });
  await append(
    f,
    {
      [Symbol.iterator]() {
        return {
          next() {
            return {
              done: true as const,
              get value() {
                return eofValue();
              },
            };
          },
        };
      },
    },
    { operation: 'pause', now: f.defaultTime },
    f.initial.head,
  );
  let correctReceiver = false;
  const iterator = {
    next() {
      return { done: false as const, value: 'invalid' };
    },
    return() {
      correctReceiver = this === iterator;
      return { done: true as const, value: undefined };
    },
  };
  await expect(
    append(f, { [Symbol.iterator]: () => iterator }, undefined, f.initial.head),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
  await Promise.resolve();
  expect(correctReceiver).toBe(true);
  expect(eofValue).not.toHaveBeenCalled();
});

it('cancels a never-resolving iterator with the original reason and best-effort close', async () => {
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
  const reading = derive(
    f.bound.root,
    f.approval,
    f.selector,
    f.initial.head,
    stream,
    { operation: 'pause', now: f.defaultTime },
    controller.signal,
  );
  await pending;
  const reason = { reason: 'caller cancellation' };
  controller.abort(reason);
  await expect(reading).rejects.toBe(reason);
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});

it('snapshots root, approval, selector, head and control before the first await', async () => {
  const f = await fixture();
  const root = structuredClone(f.bound.root),
    approval = structuredClone(f.approval),
    selector = { ...f.selector },
    head = { ...f.initial.head },
    control = { operation: 'pause', now: f.defaultTime };
  const reading = derive(root, approval, selector, head, [], control, signal());
  root.terms.intent.wallets[0].maximumBuyLamports = '1';
  approval.ownerId = 'changed';
  selector.ownerId = 'changed';
  head.eventSha256 = 'a'.repeat(64);
  control.operation = 'stop';
  control.now = 0;
  const result = await reading;
  expect(JSON.parse(result.wire).event).toMatchObject({
    operation: 'pause',
    now: f.defaultTime,
  });
  expect(result.previousHead).toEqual(f.initial.head);
});

it('refuses even a valid independently auditable financial prefix in the control-only slice', async () => {
  const f = await fixture();
  await f.step('reserve');
  const head = await f.head();
  expect(
    (
      await auditSavedWarmupExecutionPrefix(
        f.bound.root,
        f.approval,
        f.selector,
        head,
        f.wires,
        signal(),
      )
    ).replayedEvents,
  ).toBe(1);
  await expect(
    append(f, f.wires, { operation: 'pause', now: f.defaultTime }, head),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
});

it('retains its refusal when the iterator cleanup getter throws', async () => {
  const f = await fixture();
  const cleanup = vi.fn(() => {
    throw Error('private cleanup');
  });
  await expect(
    append(
      f,
      {
        [Symbol.iterator]() {
          return {
            next() {
              return { done: false as const, value: 'invalid' };
            },
            get return() {
              return cleanup();
            },
          };
        },
      },
      { operation: 'pause', now: f.defaultTime },
      f.initial.head,
    ),
  ).rejects.toBeInstanceOf(WarmupExecutionAuditError);
  await Promise.resolve();
  expect(cleanup).toHaveBeenCalledOnce();
});
