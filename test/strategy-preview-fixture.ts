import { strategyCheckFixture, checkHoldId } from './strategy-check-fixture';
import { buildStrategyCandidateCheck } from '../lib/strategy-candidate-check';
import { buildStrategyUnsignedPreview } from '../lib/strategy-unsigned-preview';
export async function strategyPreviewFixture() {
  const fixture = await strategyCheckFixture('DCA');
  const at = fixture.draft.plan.input.startAt;
  const checks = buildStrategyCandidateCheck(
    fixture.draft,
    fixture.capacity,
    checkHoldId,
    at,
    null,
  );
  const evidence = {
    quote: {
      sha256: 'a'.repeat(64),
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: fixture.draft.plan.token.address,
      inputRaw: checks.unitsRaw,
      quotedOutputRaw: '1000',
      minimumOutputRaw: '995',
      slippageBps: 50,
      platformFeeBps: 0,
      platformFeeMint: null,
      quotedAt: at,
      expiresAt: new Date(Date.parse(at) + 30000).toISOString(),
    },
    balance: {
      nativeRaw: '1000000000',
      observedAt: at,
      expiresAt: new Date(Date.parse(at) + 60000).toISOString(),
      nativeSlot: 100,
    },
    simulation: {
      observedAt: at,
      slot: 101,
      networkFeeLamports: '5000',
      maximumRentLamports: '2039280',
      maximumNativeDebitLamports: (
        BigInt(checks.unitsRaw) + 2044280n
      ).toString(),
    },
  };
  const preview = await buildStrategyUnsignedPreview(
    checks,
    null,
    evidence,
    at,
  );
  return { ...fixture, preview, evidence, at };
}
