import { expect, it, vi } from 'vitest';
import { jitoRawResponseFixture } from '../test/jito-raw-response-fixture';
import {
  collectJitoCoherentPrefeeAttempt,
  collectJitoProviderObservedAttempt,
} from './jito-coherent-prefee-attempt';

const fee = (v: unknown) =>
  v as { result: { context: { slot: bigint }; value: bigint } };
const simulation = (v: unknown) =>
  v as Awaited<ReturnType<typeof jitoRawResponseFixture>>['envelope'];

async function fixture(change?: (rows: unknown[]) => void) {
  const f = await jitoRawResponseFixture();
  const transport = vi.fn(async (r: { body: string }) => {
    const requests = JSON.parse(r.body);
    const rows = requests.map((m: { method: string; id: string }) =>
      m.method === 'getFeeForMessage'
        ? {
            jsonrpc: '2.0',
            id: m.id,
            result: { context: { slot: 102n }, value: 5000n },
          }
        : { ...f.envelope, id: m.id },
    );
    change?.(rows);
    return new Response(f.wire(rows));
  });
  return {
    transport,
    input: {
      packets: structuredClone(f.policy.packets),
      minimumSlot: 100,
      minimumReadSlot: 100,
      feeIdPrefix: 'observed',
      simulationRpcId: 'observed-sim',
      verifySignatures: false,
      signal: new AbortController().signal,
      transport,
      singleBatch: true as const,
    },
  };
}

it('captures distinct fresh fee/simulation contexts only through the separate unsigned profile', async () => {
  const f = await fixture();
  const strict = await collectJitoCoherentPrefeeAttempt(f.input);
  expect(strict).toMatchObject({ status: 'refused', reason: 'fees-refused' });
  const observed = await collectJitoProviderObservedAttempt(f.input);
  expect(observed).toMatchObject({
    status: 'captured',
    diagnosticProfile: 'provider-observed-jito-v1',
    providerTrustRequired: true,
    bankIdentityVerified: false,
    feeBankIdentityVerified: false,
    providerQualified: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(f.transport).toHaveBeenCalledTimes(2);
  for (const [request] of f.transport.mock.calls) {
    const members = JSON.parse(request.body);
    expect(members.at(-1).params[1]).toMatchObject({
      simulationBank: { commitment: { commitment: 'confirmed' } },
      replaceRecentBlockhash: false,
      skipSigVerify: true,
    });
    expect(
      members.filter((m: { method: string }) => m.method === 'simulateBundle'),
    ).toHaveLength(1);
  }
  expect(observed.fees?.status).toBe('observed');
  expect(observed.fees?.fees[0].slot).toBe(102);
});

for (const [name, change] of [
  [
    'different fee amount',
    (r: unknown[]) => {
      fee(r[0]).result.value = 5001n;
    },
  ],
  [
    'fee over cap',
    (r: unknown[]) => {
      fee(r[0]).result.value = 999999999n;
    },
  ],
  [
    'stale fee',
    (r: unknown[]) => {
      fee(r[0]).result.context.slot = 99n;
    },
  ],
  [
    'fee beyond window',
    (r: unknown[]) => {
      fee(r[0]).result.context.slot = 133n;
    },
  ],
  [
    'simulation beyond window',
    (r: unknown[]) => {
      simulation(r.at(-1)).result.context.slot = 133n;
    },
  ],
  [
    'partial frames',
    (r: unknown[]) => {
      simulation(r.at(-1)).result.value.transactionResults.pop();
    },
  ],
  [
    'missing account',
    (r: unknown[]) => {
      simulation(
        r.at(-1),
      ).result.value.transactionResults[0].postExecutionAccounts.pop();
    },
  ],
  [
    'replacement hash',
    (r: unknown[]) => {
      Object.assign(simulation(r.at(-1)).result.value.transactionResults[0], {
        replacementBlockhash: {
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 999n,
        },
      });
    },
  ],
  [
    'rpc rate limit',
    (r: unknown[]) => {
      r[0] = {
        jsonrpc: '2.0',
        id: (r[0] as { id: string }).id,
        error: { code: 429n, message: 'rate limited' },
      };
    },
  ],
] as const)
  it(`refuses ${name} without retry`, async () => {
    const f = await fixture(change);
    const result = await collectJitoProviderObservedAttempt(f.input);
    expect(result).toMatchObject({
      status: 'refused',
      bankIdentityVerified: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

it('refuses signed verification mode before requesting transport', async () => {
  const f = await fixture();
  await expect(
    collectJitoProviderObservedAttempt({ ...f.input, verifySignatures: true }),
  ).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
});

it('refuses a packet containing signature bytes before transport', async () => {
  const f = await fixture();
  const packet = Buffer.from(f.input.packets[0].transaction, 'base64');
  packet[1] = 1;
  f.input.packets[0].transaction = packet.toString('base64');
  const result = await collectJitoProviderObservedAttempt(f.input);
  expect(result).toMatchObject({
    status: 'refused',
    reason: 'plan-refused',
    signingAllowed: false,
  });
  expect(f.transport).not.toHaveBeenCalled();
});
