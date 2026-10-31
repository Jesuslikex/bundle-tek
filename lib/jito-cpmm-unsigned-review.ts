import bs58 from 'bs58';
import { snapshotJitoEvidence } from './jito-evidence-json';
import { readJitoSimulationJson } from './jito-simulation-json';
import { UUID } from './wallet-operation';

export const JITO_UNSIGNED_REVIEW_LIMIT = 16384;
export const JITO_RUNTIME_SIGNING_ENABLED = false;
const authority = {
  sourceAuthenticated: false,
  providerQualified: false,
  bankVerified: false,
  walletOwnershipVerified: false,
  signingAllowed: false,
  executionAllowed: false,
} as const;
export type JitoCpmmReviewFacts = {
  capturedAt: string;
  payer: string;
  pool: string;
  inputMint: string;
  outputMint: string;
  inputRaw: string;
  expectedOutputRaw: string;
  minimumOutputRaw: string;
  tipLamports: string;
  networkFeeLamports: string;
  maximumFeeLamports: string;
  createdRentLamports: string;
  retainedRentLamports: string;
  minimumSlot: string;
  simulationSlot: string;
  maximumSlot: string;
  blockhash: string;
  lastValidBlockHeight: string;
  priceDifferenceBps: string;
  packetSha256s: string[];
};
export type JitoCpmmUnsignedReview = JitoCpmmReviewFacts & {
  format: 'jito-cpmm-unsigned-review-v1';
  purpose: 'public-reference-research';
  authority: typeof authority;
  sha256: string;
};
export type JitoCpmmReviewContext = {
  ownerScope: string;
  projectId: string;
  sessionId: string;
};
export type JitoCpmmSavedReview = JitoCpmmReviewContext & {
  format: 'jito-cpmm-saved-review-v1';
  review: JitoCpmmUnsignedReview;
  reviewedAt: string;
  acknowledgement: 'unsigned-inspection-only';
  sha256: string;
};
const hashPattern = /^[a-f0-9]{64}$/;
const fail = (): never => {
  throw Error('Unsigned Raydium review differs or exceeds its limit.');
};
function exact(value: object, keys: string[]) {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|'))
    fail();
}
function uint(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    return fail();
  return BigInt(value);
}
function date(value: unknown) {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail();
}
function key(value: unknown) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return fail();
  const decoded = bs58.decode(value);
  if (decoded.length !== 32 || bs58.encode(decoded) !== value) fail();
}
// Canonical JSON checksum only. This is deliberately NOT a signature or attestation.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
async function digest(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonical(value)),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
const factKeys = [
  'capturedAt',
  'payer',
  'pool',
  'inputMint',
  'outputMint',
  'inputRaw',
  'expectedOutputRaw',
  'minimumOutputRaw',
  'tipLamports',
  'networkFeeLamports',
  'maximumFeeLamports',
  'createdRentLamports',
  'retainedRentLamports',
  'minimumSlot',
  'simulationSlot',
  'maximumSlot',
  'blockhash',
  'lastValidBlockHeight',
  'priceDifferenceBps',
  'packetSha256s',
];
function facts(value: JitoCpmmReviewFacts) {
  exact(value, factKeys);
  date(value.capturedAt);
  for (const name of [
    'payer',
    'pool',
    'inputMint',
    'outputMint',
    'blockhash',
  ] as const)
    key(value[name]);
  if (
    new Set([value.payer, value.pool, value.inputMint, value.outputMint])
      .size !== 4
  )
    fail();
  for (const name of [
    'inputRaw',
    'expectedOutputRaw',
    'minimumOutputRaw',
    'tipLamports',
    'networkFeeLamports',
    'maximumFeeLamports',
    'createdRentLamports',
    'retainedRentLamports',
    'minimumSlot',
    'simulationSlot',
    'maximumSlot',
    'lastValidBlockHeight',
  ] as const)
    uint(value[name]);
  if (
    uint(value.inputRaw) < 1n ||
    uint(value.minimumOutputRaw) < 1n ||
    uint(value.expectedOutputRaw) < uint(value.minimumOutputRaw) ||
    uint(value.tipLamports) < 1000n ||
    uint(value.tipLamports) > 10000000n ||
    uint(value.networkFeeLamports) > uint(value.maximumFeeLamports) ||
    uint(value.maximumFeeLamports) > 80000n ||
    uint(value.minimumSlot) < 1n ||
    uint(value.simulationSlot) < uint(value.minimumSlot) ||
    uint(value.maximumSlot) < uint(value.simulationSlot) ||
    uint(value.maximumSlot) - uint(value.minimumSlot) > 32n ||
    uint(value.lastValidBlockHeight) < 10n
  )
    fail();
  if (
    !/^-?(0|[1-9]\d{0,5})$/.test(value.priceDifferenceBps) ||
    value.priceDifferenceBps === '-0' ||
    BigInt(value.priceDifferenceBps) < -200n
  )
    fail();
  if (
    !Array.isArray(value.packetSha256s) ||
    value.packetSha256s.length !== 4 ||
    new Set(value.packetSha256s).size !== 4 ||
    value.packetSha256s.some(
      (h) => typeof h !== 'string' || !hashPattern.test(h),
    )
  )
    fail();
}
/** Display-only projection from a completed collector. Accepting these fields
 * never attests that collection happened; imported files remain untrusted. */
export async function createJitoCpmmUnsignedReview(
  input: JitoCpmmReviewFacts,
): Promise<JitoCpmmUnsignedReview> {
  const value = snapshotJitoEvidence(input, JITO_UNSIGNED_REVIEW_LIMIT);
  facts(value);
  const body = {
    format: 'jito-cpmm-unsigned-review-v1' as const,
    purpose: 'public-reference-research' as const,
    ...value,
    authority: { ...authority },
  };
  return { ...body, sha256: await digest(body) };
}
export async function requireJitoCpmmUnsignedReview(
  input: unknown,
): Promise<JitoCpmmUnsignedReview> {
  const value = snapshotJitoEvidence(
    input,
    JITO_UNSIGNED_REVIEW_LIMIT,
  ) as JitoCpmmUnsignedReview;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  exact(value, [...factKeys, 'format', 'purpose', 'authority', 'sha256']);
  if (
    value.format !== 'jito-cpmm-unsigned-review-v1' ||
    value.purpose !== 'public-reference-research' ||
    !hashPattern.test(value.sha256)
  )
    fail();
  const {
    format: _format,
    purpose: _purpose,
    authority: flags,
    sha256,
    ...terms
  } = value;
  if (!flags || typeof flags !== 'object') return fail();
  exact(flags, Object.keys(authority));
  if (Object.values(flags).some((v) => v !== false)) fail();
  const expected = await createJitoCpmmUnsignedReview(terms);
  if (sha256 !== expected.sha256) fail();
  return expected;
}
function context(value: JitoCpmmReviewContext) {
  if (
    !hashPattern.test(value.ownerScope) ||
    !UUID.test(value.projectId) ||
    !UUID.test(value.sessionId)
  )
    fail();
}
export async function saveJitoCpmmUnsignedReview(
  input: unknown,
  scoped: JitoCpmmReviewContext,
  approved: boolean,
  reviewedAt = new Date().toISOString(),
): Promise<JitoCpmmSavedReview> {
  const owned = snapshotJitoEvidence(scoped, 1024);
  exact(owned, ['ownerScope', 'projectId', 'sessionId']);
  context(owned);
  if (approved !== true) fail();
  date(reviewedAt);
  const review = await requireJitoCpmmUnsignedReview(input);
  const body = {
    format: 'jito-cpmm-saved-review-v1' as const,
    ...owned,
    review,
    reviewedAt,
    acknowledgement: 'unsigned-inspection-only' as const,
  };
  return { ...body, sha256: await digest(body) };
}
/** No consent is restored: returns historical display data only. There are no
 * packets, signatures, server authorizations or wallet keys in this format. */
export async function openJitoCpmmUnsignedReview(
  bytes: Uint8Array,
  scoped: JitoCpmmReviewContext,
) {
  const owned = snapshotJitoEvidence(scoped, 1024);
  context(owned);
  if (
    !(bytes instanceof Uint8Array) ||
    !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.byteLength > JITO_UNSIGNED_REVIEW_LIMIT
  )
    return fail();
  const copied = Uint8Array.from(bytes);
  const parsed = (await readJitoSimulationJson(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(copied);
        controller.close();
      },
    }),
    new AbortController().signal,
    JITO_UNSIGNED_REVIEW_LIMIT,
  )) as JitoCpmmSavedReview | JitoCpmmUnsignedReview;
  if (!parsed || typeof parsed !== 'object') return fail();
  if (parsed.format === 'jito-cpmm-unsigned-review-v1')
    return {
      review: await requireJitoCpmmUnsignedReview(parsed),
      recovered: false as const,
    };
  if (parsed.format !== 'jito-cpmm-saved-review-v1') return fail();
  const saved = snapshotJitoEvidence(parsed, JITO_UNSIGNED_REVIEW_LIMIT);
  exact(saved, [
    'format',
    'ownerScope',
    'projectId',
    'sessionId',
    'review',
    'reviewedAt',
    'acknowledgement',
    'sha256',
  ]);
  if (
    saved.ownerScope !== owned.ownerScope ||
    saved.projectId !== owned.projectId ||
    saved.sessionId !== owned.sessionId ||
    saved.acknowledgement !== 'unsigned-inspection-only'
  )
    fail();
  const expected = await saveJitoCpmmUnsignedReview(
    saved.review,
    owned,
    true,
    saved.reviewedAt,
  );
  if (saved.sha256 !== expected.sha256) fail();
  return { review: expected.review, recovered: true as const };
}
