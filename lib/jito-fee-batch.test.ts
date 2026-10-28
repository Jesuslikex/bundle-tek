import { createHash } from 'node:crypto';
import { getBase64Decoder, getTransactionDecoder } from '@solana/kit';
import { expect, it, vi } from 'vitest';
import {
  jitoRawResponseFixture,
  rawNumberToken,
} from '../test/jito-raw-response-fixture';
import {
  buildJitoFeeBatchRequest,
  readJitoFeeBatchResponse,
} from './jito-fee-batch';
import { readJitoSimulationResponse } from './jito-simulation-response';
const signal = () => new AbortController().signal;
const hash = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
type Plan = Awaited<ReturnType<typeof buildJitoFeeBatchRequest>>;
type Fixture = Awaited<ReturnType<typeof jitoRawResponseFixture>>;
function replies(plan: Plan, slot = 101n, fee: unknown = 5000n) {
  return (JSON.parse(plan.body) as { id: string }[]).map(({ id }) => ({
    jsonrpc: '2.0',
    id,
    result: { context: { slot }, value: fee },
  }));
}
async function setup() {
  const f = await jitoRawResponseFixture({
    lookup: true,
    token2022: true,
    wallets: 2,
  });
  const plan = await buildJitoFeeBatchRequest({
    packets: f.policy.packets,
    minimumSlot: 100,
    idPrefix: 'fees-test',
  });
  return { f, plan };
}
async function refuse(
  change: (rows: ReturnType<typeof replies>, f: Fixture, plan: Plan) => unknown,
) {
  const { f, plan } = await setup(),
    rows = replies(plan);
  const replacement = change(rows, f, plan);
  const output = await readJitoFeeBatchResponse(
    plan,
    f.body(replacement === undefined ? rows : replacement),
    signal(),
  );
  expect(output.status).toBe('refused');
  expect(output.signingAllowed).toBe(false);
  expect(output.executionAllowed).toBe(false);
  expect(output.providerQualified).toBe(false);
  return output;
}
it('freezes a canonical packet-bound batch with exact ordered message bytes and a stable request hash', async () => {
  const f = await jitoRawResponseFixture({ lookup: true, wallets: 4 }),
    packets = structuredClone(f.policy.packets),
    original = structuredClone(packets);
  const promise = buildJitoFeeBatchRequest({
    packets,
    minimumSlot: 100,
    idPrefix: 'captured',
  });
  packets[0].transaction = f.fixture.manifest.tip.transaction;
  packets[0].maximumFeeLamports = '1';
  const plan = await promise;
  expect(Object.isFrozen(plan)).toBe(true);
  expect(plan.profile).toBe('jito-fee-batch-v1');
  expect(plan.packetCount).toBe(5);
  expect(plan.minimumSlot).toBe(100);
  expect(plan.sha256).toBe(hash(plan.body));
  const body = JSON.parse(plan.body);
  expect(body).toEqual(
    original.map((p, i) => ({
      jsonrpc: '2.0',
      id: `captured:${i}`,
      method: 'getFeeForMessage',
      params: [
        getBase64Decoder().decode(
          getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'))
            .messageBytes,
        ),
        { commitment: 'confirmed', minContextSlot: 100 },
      ],
    })),
  );
  const output = await readJitoFeeBatchResponse(
    plan,
    f.body(replies(plan)),
    signal(),
  );
  expect(output.status).toBe('observed');
  if (output.status !== 'observed') throw Error(output.reason);
  expect(output.packets.map((p) => p.transaction)).toEqual(
    original.map((p) => p.transaction),
  );
});
it('retains actual response bytes/hash and derives fee packets without source or execution authority', async () => {
  const { f, plan } = await setup(),
    rows = replies(plan),
    wire = f.wire(rows);
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(Error('network forbidden'));
  try {
    const output = await readJitoFeeBatchResponse(plan, f.body(rows), signal());
    expect(output.status).toBe('observed');
    if (output.status !== 'observed') throw Error(output.reason);
    expect(output.simulationBankSlot).toBe(101);
    expect(output.feeBankCoherent).toBe(true);
    expect(output.plan).toBe(plan);
    expect(output.rawResponse.rawSha256).toBe(hash(wire));
    expect(output.rawResponse.rawBody).toEqual(new TextEncoder().encode(wire));
    expect(output.fees).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const bytes = getTransactionDecoder().decode(
        Buffer.from(f.policy.packets[i].transaction, 'base64'),
      ).messageBytes;
      expect(output.fees[i]).toEqual({
        packet: i,
        messageSha256: hash(Uint8Array.from(bytes)),
        feeLamports: '5000',
        slot: 101,
      });
      expect(output.packets[i]).toEqual({
        ...f.policy.packets[i],
        loadedAddresses: f.policy.packets[i].loadedAddresses ?? {
          writable: [],
          readonly: [],
        },
        expectedFeeLamports: '5000',
      });
    }
    expect(output).toMatchObject({
      providerQualified: false,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
it('uses observed fees rather than assuming stale expected fee metadata remains current', async () => {
  const f = await jitoRawResponseFixture();
  const packets = structuredClone(f.policy.packets);
  packets.forEach((p) => (p.expectedFeeLamports = '1'));
  const plan = await buildJitoFeeBatchRequest({
    packets,
    minimumSlot: 100,
    idPrefix: 'fresh',
  });
  const output = await readJitoFeeBatchResponse(
    plan,
    f.body(replies(plan)),
    signal(),
  );
  expect(output.status).toBe('observed');
  if (output.status !== 'observed') throw Error(output.reason);
  expect(output.packets.map((p) => p.expectedFeeLamports)).toEqual([
    '5000',
    '5000',
  ]);
  expect(packets.map((p) => p.expectedFeeLamports)).toEqual(['1', '1']);
  expect(output.packets.map((p) => p.maximumFeeLamports)).toEqual([
    '5000',
    '5000',
  ]);
  expect(output.signingAllowed).toBe(false);
});
for (const slot of [100n, 132n])
  it(`admits one coherent actual fee bank ${slot} within the bounded floor`, async () => {
    const { f, plan } = await setup();
    const output = await readJitoFeeBatchResponse(
      plan,
      f.body(replies(plan, slot)),
      signal(),
    );
    expect(output.status).toBe('observed');
    if (output.status === 'observed')
      expect(output.simulationBankSlot).toBe(Number(slot));
  });
for (const variant of [
  'reorder',
  'partial',
  'extra',
  'duplicate',
  'wrong-id',
  'numeric-id',
  'quoted-fee',
  'fraction',
  'null-fee',
  'zero-fee',
  'over-cap',
  'overflow-u64',
  'below-floor',
  'above-span',
  'mixed-bank',
  'quoted-slot',
  'unknown-envelope',
  'unknown-result',
  'unknown-context',
  'rpc-error',
])
  it(`refuses fee source ${variant}`, async () =>
    refuse((rows) => {
      const first = rows[0] as unknown as Record<string, unknown>;
      if (variant === 'reorder') rows.reverse();
      if (variant === 'partial') rows.pop();
      if (variant === 'extra') rows.push(rows[0]);
      if (variant === 'duplicate') rows[1] = { ...rows[1], id: rows[0].id };
      if (variant === 'wrong-id') rows[0].id = 'another:0';
      if (variant === 'numeric-id') first.id = 0n;
      if (variant === 'quoted-fee') rows[0].result.value = '5000';
      if (variant === 'fraction')
        rows[0].result.value = rawNumberToken('5000.0000000001');
      if (variant === 'null-fee') rows[0].result.value = null;
      if (variant === 'zero-fee') rows[0].result.value = 0n;
      if (variant === 'over-cap') rows[0].result.value = 5001n;
      if (variant === 'overflow-u64')
        rows[0].result.value = 18446744073709551616n;
      if (variant === 'below-floor')
        rows.forEach((r) => (r.result.context.slot = 99n));
      if (variant === 'above-span')
        rows.forEach((r) => (r.result.context.slot = 133n));
      // A one-slot member spread is accepted; two is not.
      if (variant === 'mixed-bank') rows[1].result.context.slot = 103n;
      if (variant === 'quoted-slot')
        Object.assign(rows[0].result.context, { slot: '101' });
      if (variant === 'unknown-envelope')
        Object.assign(first, { surprise: true });
      if (variant === 'unknown-result')
        Object.assign(rows[0].result, { surprise: true });
      if (variant === 'unknown-context')
        Object.assign(rows[0].result.context, { surprise: true });
      if (variant === 'rpc-error') {
        delete first.result;
        first.error = { code: -32000n, message: 'Synthetic RPC refusal.' };
      }
    }));
it('refuses null/non-array batch responses and escaped duplicate fee fields', async () => {
  for (const raw of [null, {}, 'not a batch']) await refuse(() => raw);
  const { f, plan } = await setup(),
    wire = f
      .wire(replies(plan))
      .replace('"value":5000', '"value":9999,"v\\u0061lue":5000');
  const output = await readJitoFeeBatchResponse(
    plan,
    new Response(wire).body,
    signal(),
  );
  expect(output.status).toBe('refused');
});
it('rejects fake or cloned plans before acquiring or consuming any stream', async () => {
  const { plan } = await setup();
  for (const candidate of [{ ...plan }, JSON.parse(JSON.stringify(plan))]) {
    const pull = vi.fn(),
      stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    await expect(
      readJitoFeeBatchResponse(candidate as Plan, stream, signal()),
    ).rejects.toThrow(/plan/);
    expect(pull).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  }
});
it('refuses invalid packet selections and invalid request identity/floor before producing a plan', async () => {
  const { f } = await setup();
  for (const packets of [
    [],
    [f.policy.packets[0]],
    Array.from({ length: 6 }, () => f.policy.packets[0]),
    [f.policy.packets[0], f.policy.packets[0]],
  ])
    await expect(
      buildJitoFeeBatchRequest({ packets, minimumSlot: 100, idPrefix: 'bad' }),
    ).rejects.toThrow();
  for (const minimumSlot of [-1, NaN, Number.MAX_SAFE_INTEGER + 1])
    await expect(
      buildJitoFeeBatchRequest({
        packets: f.policy.packets,
        minimumSlot,
        idPrefix: 'bad',
      }),
    ).rejects.toThrow();
  await expect(
    buildJitoFeeBatchRequest({
      packets: f.policy.packets,
      minimumSlot: 100,
      idPrefix: '',
    }),
  ).rejects.toThrow();
});
it('cancels a pending body without partial success or leaking a private abort reason', async () => {
  const { plan } = await setup(),
    controller = new AbortController(),
    cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        return new Promise<void>(() => {});
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const promise = readJitoFeeBatchResponse(plan, body, controller.signal);
  controller.abort(Error('https://private.invalid/?key=FAKE_FEE_ABORT_SECRET'));
  const output = await promise;
  expect(output.status).toBe('refused');
  if (output.status === 'refused')
    expect(output.reason).not.toContain('FAKE_FEE_ABORT_SECRET');
  expect(output.rawResponse).toBeNull();
  expect(body.locked).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
});
it('feeds coherent fee-derived packets into the real raw simulation adapter without bypassing original caps', async () => {
  const { f, plan } = await setup(),
    fees = await readJitoFeeBatchResponse(
      plan,
      f.body(replies(plan)),
      signal(),
    );
  expect(fees.status).toBe('observed');
  if (fees.status !== 'observed') throw Error(fees.reason);
  const simulation = await readJitoSimulationResponse({
    ...f.policy,
    packets: fees.packets,
    simulationBankSlot: fees.simulationBankSlot,
    body: f.body(),
    signal: signal(),
  });
  expect(simulation.status).toBe('admitted');
  expect(simulation.signingAllowed).toBe(false);
  expect(simulation.providerQualified).toBe(false);
});

it('retains only earlier safe observations when a later response fails without selecting a coherent bank', async () => {
  const { f, plan } = await setup(),
    rows = replies(plan);
  rows[1].result.value = null;
  const output = await readJitoFeeBatchResponse(plan, f.body(rows), signal());
  expect(output.status).toBe('refused');
  expect(output.fees).toEqual([
    {
      packet: 0,
      messageSha256: hash(
        Uint8Array.from(
          getTransactionDecoder().decode(
            Buffer.from(f.policy.packets[0].transaction, 'base64'),
          ).messageBytes,
        ),
      ),
      feeLamports: '5000',
      slot: 101,
    },
  ]);
  expect(output).not.toHaveProperty('simulationBankSlot');
  expect(output).not.toHaveProperty('packets');
  expect(output.signingAllowed).toBe(false);
});
it('refuses a missing body without invented fee observations or raw evidence', async () => {
  const { plan } = await setup(),
    output = await readJitoFeeBatchResponse(plan, null, signal());
  expect(output.status).toBe('refused');
  expect(output.fees).toEqual([]);
  expect(output.rawResponse).toBeNull();
});

it.each(['aborted', 'forged'] as const)(
  'leaves an unacquired body untouched for a %s signal',
  async (kind) => {
    const { f, plan } = await setup();
    const body = f.body(replies(plan));
    const controller = new AbortController();
    controller.abort();
    const supplied =
      kind === 'aborted' ? controller.signal : ({} as AbortSignal);
    await expect(
      readJitoFeeBatchResponse(plan, body, supplied),
    ).rejects.toThrow('fee read interrupted or signal invalid');
    expect(body.locked).toBe(false);
    expect((await body.getReader().read()).done).toBe(false);
  },
);
it('refuses simultaneous result and error with the exact envelope diagnosis', async () => {
  const output = await refuse((rows) => {
    Object.assign(rows[0], { error: { code: -32602n, message: 'invalid' } });
  });
  expect(output.status === 'refused' && output.reason).toBe(
    'fee batch reply mapping differs',
  );
});
it('refuses an out-of-range RPC error code with the exact shape diagnosis', async () => {
  const output = await refuse((rows) =>
    rows.map((row) => ({
      jsonrpc: row.jsonrpc,
      id: row.id,
      error: { code: 2147483648n, message: 'invalid' },
    })),
  );
  expect(output.status === 'refused' && output.reason).toBe(
    'fee RPC error shape differs',
  );
});
it('accepts bounded API version metadata without treating it as source authentication', async () => {
  const { f, plan } = await setup();
  const rows = replies(plan);
  for (const row of rows)
    Object.assign(row.result.context, { apiVersion: '3.0.6' });
  const output = await readJitoFeeBatchResponse(plan, f.body(rows), signal());
  expect(output.status).toBe('observed');
  expect(output.sourceAuthenticated).toBe(false);
});
