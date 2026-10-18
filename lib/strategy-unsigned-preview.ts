import {
  capacityDate,
  capacityDigest,
  capacityKeys,
} from './strategy-review-capacity';
import type { StrategyCandidateCheck } from './strategy-candidate-check';
import { walletAddress } from './wallet-workspace';

export function requirePreviewCondition(
  check: StrategyCandidateCheck,
  pool: string | null,
) {
  if (check.status === 'dca-due' && pool === null) return;
  if (
    check.status === 'market-observed' &&
    typeof pool === 'string' &&
    check.pools.some((p) => p.address === pool && p.condition === 'met')
  )
    return;
  throw Error('Choose a currently met Limit pool, or a due DCA cycle.');
}
const uint = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw Error('Preview amount differs.');
  return v;
};
export type StrategyPreviewEvidence = {
  quote: {
    sha256: string;
    inputMint: string;
    outputMint: string;
    inputRaw: string;
    quotedOutputRaw: string;
    minimumOutputRaw: string;
    slippageBps: number;
    platformFeeBps: number;
    platformFeeMint: string | null;
    quotedAt: string;
    expiresAt: string;
  };
  balance: {
    nativeRaw: string;
    observedAt: string;
    expiresAt: string;
    nativeSlot: number;
  };
  simulation: {
    observedAt: string;
    slot: number;
    networkFeeLamports: string;
    maximumRentLamports: string;
    maximumNativeDebitLamports: string;
  };
};
export async function buildStrategyUnsignedPreview(
  checks: StrategyCandidateCheck,
  conditionPool: string | null,
  evidence: StrategyPreviewEvidence,
  previewedAt: string,
  startedAt = previewedAt,
) {
  requirePreviewCondition(checks, conditionPool);
  capacityKeys(evidence, 'balance,quote,simulation');
  capacityKeys(
    evidence.quote,
    'expiresAt,inputMint,inputRaw,minimumOutputRaw,outputMint,platformFeeBps,platformFeeMint,quotedAt,quotedOutputRaw,sha256,slippageBps',
  );
  capacityKeys(evidence.balance, 'expiresAt,nativeRaw,nativeSlot,observedAt');
  capacityKeys(
    evidence.simulation,
    'maximumNativeDebitLamports,maximumRentLamports,networkFeeLamports,observedAt,slot',
  );
  const q = evidence.quote,
    b = evidence.balance,
    s = evidence.simulation;
  const now = Date.parse(previewedAt),
    native = 'So11111111111111111111111111111111111111112';
  if (
    !capacityDate(previewedAt) ||
    !capacityDate(startedAt) ||
    Date.parse(startedAt) > now ||
    now - Date.parse(startedAt) > 25000 ||
    !/^[a-f0-9]{64}$/.test(q.sha256) ||
    [q.quotedAt, q.expiresAt, b.observedAt, b.expiresAt, s.observedAt].some(
      (t) => !capacityDate(t),
    ) ||
    [checks.checkedAt, q.quotedAt, b.observedAt, s.observedAt].some(
      (t) => Date.parse(t) > now || now - Date.parse(t) >= 30000,
    ) ||
    q.inputRaw !== checks.unitsRaw ||
    !BigInt(uint(q.inputRaw)) ||
    !BigInt(uint(q.minimumOutputRaw)) ||
    BigInt(uint(q.minimumOutputRaw)) > BigInt(uint(q.quotedOutputRaw)) ||
    BigInt(q.minimumOutputRaw) < (BigInt(q.quotedOutputRaw) * 9950n) / 10000n ||
    !Number.isInteger(q.slippageBps) ||
    q.slippageBps !== 50 ||
    !Number.isInteger(q.platformFeeBps) ||
    q.platformFeeBps < 0 ||
    q.platformFeeBps > 50 ||
    (q.platformFeeBps === 0
      ? q.platformFeeMint !== null
      : ![q.inputMint, q.outputMint].includes(q.platformFeeMint ?? '')) ||
    q.inputMint === q.outputMint ||
    walletAddress(q.inputMint, 'Solana') !== q.inputMint ||
    walletAddress(q.outputMint, 'Solana') !== q.outputMint ||
    (checks.side === 'Buy'
      ? q.inputMint !== native
      : q.outputMint !== native) ||
    !Number.isSafeInteger(b.nativeSlot) ||
    b.nativeSlot < 0 ||
    !Number.isSafeInteger(s.slot) ||
    s.slot < b.nativeSlot ||
    s.slot - b.nativeSlot > 64 ||
    BigInt(uint(s.maximumNativeDebitLamports)) > BigInt(uint(b.nativeRaw)) ||
    BigInt(uint(s.networkFeeLamports)) > 1000000n ||
    BigInt(uint(s.maximumRentLamports)) >
      BigInt(s.maximumNativeDebitLamports) ||
    BigInt(s.maximumNativeDebitLamports) <
      BigInt(s.networkFeeLamports) +
        BigInt(s.maximumRentLamports) +
        (checks.side === 'Buy' ? BigInt(q.inputRaw) : 0n)
  )
    throw Error('Unsigned preview evidence differs or is stale.');
  const expiresAt = new Date(
    Math.min(
      Date.parse(checks.expiresAt),
      Date.parse(q.expiresAt),
      Date.parse(b.expiresAt),
      now + 15000,
    ),
  ).toISOString();
  if (Date.parse(expiresAt) <= now)
    throw Error('Unsigned preview expired. Check again.');
  const document = {
    format: 'strategy-unsigned-preview-v1' as const,
    checks,
    conditionPool,
    startedAt,
    previewedAt,
    expiresAt,
    quote: { ...q },
    balance: { ...b },
    simulation: { ...s },
    planningOnly: true as const,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  return { ...document, sha256: await capacityDigest(document) };
}
export type StrategyUnsignedPreview = Awaited<
  ReturnType<typeof buildStrategyUnsignedPreview>
>;
