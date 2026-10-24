import { expect, it, vi } from 'vitest';
import { jitoRawResponseFixture } from '../test/jito-raw-response-fixture';
import {
  collectJitoCoherentSimulationAttempt,
  type JitoCoherentSimulationRead,
} from './jito-coherent-simulation-attempt';

type F = Awaited<ReturnType<typeof jitoRawResponseFixture>>;
type Input = Parameters<typeof collectJitoCoherentSimulationAttempt>[0];
function input(
  f: F,
  transport: Input['transport'],
  overrides: Partial<Input> = {},
): Input {
  return {
    packets: structuredClone(f.policy.packets),
    minimumSlot: 100,
    minimumReadSlot: 100,
    feeIdPrefix: 'coherent',
    simulationRpcId: 'jito-test',
    verifySignatures: false,
    signal: new AbortController().signal,
    transport,
    ...overrides,
  };
}
function replies(f: F, request: JitoCoherentSimulationRead) {
  const members = JSON.parse(request.body) as { id: string; method: string }[];
  return members.map((m) =>
    m.method === 'getFeeForMessage'
      ? {
          jsonrpc: '2.0',
          id: m.id,
          result: { context: { slot: 101n }, value: 5000n },
        }
      : f.envelope,
  );
}
function discovery(f: F) {
  return { ...structuredClone(f.envelope), id: 'jito-test:discovery' };
}
function transport(
  f: F,
  mutate?: (members: ReturnType<typeof replies>) => unknown,
) {
  return vi.fn(
    async (r: JitoCoherentSimulationRead) =>
      new Response(
        f.wire(
          r.phase === 'discovery'
            ? discovery(f)
            : (mutate?.(replies(f, r)) ?? replies(f, r)),
        ),
      ),
  );
}
for (const [side, wallets, token2022, lookup] of [
  ['Buy', 1, false, false],
  ['Sell', 2, true, true],
  ['Buy', 3, true, true],
  ['Sell', 4, false, true],
] as const) {
  it(`replays exact mixed batch ${side}/${wallets}/${token2022}/${lookup}`, async () => {
    const f = await jitoRawResponseFixture({
        side,
        wallets,
        token2022,
        lookup,
      }),
      send = transport(f);
    const result = await collectJitoCoherentSimulationAttempt(input(f, send));
    expect(result.status).toBe('captured');
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      minimumSlot: 100,
      economicOutputVerified: false,
      signingAllowed: false,
      executionAllowed: false,
      providerQualified: false,
      sourceAuthenticated: false,
      altStateVerified: false,
      runtimePrivilegesVerified: false,
    });
    const first = send.mock.calls[0][0],
      second = send.mock.calls[1][0];
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(first.methodCount).toBe(1);
    expect(second.methodCount).toBe(wallets + 2);
    const hint = JSON.parse(first.body);
    const batch = JSON.parse(second.body);
    expect(hint.params[1]).toMatchObject({
      simulationBank: { commitment: { commitment: 'confirmed' } },
      skipSigVerify: true,
      replaceRecentBlockhash: false,
    });
    expect(batch.at(-1).params[1].simulationBank).toEqual({ slot: 101 });
    expect(batch.at(-1).params[0].encodedTransactions).toEqual(
      f.policy.packets.map((p) => p.transaction),
    );
    expect(result.sentSimulationBody).toBe(JSON.stringify(batch.at(-1)));
    expect(result.fees?.status).toBe('observed');
    expect(result.simulation?.status).toBe('admitted');
    if (result.batch?.status === 'captured')
      for (const member of result.batch.members) {
        expect(member.rawBody).toEqual(
          result.batch.rawResponse.rawBody.slice(member.start, member.end),
        );
      }
  });
}
for (const mutation of [
  'later-fees',
  'mixed-fees',
  'null-fee',
  'string-fee',
  'zero-fee',
  'overcap',
  'wrong-sim-bank',
  'failed-frame',
  'partial',
  'reordered',
  'duplicate',
  'wrong-id',
] as const) {
  it(`refuses ${mutation} with no fallback`, async () => {
    const f = await jitoRawResponseFixture(),
      send = transport(f, (m) => {
        const fee = m[0] as {
          result: { context: { slot: bigint }; value: unknown };
        };
        if (mutation === 'later-fees')
          for (const row of m.slice(0, -1))
            (row as typeof fee).result.context.slot = 102n;
        if (mutation === 'mixed-fees') fee.result.context.slot = 102n;
        if (mutation === 'null-fee') fee.result.value = null;
        if (mutation === 'string-fee') fee.result.value = '5000';
        if (mutation === 'zero-fee') fee.result.value = 0n;
        if (mutation === 'overcap') fee.result.value = (1n << 64n) - 1n;
        if (mutation === 'wrong-sim-bank')
          (m.at(-1) as F['envelope']).result.context.slot = 102n;
        if (mutation === 'failed-frame')
          (m.at(-1) as F['envelope']).result.value.summary = 'failed';
        if (mutation === 'partial') m.pop();
        if (mutation === 'reordered') m.reverse();
        if (mutation === 'duplicate') m[1] = m[0];
        if (mutation === 'wrong-id') m[0].id = 'unknown';
        return m;
      });
    const result = await collectJitoCoherentSimulationAttempt(input(f, send));
    expect(result.status).toBe('refused');
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.signingAllowed).toBe(false);
  });
}
for (const phase of ['discovery', 'batch'] as const)
  it(`stops HTTP429 at ${phase}`, async () => {
    const f = await jitoRawResponseFixture();
    const send = vi.fn(async (r: JitoCoherentSimulationRead) =>
      r.phase === phase
        ? new Response('private provider text', { status: 429 })
        : new Response(f.wire(discovery(f))),
    );
    const result = await collectJitoCoherentSimulationAttempt(input(f, send));
    expect(result).toMatchObject({ reason: 'rate-limited' });
    expect(send).toHaveBeenCalledTimes(phase === 'discovery' ? 1 : 2);
  });
it('snapshots packets, identity, floor and signature mode before transport awaits', async () => {
  const f = await jitoRawResponseFixture({ lookup: true }),
    original = f.policy.packets.map((p) => p.transaction);
  const send = vi.fn(async (r: JitoCoherentSimulationRead) => {
    if (r.phase === 'discovery') {
      requestInput.packets[0].transaction = 'bad';
      requestInput.minimumSlot = 999;
      requestInput.verifySignatures = true;
      requestInput.simulationRpcId = 'changed';
      return new Response(f.wire(discovery(f)));
    }
    expect(JSON.parse(r.body).at(-1).params[0].encodedTransactions).toEqual(
      original,
    );
    return new Response(f.wire(replies(f, r)));
  });
  const requestInput = input(f, send);
  const result = await collectJitoCoherentSimulationAttempt(requestInput);
  expect(result.status).toBe('captured');
  expect(result.minimumSlot).toBe(100);
});
it('does not start mixed reads for out-of-span discovery bank', async () => {
  const f = await jitoRawResponseFixture();
  for (const slot of [99n, 133n]) {
    const hint = discovery(f);
    hint.result.context.slot = slot;
    const send = vi.fn(async () => new Response(f.wire(hint)));
    const result = await collectJitoCoherentSimulationAttempt(input(f, send));
    expect(result.status).toBe('refused');
    expect(send).toHaveBeenCalledTimes(1);
  }
});
it('aborts pending transport and cancels its late response', async () => {
  const f = await jitoRawResponseFixture(),
    control = new AbortController();
  let resolve!: (v: Response) => void;
  const send = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const pending = collectJitoCoherentSimulationAttempt(
    input(f, send, { signal: control.signal }),
  );
  while (!resolve) await new Promise<void>((r) => setImmediate(r));
  control.abort('private reason');
  const result = await pending;
  expect(result).toMatchObject({ reason: 'interrupted' });
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  resolve(response);
  await new Promise<void>((r) => setImmediate(r));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body!.locked).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
});
it('owns response before abort wins promise adoption', async () => {
  const f = await jitoRawResponseFixture(),
    control = new AbortController(),
    cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const send = vi.fn(async () => {
    queueMicrotask(() => queueMicrotask(() => control.abort()));
    return response;
  });
  const result = await collectJitoCoherentSimulationAttempt(
    input(f, send, { signal: control.signal }),
  );
  expect(result).toMatchObject({ reason: 'interrupted' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body!.locked).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
});

it('enforces the original floor, additional read floor and safe policy before reads', async () => {
  const f = await jitoRawResponseFixture();
  for (const minimumReadSlot of [99, 133, NaN]) {
    const send = transport(f);
    await expect(
      collectJitoCoherentSimulationAttempt(input(f, send, { minimumReadSlot })),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  }
  const send = transport(f);
  const result = await collectJitoCoherentSimulationAttempt(
    input(f, send, { minimumReadSlot: 102 }),
  );
  expect(result.status).toBe('refused');
  expect(send).toHaveBeenCalledTimes(1);
});

it('retains signature mode in discovery and exact replay without granting authority', async () => {
  const f = await jitoRawResponseFixture(),
    send = transport(f);
  const result = await collectJitoCoherentSimulationAttempt(
    input(f, send, { verifySignatures: true }),
  );
  expect(result.status).toBe('captured');
  for (const [request] of send.mock.calls) {
    const body = JSON.parse(request.body);
    expect(
      (request.phase === 'discovery' ? body : body.at(-1)).params[1]
        .skipSigVerify,
    ).toBe(false);
  }
  expect(result.signatureVerified).toBe(false);
  expect(result.feeProjection?.kind).toBe('derived-member-array-not-wire');
});

it('stops on a single shared deadline while transport remains pending', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const control = new AbortController();
    setTimeout(() => control.abort(), ms);
    return control.signal;
  });
  try {
    const f = await jitoRawResponseFixture();
    const send = vi.fn(() => new Promise<Response>(() => {}));
    const pending = collectJitoCoherentSimulationAttempt(input(f, send));
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({
      status: 'refused',
      reason: 'interrupted',
    });
    expect(send.mock.calls.length).toBeLessThanOrEqual(1);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it('does not expose arbitrary transport error text', async () => {
  const f = await jitoRawResponseFixture();
  const result = await collectJitoCoherentSimulationAttempt(
    input(f, async () => {
      throw Error('private credential sentinel');
    }),
  );
  expect(result).toMatchObject({
    status: 'refused',
    reason: 'transport-unavailable',
  });
  expect(result).not.toHaveProperty('error');
});

it('classifies RPC429 without interpreting provider message text', async () => {
  const f = await jitoRawResponseFixture();
  for (const phase of ['discovery', 'batch'] as const) {
    const send = vi.fn(async (r: JitoCoherentSimulationRead) => {
      if (r.phase === 'discovery')
        return new Response(
          f.wire(
            phase === 'discovery'
              ? {
                  jsonrpc: '2.0',
                  id: 'jito-test:discovery',
                  error: { code: 429n, message: 'private' },
                }
              : discovery(f),
          ),
        );
      const rows = replies(f, r);
      rows[0] = {
        jsonrpc: '2.0',
        id: 'coherent:0',
        error: { code: 429n, message: 'private' },
      } as unknown as (typeof rows)[number];
      return new Response(f.wire(rows));
    });
    expect(
      await collectJitoCoherentSimulationAttempt(input(f, send)),
    ).toMatchObject({ status: 'refused', reason: 'rate-limited' });
    expect(send).toHaveBeenCalledTimes(phase === 'discovery' ? 1 : 2);
  }
});

for (const shape of [
  'partial',
  'reordered',
  'duplicate',
  'wrong-id',
  'malformed-error',
] as const)
  it(`uses matched RPC429 only as stop signal in ${shape} batch`, async () => {
    const f = await jitoRawResponseFixture();
    const send = transport(f, (rows) => {
      rows[0] = {
        jsonrpc: '2.0',
        id: shape === 'wrong-id' ? 'unrequested' : 'coherent:0',
        error: {
          code: 429n,
          message: shape === 'malformed-error' ? 123 : 'private',
        },
      } as unknown as (typeof rows)[number];
      if (shape === 'partial') rows.pop();
      if (shape === 'reordered') rows.reverse();
      if (shape === 'duplicate') rows[1] = rows[0];
      return rows;
    });
    const result = await collectJitoCoherentSimulationAttempt(input(f, send));
    expect(result).toMatchObject({
      status: 'refused',
      reason: 'rate-limited',
      economicOutputVerified: false,
      signingAllowed: false,
    });
    expect(result.simulation).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

for (const phase of ['discovery', 'batch'] as const)
  for (const shape of ['null-id', 'wrong-id', 'extra-fields'] as const)
    it(`stops on parsed RPC429 ${phase}/${shape} without granting malformed evidence`, async () => {
      const f = await jitoRawResponseFixture();
      const send = vi.fn(async (r: JitoCoherentSimulationRead) => {
        if (r.phase !== phase) return new Response(f.wire(discovery(f)));
        return new Response(
          f.wire({
            jsonrpc: '2.0',
            id: shape === 'null-id' ? null : 'unrequested',
            error: { code: 429n },
            ...(shape === 'extra-fields' ? { unknown: true } : {}),
          }),
        );
      });
      const result = await collectJitoCoherentSimulationAttempt(input(f, send));
      expect(result).toMatchObject({
        status: 'refused',
        reason: 'rate-limited',
        signingAllowed: false,
        economicOutputVerified: false,
        simulation: null,
      });
      expect(send).toHaveBeenCalledTimes(phase === 'discovery' ? 1 : 2);
    });
