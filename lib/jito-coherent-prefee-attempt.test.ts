import { expect, it, vi } from 'vitest';
import { jitoRawResponseFixture } from '../test/jito-raw-response-fixture';
import { collectJitoCoherentPrefeeAttempt } from './jito-coherent-prefee-attempt';

type F = Awaited<ReturnType<typeof jitoRawResponseFixture>>;
type Input = Parameters<typeof collectJitoCoherentPrefeeAttempt>[0];
function input(
  f: F,
  transport: Input['transport'],
  overrides: Partial<Input> = {},
): Input {
  return {
    packets: structuredClone(f.policy.packets),
    minimumSlot: 100,
    minimumReadSlot: 100,
    feeIdPrefix: 'prefee',
    simulationRpcId: 'jito-test',
    verifySignatures: false,
    signal: new AbortController().signal,
    transport,
    ...overrides,
  };
}
function batchRows(f: F, request: Parameters<Input['transport']>[0]) {
  const members = JSON.parse(request.body) as { id: string; method: string }[];
  return members.map((m) =>
    m.method === 'getFeeForMessage'
      ? {
          jsonrpc: '2.0',
          id: m.id,
          result: { context: { slot: 101n }, value: 5000n },
        }
      : { ...structuredClone(f.envelope), id: m.id },
  );
}
function transport(
  f: F,
  mutate?: (rows: ReturnType<typeof batchRows>) => unknown,
) {
  return vi.fn(
    async (r: Parameters<Input['transport']>[0]) =>
      new Response(
        f.wire(
          r.phase === 'discovery-batch'
            ? (mutate?.(batchRows(f, r)) ?? batchRows(f, r))
            : f.envelope,
        ),
      ),
  );
}
it('records opt-in non-authoritative timing without changing requests or evidence', async () => {
  const f = await jitoRawResponseFixture();
  const baselineTransport = transport(f),
    timedTransport = transport(f);
  const baseline = await collectJitoCoherentPrefeeAttempt(
    input(f, baselineTransport),
  );
  const timed = await collectJitoCoherentPrefeeAttempt(
    input(f, timedTransport, { diagnosticTiming: true }),
  );
  expect(baseline.status).toBe('captured');
  expect(timed.status).toBe(baseline.status);
  expect(
    timedTransport.mock.calls.map(([r]) => [r.phase, r.methodCount, r.body]),
  ).toEqual(
    baselineTransport.mock.calls.map(([r]) => [r.phase, r.methodCount, r.body]),
  );
  expect(baseline).not.toHaveProperty('diagnosticTimings');
  expect(timed).toHaveProperty('diagnosticTimings');
  const { diagnosticTimings, ...timedEvidence } = timed;
  expect(timedEvidence).toEqual(baseline);
  for (const n of Object.values(diagnosticTimings!))
    expect(
      n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0),
    ).toBe(true);
  expect(timed).toMatchObject({
    providerQualified: false,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it('does not call a diagnostic option getter and preserves a refused request sequence', async () => {
  const f = await jitoRawResponseFixture();
  const send = transport(f, (rows) => {
    (rows[0] as { result: { context: { slot: bigint } } }).result.context.slot =
      102n;
    return rows;
  });
  const getter = vi.fn(() => true);
  const config = input(f, send);
  Object.defineProperty(config, 'diagnosticTiming', { get: getter });
  const result = await collectJitoCoherentPrefeeAttempt(config);
  expect(getter).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    status: 'refused',
    reason: 'fees-refused',
    signingAllowed: false,
  });
  expect(result).not.toHaveProperty('diagnosticTimings');
  expect(send).toHaveBeenCalledTimes(1);
});
it('retains completed timing phases on a mixed-bank refusal without an extra request', async () => {
  const f = await jitoRawResponseFixture();
  const send = transport(f, (rows) => {
    (rows[0] as { result: { context: { slot: bigint } } }).result.context.slot =
      102n;
    return rows;
  });
  const result = await collectJitoCoherentPrefeeAttempt(
    input(f, send, { diagnosticTiming: true }),
  );
  expect(result).toMatchObject({
    status: 'refused',
    reason: 'fees-refused',
    diagnosticTimings: { exactBuildMs: null },
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it('does not change admission or request count when the diagnostic clock throws', async () => {
  const f = await jitoRawResponseFixture();
  const send = transport(f);
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
    throw Error('untrusted clock error');
  });
  let result: Awaited<ReturnType<typeof collectJitoCoherentPrefeeAttempt>>;
  try {
    result = await collectJitoCoherentPrefeeAttempt(
      input(f, send, { diagnosticTiming: true }),
    );
  } finally {
    clock.mockRestore();
  }
  expect(result).toMatchObject({
    status: 'captured',
    diagnosticTimings: {
      batchBodyReadAndParseMs: null,
      discoveryParseMs: null,
      feeValidationMs: null,
      exactBuildMs: null,
    },
    signingAllowed: false,
  });
  expect(send).toHaveBeenCalledTimes(2);
});
for (const [side, wallets, token2022, lookup] of [
  ['Buy', 1, false, false],
  ['Sell', 2, true, true],
  ['Buy', 3, true, true],
  ['Sell', 4, false, true],
] as const) {
  it(`preserves exact bank and wire member proof ${side}/${wallets}/${token2022}/${lookup}`, async () => {
    const f = await jitoRawResponseFixture({
      side,
      wallets,
      token2022,
      lookup,
    });
    const send = transport(f);
    const result = await collectJitoCoherentPrefeeAttempt(input(f, send));
    expect(result.status).toBe('captured');
    if (
      result.status !== 'captured' ||
      result.batch?.status !== 'captured' ||
      result.simulation?.status !== 'admitted'
    )
      throw Error('Expected exact same-bank evidence.');
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0][0],
      second = send.mock.calls[1][0];
    expect(first.phase).toBe('discovery-batch');
    expect(first.methodCount).toBe(wallets + 2);
    expect(second.phase).toBe('exact');
    expect(second.methodCount).toBe(1);
    const rows = JSON.parse(first.body),
      request = JSON.parse(second.body);
    expect(rows.at(-1).params[1].simulationBank).toEqual({
      commitment: { commitment: 'confirmed' },
    });
    expect(
      rows
        .slice(0, -1)
        .every(
          (r: { params: [unknown, { minContextSlot: number }] }) =>
            r.params[1].minContextSlot === 100,
        ),
    ).toBe(true);
    expect(request.params[1].simulationBank).toEqual({ slot: 101 });
    expect(request.params[0].encodedTransactions).toEqual(
      f.policy.packets.map((p) => p.transaction),
    );
    expect(result.sentSimulationBody).toBe(second.body);
    expect(result.simulation.request.body).toBe(second.body);
    expect(result.discoverySource).toBe(
      'derived-batch-member-not-wire-response',
    );
    expect(result.feeProjection?.kind).toBe('derived-member-array-not-wire');
    expect(result.fees?.fees.map((f) => f.slot)).toEqual(
      Array(wallets + 1).fill(101),
    );
    for (const member of result.batch.members)
      expect(member.rawBody).toEqual(
        result.batch.rawResponse.rawBody.slice(member.start, member.end),
      );
    expect(result.simulation.frames.slot).toBe(101);
    expect(result).toMatchObject({
      providerQualified: false,
      signingAllowed: false,
      executionAllowed: false,
      economicOutputVerified: false,
    });
  });
}
for (const mutation of [
  'later-fees',
  'mixed-fees',
  'behind-fees',
  'null-fee',
  'string-fee',
  'zero-fee',
  'overcap',
  'failed-discovery',
  'partial',
  'reordered',
  'duplicate',
  'wrong-id',
  'discovery-429',
] as const) {
  it(`refuses ${mutation} before exact simulation`, async () => {
    const f = await jitoRawResponseFixture();
    const send = transport(f, (rows) => {
      const fee = rows[0] as {
        result: { context: { slot: bigint }; value: unknown };
      };
      if (mutation === 'later-fees')
        for (const r of rows.slice(0, -1))
          (r as typeof fee).result.context.slot = 102n;
      if (mutation === 'mixed-fees') fee.result.context.slot = 102n;
      if (mutation === 'behind-fees') fee.result.context.slot = 99n;
      if (mutation === 'null-fee') fee.result.value = null;
      if (mutation === 'string-fee') fee.result.value = '5000';
      if (mutation === 'zero-fee') fee.result.value = 0n;
      if (mutation === 'overcap') fee.result.value = (1n << 64n) - 1n;
      if (mutation === 'failed-discovery')
        (rows.at(-1) as F['envelope']).result.value.summary = 'failed';
      if (mutation === 'partial') rows.pop();
      if (mutation === 'reordered') rows.reverse();
      if (mutation === 'duplicate') rows[1] = rows[0];
      if (mutation === 'wrong-id') rows[0].id = 'unknown';
      if (mutation === 'discovery-429')
        rows[0] = { jsonrpc: '2.0', id: null, error: { code: 429n } } as never;
      return rows;
    });
    const result = await collectJitoCoherentPrefeeAttempt(input(f, send));
    expect(result.status).toBe('refused');
    if (mutation === 'discovery-429')
      expect(result).toMatchObject({ reason: 'rate-limited' });
    if (mutation === 'mixed-fees')
      expect(result).toMatchObject({
        reason: 'fees-refused',
        detail: 'discovery bank 101; observed fee banks 102,101',
      });
    if (mutation === 'later-fees')
      expect(result).toMatchObject({
        reason: 'fees-refused',
        detail: 'discovery bank 101; observed fee banks 102,102',
      });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.signingAllowed).toBe(false);
  });
}
it('only admits F+32 when every real fee and the exact result match, and refuses F+33 or F-1', async () => {
  const f = await jitoRawResponseFixture();
  expect(
    (
      await collectJitoCoherentPrefeeAttempt(
        input(f, transport(f), { minimumSlot: 69, minimumReadSlot: 69 }),
      )
    ).status,
  ).toBe('captured');
  for (const minimumSlot of [68, 102]) {
    const send = transport(f);
    expect(
      (
        await collectJitoCoherentPrefeeAttempt(
          input(f, send, { minimumSlot, minimumReadSlot: minimumSlot }),
        )
      ).status,
    ).toBe('refused');
    expect(send).toHaveBeenCalledTimes(1);
  }
});
it('refuses an exact response from a different bank without retrying', async () => {
  const f = await jitoRawResponseFixture();
  const send = vi.fn(async (r: Parameters<Input['transport']>[0]) => {
    if (r.phase === 'discovery-batch')
      return new Response(f.wire(batchRows(f, r)));
    const out = structuredClone(f.envelope);
    out.result.context.slot = 102n;
    return new Response(f.wire(out));
  });
  const result = await collectJitoCoherentPrefeeAttempt(input(f, send));
  expect(result.status).toBe('refused');
  expect(send).toHaveBeenCalledTimes(2);
});
for (const phase of ['discovery-batch', 'exact'] as const)
  it(`stops HTTP 429 at ${phase}`, async () => {
    const f = await jitoRawResponseFixture();
    const send = vi.fn(async (r: Parameters<Input['transport']>[0]) =>
      r.phase === phase
        ? new Response('private provider response', { status: 429 })
        : new Response(f.wire(batchRows(f, r))),
    );
    const result = await collectJitoCoherentPrefeeAttempt(input(f, send));
    expect(result).toMatchObject({ reason: 'rate-limited' });
    expect(send).toHaveBeenCalledTimes(phase === 'exact' ? 2 : 1);
  });
it('aborts a pending batch and cancels its late response without an exact read', async () => {
  const f = await jitoRawResponseFixture(),
    control = new AbortController();
  let resolve!: (response: Response) => void;
  const send = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const pending = collectJitoCoherentPrefeeAttempt(
    input(f, send, { signal: control.signal }),
  );
  while (!resolve) await new Promise<void>((done) => setImmediate(done));
  control.abort('private reason');
  const result = await pending;
  expect(result).toMatchObject({ reason: 'interrupted' });
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  resolve(response);
  await new Promise<void>((done) => setImmediate(done));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body!.locked).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
});
it('requires the additional read floor before dispatching the exact read', async () => {
  const f = await jitoRawResponseFixture();
  for (const floor of [99, 133, NaN]) {
    const send = transport(f);
    await expect(
      collectJitoCoherentPrefeeAttempt(
        input(f, send, { minimumReadSlot: floor }),
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  }
  const send = transport(f);
  expect(
    (
      await collectJitoCoherentPrefeeAttempt(
        input(f, send, { minimumReadSlot: 102 }),
      )
    ).status,
  ).toBe('refused');
  expect(send).toHaveBeenCalledTimes(1);
});
it('keeps signature mode while granting no signature authority', async () => {
  const f = await jitoRawResponseFixture();
  const send = transport(f);
  const result = await collectJitoCoherentPrefeeAttempt(
    input(f, send, { verifySignatures: true }),
  );
  expect(result.status).toBe('captured');
  const discovery = JSON.parse(send.mock.calls[0][0].body).at(-1);
  const exactRequest = JSON.parse(send.mock.calls[1][0].body);
  expect(discovery.params[1].skipSigVerify).toBe(false);
  expect(exactRequest.params[1].skipSigVerify).toBe(false);
  expect(result.signatureVerified).toBe(false);
});

it('binds one actual batch with independent fees and confirmed request bytes', async () => {
 const f = await jitoRawResponseFixture(), send = vi.fn(async (r: Parameters<Input['transport']>[0]) => new Response(f.wire(batchRows(f,r).map(row => row.id.endsWith(':discovery') ? {...f.envelope,id:row.id} : row))));
 const result = await collectJitoCoherentPrefeeAttempt(input(f, send, {singleBatch:true}));
 expect(result.status, 'single batch admission').toBe('captured');
 expect(send).toHaveBeenCalledTimes(1);
 if(result.status !== 'captured') throw Error('not captured');
 const request = JSON.parse(send.mock.calls[0][0].body).at(-1);
 expect(JSON.parse(result.simulation.request.body)).toEqual(request);
 expect(result.simulation.request).toHaveProperty('requestBankSelection','confirmed');
 expect(result).toHaveProperty('bankIdentityVerified',false);
 expect(result).toMatchObject({providerQualified:false,executionAllowed:false,signingAllowed:false});
});
it('single batch refuses independent fee bank drift without retry', async()=>{
 const f=await jitoRawResponseFixture(); const send=transport(f, rows=>{
 (rows[0] as {result:{context:{slot:bigint}}}).result.context.slot=102n;return rows;
 });
 const r=await collectJitoCoherentPrefeeAttempt(input(f,send,{singleBatch:true}));
 expect(r).toMatchObject({status:'refused',reason:'fees-refused'});expect(send).toHaveBeenCalledTimes(1);
});
it('single batch refuses a fee differing from the independent observation', async()=>{
 const f=await jitoRawResponseFixture();const send=transport(f, rows=>{
 (rows[0] as {result:{value:bigint}}).result.value=5001n;return rows;
 });
 const r=await collectJitoCoherentPrefeeAttempt(input(f,send,{singleBatch:true}));
 expect(r.status).toBe('refused');expect(send).toHaveBeenCalledTimes(1);
});
