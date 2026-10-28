import { expect, it, vi } from 'vitest';
import { jitoRawResponseFixture } from '../test/jito-raw-response-fixture';
import {
  collectJitoSimulationAttempt,
  type JitoSimulationRead,
  type JitoSimulationTransport,
} from './jito-simulation-attempt';
import { getBase64Decoder, getTransactionDecoder } from '@solana/kit';
const signal = () => new AbortController().signal;
type F = Awaited<ReturnType<typeof jitoRawResponseFixture>>;
function fees(f: F, request: JitoSimulationRead, slot = 101n) {
  return f.body(
    (JSON.parse(request.body) as { id: string }[]).map(({ id }) => ({
      jsonrpc: '2.0',
      id,
      result: { context: { slot }, value: 5000n },
    })),
  );
}
async function fixture() {
  return jitoRawResponseFixture({ lookup: true, token2022: true, wallets: 2 });
}
function policy(
  f: F,
  transport: JitoSimulationTransport,
  overrides: Partial<Parameters<typeof collectJitoSimulationAttempt>[0]> = {},
) {
  return {
    packets: structuredClone(f.policy.packets),
    minimumSlot: 100,
    feeIdPrefix: 'attempt',
    simulationRpcId: 'jito-test',
    bankEncoding: 'slot-object' as const,
    verifySignatures: false,
    signal: signal(),
    transport,
    ...overrides,
  };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate()).toBe(true);
}
const falseAuthority = (value: unknown) =>
  expect(value).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
    providerQualified: false,
    sourceAuthenticated: false,
    signatureVerified: false,
    altStateVerified: false,
    runtimePrivilegesVerified: false,
    economicOutputVerified: false,
  });
for (const bankEncoding of ['slot-object', 'numeric-slot'] as const)
  it(`captures exactly two frozen read requests using the fee-derived bank with ${bankEncoding}`, async () => {
    const f = await fixture(),
      requests: JitoSimulationRead[] = [];
    const transport = vi.fn(async (request: JitoSimulationRead) => {
      requests.push(request);
      return new Response(
        request.phase === 'fees' ? fees(f, request) : f.body(),
      );
    });
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Error('network forbidden'));
    try {
      const output = await collectJitoSimulationAttempt(
        policy(f, transport, { bankEncoding }),
      );
      expect(output.status).toBe('captured');
      expect(requests.map((r) => r.phase)).toEqual(['fees', 'simulation']);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(fetcher).not.toHaveBeenCalled();
      for (const request of requests) {
        expect(Object.isFrozen(request)).toBe(true);
        expect(typeof request.body).toBe('string');
        expect(request.signal).toBeInstanceOf(AbortSignal);
      }
      expect(requests[0].signal).toBe(requests[1].signal);
      expect(requests[0].signal.aborted).toBe(true);
      const feeBody = JSON.parse(requests[0].body);
      expect(feeBody).toEqual(
        f.policy.packets.map((p, i) => ({
          jsonrpc: '2.0',
          id: `attempt:${i}`,
          method: 'getFeeForMessage',
          params: [
            getBase64Decoder().decode(
              getTransactionDecoder().decode(
                Buffer.from(p.transaction, 'base64'),
              ).messageBytes,
            ),
            { commitment: 'confirmed', minContextSlot: 100 },
          ],
        })),
      );
      const simulation = JSON.parse(requests[1].body);
      expect(simulation.id).toBe('jito-test');
      expect(simulation.method).toBe('simulateBundle');
      expect(simulation.params[0].encodedTransactions).toEqual(
        f.policy.packets.map((p) => p.transaction),
      );
      expect(simulation.params[1].simulationBank).toEqual(
        bankEncoding === 'slot-object' ? { slot: 101 } : 101,
      );
      expect(simulation.params[1].replaceRecentBlockhash).toBe(false);
      expect(simulation.params[1].skipSigVerify).toBe(true);
      expect(output.sentSimulationBody).toBe(requests[1].body);
      expect(output.minimumSlot).toBe(100);
      expect(output.reads).toEqual([
        { phase: 'fees', status: 200 },
        { phase: 'simulation', status: 200 },
      ]);
      expect(output.simulation?.request.body).toBe(requests[1].body);
      falseAuthority(output);
    } finally {
      fetcher.mockRestore();
    }
  });
it('captures original packet/policy inputs before awaiting and uses actual fees rather than stale expected values', async () => {
  const f = await fixture(),
    requests: JitoSimulationRead[] = [];
  const input = policy(f, async (request) => {
    requests.push(request);
    return new Response(request.phase === 'fees' ? fees(f, request) : f.body());
  });
  const original = structuredClone(input.packets);
  input.packets.forEach((p) => (p.expectedFeeLamports = '1'));
  const pending = collectJitoSimulationAttempt(input);
  input.packets[0].transaction = f.fixture.manifest.tip.transaction;
  input.minimumSlot = 9999;
  input.simulationRpcId = 'changed';
  input.transport = async () => {
    throw Error('replacement called');
  };
  const output = await pending;
  expect(output.status).toBe('captured');
  expect(output.minimumSlot).toBe(100);
  expect(JSON.parse(requests[1].body).params[0].encodedTransactions).toEqual(
    original.map((p) => p.transaction),
  );
  expect(JSON.parse(requests[1].body).id).toBe('jito-test');
  expect(output.fees?.status).toBe('observed');
  if (output.fees?.status === 'observed')
    expect(output.fees.packets.map((p) => p.expectedFeeLamports)).toEqual([
      '5000',
      '5000',
      '5000',
    ]);
  falseAuthority(output);
});
for (const phase of ['fees', 'simulation'] as const)
  it(`stops on HTTP429 in ${phase} without retry/fallback and cancels unread data`, async () => {
    const f = await fixture(),
      cancel = vi.fn(),
      transport = vi.fn(async (request: JitoSimulationRead) =>
        request.phase === phase
          ? new Response(new ReadableStream<Uint8Array>({ cancel }), {
              status: 429,
            })
          : new Response(fees(f, request)),
      );
    const output = await collectJitoSimulationAttempt(policy(f, transport));
    expect(output.status).toBe('refused');
    if (output.status === 'refused') {
      expect(output.reason).toBe('rate-limited');
      expect(output.phase).toBe(phase);
    }
    expect(transport).toHaveBeenCalledTimes(phase === 'fees' ? 1 : 2);
    expect(cancel).toHaveBeenCalledOnce();
    falseAuthority(output);
  });
it('does not run simulation after a fee schema refusal or inconsistent actual fee banks', async () => {
  for (const mixed of [false, true]) {
    const f = await fixture(),
      transport = vi.fn(async (request: JitoSimulationRead) => {
        expect(request.phase).toBe('fees');
        const rows = (JSON.parse(request.body) as { id: string }[]).map(
          ({ id }, i) => ({
            jsonrpc: '2.0',
            id,
            result: {
              context: { slot: mixed && i === 1 ? 102n : 101n },
              value: mixed ? 5000n : null,
            },
          }),
        );
        return new Response(f.body(rows));
      });
    const output = await collectJitoSimulationAttempt(policy(f, transport));
    expect(output.status).toBe('refused');
    if (output.status === 'refused') expect(output.reason).toBe('fees-refused');
    expect(transport).toHaveBeenCalledOnce();
    expect(output.sentSimulationBody).toBeNull();
    falseAuthority(output);
  }
});
for (const variant of [
  'exact',
  'different-code',
  'other-slot',
  'case',
  'sensitive',
] as const)
  it(`classifies bank-unavailable only for exact admitted code/message/currentbank ${variant}`, async () => {
    const f = await fixture(),
      secret = 'https://private.invalid/?key=FAKE_ATTEMPT_SECRET';
    const transport = vi.fn(
      async (request: JitoSimulationRead) =>
        new Response(
          request.phase === 'fees'
            ? fees(f, request)
            : f.body({
                jsonrpc: '2.0',
                id: 'jito-test',
                error: {
                  code: variant === 'different-code' ? -32000n : -32602n,
                  message:
                    variant === 'other-slot'
                      ? 'bank not found for the provided slot: 100'
                      : variant === 'case'
                        ? 'Bank not found for the provided slot: 101'
                        : variant === 'sensitive'
                          ? secret
                          : 'bank not found for the provided slot: 101',
                },
              }),
        ),
    );
    const output = await collectJitoSimulationAttempt(policy(f, transport));
    expect(output.status).toBe('refused');
    if (output.status === 'refused') {
      expect(output.reason).toBe(
        variant === 'exact' ? 'bank-unavailable' : 'simulation-refused',
      );
      expect(output.reason).not.toContain(secret);
      expect(output.phase).toBe('simulation');
    }
    expect(transport).toHaveBeenCalledTimes(2);
    falseAuthority(output);
  });
for (const variant of ['bank', 'id-number', 'schema', 'error-shape'])
  it(`refuses mismatched simulation ${variant} with no alternative request`, async () => {
    const f = await fixture();
    const envelope: Record<string, unknown> = structuredClone(f.envelope);
    if (variant === 'bank') f.envelope.result.context.slot = 102n;
    if (variant === 'id-number') envelope.id = 1n;
    if (variant === 'schema') Object.assign(envelope, { surprise: true });
    if (variant === 'error-shape') {
      delete envelope.result;
      envelope.error = {
        code: '-32602',
        message: 'bank not found for the provided slot: 101',
      };
    }
    const transport = vi.fn(
      async (request: JitoSimulationRead) =>
        new Response(
          request.phase === 'fees'
            ? fees(f, request)
            : f.body(variant === 'bank' ? f.envelope : envelope),
        ),
    );
    const output = await collectJitoSimulationAttempt(policy(f, transport));
    expect(output.status).toBe('refused');
    if (output.status === 'refused')
      expect(output.reason).toBe('simulation-refused');
    expect(transport).toHaveBeenCalledTimes(2);
    falseAuthority(output);
  });
it('sanitizes arbitrary transport failures without another request', async () => {
  const f = await fixture(),
    transport = vi.fn(async () => {
      throw Error('https://private.invalid/?key=FAKE_TRANSPORT_SECRET');
    });
  const output = await collectJitoSimulationAttempt(policy(f, transport));
  expect(output.status).toBe('refused');
  if (output.status === 'refused')
    expect(output.reason).toBe('transport-unavailable');
  expect(transport).toHaveBeenCalledOnce();
  falseAuthority(output);
});
for (const phase of ['fees', 'simulation'] as const)
  it(`aborts pending ${phase}, then cleans a late response without consuming it or retrying`, async () => {
    const f = await fixture(),
      controller = new AbortController(),
      cancel = vi.fn();
    let resolve!: (value: Response) => void;
    let acknowledgeStart!: () => void;
    const started = new Promise<void>((done) => {
      acknowledgeStart = done;
    });
    const cancelled = new Promise<void>((done) => {
      cancel.mockImplementation(done);
    });
    const transport = vi.fn(async (request: JitoSimulationRead) =>
      request.phase === phase
        ? new Promise<Response>((r) => {
            resolve = r;
            acknowledgeStart();
          })
        : new Response(fees(f, request)),
    );
    const promise = collectJitoSimulationAttempt(
      policy(f, transport, { signal: controller.signal }),
    );
    await started;
    controller.abort(Error('FAKE_PRIVATE_REASON'));
    const output = await promise;
    expect(output.status).toBe('refused');
    if (output.status === 'refused') expect(output.reason).toBe('interrupted');
    falseAuthority(output);
    const pull = vi.fn(),
      stream = new ReadableStream<Uint8Array>(
        { pull, cancel },
        { highWaterMark: 0 },
      );
    resolve(new Response(stream));
    await cancelled;
    expect(pull).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    expect(transport).toHaveBeenCalledTimes(phase === 'fees' ? 1 : 2);
  });
it('cleans a response whose body access aborts before its adapter can acquire the reader', async () => {
  const f = await fixture(),
    controller = new AbortController(),
    cancel = vi.fn(),
    stream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
    response = new Response(stream);
  const descriptor = Object.getOwnPropertyDescriptor(
    Response.prototype,
    'body',
  )!;
  const spy = vi
    .spyOn(Response.prototype, 'body', 'get')
    .mockImplementation(function (this: Response) {
      if (this === response && !controller.signal.aborted) controller.abort();
      return descriptor.get!.call(this) as Response['body'];
    });
  const transport = vi.fn(async () => response);
  try {
    const output = await collectJitoSimulationAttempt(
      policy(f, transport, { signal: controller.signal }),
    );
    expect(output.status).toBe('refused');
    if (output.status === 'refused') expect(output.reason).toBe('interrupted');
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
  }
});
it('enforces its single30second attempt deadline without waiting for an uncooperative transport', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  });
  const transport = vi.fn(() => new Promise<Response>(() => {}));
  try {
    const promise = collectJitoSimulationAttempt(policy(f, transport));
    await until(() => transport.mock.calls.length === 1);
    expect(timeout).toHaveBeenCalledWith(30000);
    await vi.advanceTimersByTimeAsync(30000);
    const output = await promise;
    expect(output.status).toBe('refused');
    if (output.status === 'refused') expect(output.reason).toBe('interrupted');
    expect(transport).toHaveBeenCalledOnce();
    falseAuthority(output);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it('cleans a response when nested microtask cancellation wins promise adoption before the send race returns', async () => {
  const f = await fixture(),
    controller = new AbortController(),
    cancel = vi.fn(),
    pull = vi.fn();
  const stream = new ReadableStream<Uint8Array>(
      { pull, cancel },
      { highWaterMark: 0 },
    ),
    response = new Response(stream);
  const transport = vi.fn(async () => {
    queueMicrotask(() => queueMicrotask(() => controller.abort()));
    return response;
  });
  const output = await collectJitoSimulationAttempt(
    policy(f, transport, { signal: controller.signal }),
  );
  expect(output.status).toBe('refused');
  if (output.status === 'refused') expect(output.reason).toBe('interrupted');
  expect(cancel).toHaveBeenCalledOnce();
  expect(pull).not.toHaveBeenCalled();
  expect(stream.locked).toBe(false);
  expect(transport).toHaveBeenCalledOnce();
  expect(output.sentSimulationBody).toBeNull();
  falseAuthority(output);
});

it.each(['identity', 'packets'] as const)(
  'distinguishes an invalid fee plan %s from a transport outage without issuing a read',
  async (kind) => {
    const f = await fixture();
    const transport = vi.fn(async () => new Response());
    const input = policy(f, transport);
    if (kind === 'identity') input.feeIdPrefix = 'not an identity';
    else input.packets[1] = structuredClone(input.packets[0]);
    const output = await collectJitoSimulationAttempt(input);
    expect(output.status).toBe('refused');
    if (output.status === 'refused') expect(output.reason).toBe('plan-refused');
    expect(output.reads).toEqual([]);
    expect(output.fees).toBeNull();
    expect(output.simulation).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    falseAuthority(output);
  },
);

it.each([0, 1, 2, 3])(
  'owns a native response with a plain transport and abort depth %i',
  async (depth) => {
    const f = await fixture();
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: () => new Promise<void>(() => {}),
        cancel,
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream);
    let calls = 0;
    const schedule = (remaining: number): void => {
      if (remaining === 0) controller.abort();
      else queueMicrotask(() => schedule(remaining - 1));
    };
    const transport: JitoSimulationTransport = async () => {
      calls++;
      schedule(depth);
      return response;
    };
    const output = await collectJitoSimulationAttempt(
      policy(f, transport, { signal: controller.signal }),
    );
    expect(output.status).toBe('refused');
    if (output.status === 'refused') expect(output.reason).toBe('interrupted');
    await until(() => cancel.mock.calls.length === 1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(calls).toBe(1);
    falseAuthority(output);
  },
);
