import { expect, it } from 'vitest';
import { readJitoSimulationJson } from '../lib/jito-simulation-json';
import { verifyJitoBundleEconomicObservation } from '../lib/jito-bundle-economics';
import { jitoSequentialEconomicsFixture } from './jito-sequential-economics-fixture';

function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 13));
      offset = Math.min(offset + 13, bytes.length);
    },
  });
}
// The fixture models the stronger normalized frame contract, not a vendor profile.
// Use unquoted integer wire tokens as a real RPC response does.
const wire = (value: unknown) =>
  JSON.stringify(value).replace(
    /"(lamports|fee|loadedAccountsDataSize)":"(\d+)"/g,
    '"$1":$2',
  );

// Test-only projection for the synthetic normalized fixture. A real vendor
// adapter still needs its own exact raw schema, metadata and source admission.
function fixtureIntegers(value: unknown) {
  const raw = value as {
    context: { slot: unknown };
    value: { summary: unknown; transactionResults: Record<string, unknown>[] };
  };
  const integer = (v: unknown) => {
    if (typeof v !== 'bigint' || v < 0n || v > (1n << 64n) - 1n)
      throw Error('Raw fixture integer type or range differs.');
    return v.toString();
  };
  const safe = (v: unknown) => {
    const digits = integer(v);
    if (BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER))
      throw Error('Raw fixture integer exceeds safe range.');
    return Number(digits);
  };
  const accounts = (v: unknown) =>
    (v as (Record<string, unknown> | null)[]).map((a) =>
      a === null ? null : { ...a, lamports: integer(a.lamports) },
    );
  return {
    context: { slot: safe(raw.context.slot) },
    value: {
      summary: raw.value.summary,
      transactionResults: raw.value.transactionResults.map((frame) => ({
        ...frame,
        fee: integer(frame.fee),
        unitsConsumed: safe(frame.unitsConsumed),
        loadedAccountsDataSize: integer(frame.loadedAccountsDataSize),
        preExecutionAccounts: accounts(frame.preExecutionAccounts),
        postExecutionAccounts: accounts(frame.postExecutionAccounts),
      })),
    },
  };
}

for (const side of ['Buy', 'Sell'] as const)
  for (const token2022 of [false, true])
    it(`replays exact integer streamed ${side} ${token2022 ? '2022' : 'SPL'} frames without granting authority`, async () => {
      const fixture = await jitoSequentialEconomicsFixture({
        side,
        token2022,
        wallets: 2,
        lookup: true,
      });
      const encoded = wire(fixture.result);
      expect(encoded).not.toBe(JSON.stringify(fixture.result));
      expect(encoded).toContain('"fee":5000');
      expect(encoded).toContain('"lamports":100000000');
      expect(encoded).toContain('"slot":101');
      expect(encoded).toContain('"unitsConsumed":');
      const result = fixtureIntegers(
        await readJitoSimulationJson(
          stream(encoded),
          new AbortController().signal,
        ),
      );
      const replay = await verifyJitoBundleEconomicObservation({
        ...fixture,
        result,
      });
      expect(replay.outcomes.map((o) => o.observedOutputRaw)).toEqual([
        side === 'Buy' ? '1000' : '1000000',
        side === 'Buy' ? '1000' : '1000000',
      ]);
      expect(replay.networkFeeLamports).toBe('15000');
      expect(replay).toMatchObject({
        frameEconomicChecksPassed: true,
        providerQualified: false,
        signingAllowed: false,
        executionAllowed: false,
        receiptVerified: false,
      });
    });

it('refuses an escaped duplicate fee before any economic replay can accept the last value', async () => {
  const fixture = await jitoSequentialEconomicsFixture();
  const raw = wire(fixture.result).replace(
    '"fee":5000',
    '"fee":9999,"f\\u0065e":5000',
  );
  expect(raw).not.toBe(wire(fixture.result));
  await expect(
    readJitoSimulationJson(stream(raw), new AbortController().signal),
  ).rejects.toThrow('duplicate object key');
});

for (const field of ['fee', 'slot'])
  it(`refuses a quoted ${field} token instead of silently admitting it as a wire number`, async () => {
    const fixture = await jitoSequentialEconomicsFixture();
    const raw = wire(fixture.result).replace(
      field === 'fee' ? '"fee":5000' : '"slot":101',
      field === 'fee' ? '"fee":"5000"' : '"slot":"101"',
    );
    const parsed = await readJitoSimulationJson(
      stream(raw),
      new AbortController().signal,
    );
    expect(() => fixtureIntegers(parsed)).toThrow('integer type or range');
  });

it('keeps numeric account data distinct from strings rather than turning it into valid base64', async () => {
  const fixture = await jitoSequentialEconomicsFixture();
  const raw = wire(fixture.result).replace(
    '"data":["","base64"]',
    '"data":[1234,"base64"]',
  );
  expect(raw).not.toBe(wire(fixture.result));
  const parsed = await readJitoSimulationJson(
    stream(raw),
    new AbortController().signal,
  );
  await expect(
    verifyJitoBundleEconomicObservation({
      ...fixture,
      result: fixtureIntegers(parsed),
    }),
  ).rejects.toThrow('non-JSON input');
});

it('refuses a fractional lamport token that ordinary JSON would round to the approved balance', async () => {
  const fixture = await jitoSequentialEconomicsFixture();
  const raw = wire(fixture.result).replace(
    '"lamports":100000000',
    '"lamports":100000000.0000000001',
  );
  expect(raw).not.toBe(wire(fixture.result));
  expect(JSON.parse('100000000.0000000001')).toBe(100000000);
  await expect(
    readJitoSimulationJson(stream(raw), new AbortController().signal),
  ).rejects.toThrow('noncanonical integer');
});
