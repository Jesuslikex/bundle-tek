import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { jitoRawResponseFixture } from '../test/jito-raw-response-fixture';
import { buildJitoBundleSimulationRequest } from './jito-bundle-simulation-frames';
import { readJitoSameBankPrototype } from './jito-same-bank-prototype';

async function fixture() {
  const f = await jitoRawResponseFixture({ wallets: 2, lookup: true });
  const p = await buildJitoBundleSimulationRequest(f.policy.packets, 101, {
    bankEncoding: 'slot-object',
    verifySignatures: false,
  });
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: f.policy.rpcId,
    method: 'simulateBundleWithSameBankFees',
    params: p.params,
  });
  const response = {
    jsonrpc: '2.0',
    id: f.policy.rpcId,
    result: {
      context: f.envelope.result.context,
      value: {
        bankHash: bs58.encode(new Uint8Array(32).fill(1)),
        independentFees: p.packetBindings.map((v) =>
          BigInt(v.expectedFeeLamports),
        ),
        packetHashes: p.packetBindings.map((v) =>
          bs58.encode(
            createHash('sha256')
              .update(Buffer.from(v.transaction, 'base64'))
              .digest(),
          ),
        ),
        simulation: f.envelope.result.value,
      },
    },
  };
  const run = (raw = f.wire(response), sent = requestBody, min = 100) =>
    readJitoSameBankPrototype({
      packets: f.policy.packets,
      minimumSlot: min,
      simulationBankSlot: 101,
      rpcId: f.policy.rpcId,
      requestBody: sent,
      body: new Response(raw).body,
      signal: new AbortController().signal,
    });
  return { f, response, requestBody, run };
}
describe('local same-bank prototype evidence', () => {
  it('binds ordered packet bytes and independent fees, then reuses the frame verifier without granting authority', async () => {
    const x = await fixture();
    const result = await x.run();
    expect(result.simulation.status).toBe('admitted');
    expect(result).toMatchObject({
      projection: 'derived-json-not-provider-wire',
      bankIdentityVerified: false,
      sourceAuthenticated: false,
      providerQualified: false,
      signingAllowed: false,
      executionAllowed: false,
    });
    expect(Buffer.from(result.raw.rawBody).toString()).toBe(
      x.f.wire(x.response),
    );
  });
  it.each([
    'request',
    'hash',
    'order',
    'fee',
    'bank',
    'slot',
    'frame',
    'duplicate',
  ] as const)('refuses changed %s', async (change) => {
    const x = await fixture();
    let sent = x.requestBody;
    if (change === 'request') sent += ' ';
    if (change === 'hash')
      x.response.result.value.packetHashes[0] = bs58.encode(
        new Uint8Array(32).fill(2),
      );
    if (change === 'order') x.response.result.value.packetHashes.reverse();
    if (change === 'fee') x.response.result.value.independentFees[0] += 1n;
    if (change === 'bank') x.response.result.value.bankHash = 'not-a-hash';
    if (change === 'slot') x.response.result.context.slot = 102n;
    if (change === 'frame')
      x.response.result.value.simulation.transactionResults[0].fee += 1n;
    let raw = x.f.wire(x.response);
    if (change === 'duplicate')
      raw = raw.replace('"jsonrpc":"2.0"', '"jsonrpc":"2.0","jsonrpc":"2.0"');
    await expect(x.run(raw, sent)).rejects.toThrow();
  });
  it('keeps the 32-slot limit', async () => {
    const x = await fixture();
    await expect(x.run(undefined, undefined, 68)).rejects.toThrow();
  });
});
