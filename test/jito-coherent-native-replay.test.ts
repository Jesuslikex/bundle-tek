import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { collectJitoCoherentSimulationAttempt } from '../lib/jito-coherent-simulation-attempt';
import type { JitoBundleSimulationPacket } from '../lib/jito-bundle-simulation-frames';

const fixture = JSON.parse(
  readFileSync('test/fixtures/jito-coherent-native-20261024.json', 'utf8'),
) as {
  cases: {
    index: number;
    originalFloor: number;
    accountSlot: number;
    packets: JitoBundleSimulationPacket[];
    expectedStatus: string;
    expectedReason: string;
    bank: number | null;
    reads: {
      request: string;
      response: string;
      requestSha256: string;
      responseSha256: string;
    }[];
  }[];
};
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
for (const sample of fixture.cases)
  it(`replays retained public native attempt ${sample.index} without network or authority`, async () => {
    let reads = 0;
    const result = await collectJitoCoherentSimulationAttempt({
      packets: sample.packets,
      minimumSlot: sample.originalFloor,
      minimumReadSlot: sample.accountSlot,
      feeIdPrefix: `native-fees:${sample.index - 1}`,
      simulationRpcId: `native-exact:${sample.index - 1}`,
      verifySignatures: false,
      signal: new AbortController().signal,
      transport: async ({ body, methodCount, phase }) => {
        const retained = sample.reads[reads++];
        expect(retained).toBeDefined();
        expect(hash(retained.request)).toBe(retained.requestSha256);
        expect(hash(retained.response)).toBe(retained.responseSha256);
        expect(body).toBe(retained.request);
        expect(methodCount).toBe(phase === 'discovery' ? 1 : 3);
        return new Response(retained.response);
      },
    });
    expect(reads).toBe(2);
    expect(result.status).toBe(sample.expectedStatus);
    expect(result).toMatchObject({
      signingAllowed: false,
      executionAllowed: false,
      providerQualified: false,
      economicOutputVerified: false,
      runtimePrivilegesVerified: false,
      minimumSlot: sample.originalFloor,
    });
    if (result.status === 'captured') {
      expect(result.simulation.frames.slot).toBe(sample.bank);
      expect(result.fees.fees.every((fee) => fee.slot === sample.bank)).toBe(
        true,
      );
      expect(
        result.simulation.frames.slot - sample.originalFloor,
      ).toBeLessThanOrEqual(32);
    } else {
      expect(result.reason).toBe(sample.expectedReason);
      expect(result.reason).toBe('fees-refused');
      expect(result.simulation).toBeNull();
    }
  });
