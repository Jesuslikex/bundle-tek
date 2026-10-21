import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { pairRuntimeDigest } from './pair-runtime-trace';
import {
  walletWarmupRuntimeOrderRequestDigest,
  type WarmupRuntimeOrderRequest,
  type collectWalletWarmupRuntimeOrder,
} from './wallet-warmup-runtime-order';
import {
  warmupAttemptHash as hash,
  warmupAttemptIso as iso,
  warmupAttemptUnits as units,
  warmupAttemptUuid as uuid,
  WalletWarmupV2AttemptError,
  type WarmupV2AttemptRow,
  type WarmupV2OutcomeRow,
} from './wallet-warmup-session-v2-attempt-types';
import type { WarmupPreparationSummary } from './warmup-preparation-history';
import type { SolanaSwapRuntimeContext } from './solana-swap-runtime-context';
export type WarmupAttemptMode = 'preview' | 'runtime';
/** A result batch committed between two saved-only reads. Never retry providers. */
export class WarmupRuntimeReadRace extends WalletWarmupV2AttemptError {
  constructor() {
    super(
      'Retained runtime result changed while reading. Recover the same ID.',
      503,
    );
  }
}
export type WarmupRuntimeMaterial = {
  request: WarmupRuntimeOrderRequest;
  result: Awaited<ReturnType<typeof collectWalletWarmupRuntimeOrder>>;
};
function fail(): never {
  throw new WalletWarmupV2AttemptError(
    'Original runtime request or retained observations are unavailable. Recover the same ID.',
    503,
  );
}
function stored<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    return fail();
  }
}
const names = [
  'wallet_warmup_session_v2_attempt_purposes',
  'wallet_warmup_session_v2_runtime_observations',
  'warmup_v2_purpose_identity',
  'warmup_v2_runtime_packet',
  'warmup_v2_purpose_insert',
  'warmup_v2_purpose_no_update',
  'warmup_v2_purpose_no_delete',
  'warmup_v2_attempt_requires_purpose',
  'warmup_v2_runtime_insert',
  'warmup_v2_runtime_no_update',
  'warmup_v2_runtime_no_delete',
  'warmup_v2_runtime_outcome',
];
export async function warmupRuntimeInstalled(db: D1Database, required = false) {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')})`,
    )
    .bind(...names)
    .first<{ n: number }>();
  if (row?.n === 0 && !required) return false;
  if (row?.n !== names.length) return fail();
  const foreignKeys = await db
    .prepare('PRAGMA foreign_keys')
    .first<{ foreign_keys: number }>();
  if (foreignKeys?.foreign_keys !== 1) return fail();
  return true;
}
const purposeSchema = z
  .object({
    owner_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    attempt_id: uuid,
    journal_id: uuid,
    review_version: z.number().int().min(1).max(65535),
    review_sha256: hash,
    terms_sha256: hash,
    mode: z.enum(['preview', 'runtime']),
    request_sha256: hash,
    created_at: iso,
  })
  .strict();
type Purpose = z.infer<typeof purposeSchema>;
export const warmupPurposeHash = (
  value: Omit<Purpose, 'request_sha256' | 'created_at'>,
) =>
  digest(canonical({ format: 'wallet-warmup-attempt-purpose-v1', ...value }));
export async function warmupPurposeInsert(
  db: D1Database,
  owner: string,
  input: { id: string; journalId: string; version: number; headSha256: string },
  terms: string,
  mode: WarmupAttemptMode,
) {
  const binding = {
    owner_id: owner,
    attempt_id: input.id,
    journal_id: input.journalId,
    review_version: input.version,
    review_sha256: input.headSha256,
    terms_sha256: terms,
    mode,
  };
  return db
    .prepare(`INSERT INTO wallet_warmup_session_v2_attempt_purposes
 SELECT ?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(
      owner,
      input.id,
      input.journalId,
      input.version,
      input.headSha256,
      terms,
      mode,
      await warmupPurposeHash(binding),
    );
}
export async function readWarmupPurpose(
  db: D1Database,
  lease: WarmupV2AttemptRow,
  mode?: WarmupAttemptMode,
) {
  if (!(await warmupRuntimeInstalled(db, mode === 'runtime'))) return null;
  const raw = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_v2_attempt_purposes WHERE owner_id=? AND attempt_id=?',
    )
    .bind(lease.owner_id, lease.id)
    .first();
  return admitPurpose(raw, lease, mode);
}
async function admitPurpose(
  raw: unknown,
  lease: WarmupV2AttemptRow,
  mode?: WarmupAttemptMode,
) {
  if (!raw) {
    if (mode === 'runtime')
      throw new WalletWarmupV2AttemptError(
        'This ID is an original preview, not a runtime request. Recover its original mode.',
        409,
        lease.id,
      );
    return null;
  }
  const p = stored(purposeSchema, raw),
    { request_sha256, created_at, ...terms } = p;
  if (
    p.owner_id !== lease.owner_id ||
    p.attempt_id !== lease.id ||
    p.journal_id !== lease.journal_id ||
    p.review_version !== lease.review_version ||
    p.review_sha256 !== lease.review_sha256 ||
    p.terms_sha256 !== lease.terms_sha256 ||
    created_at > lease.created_at ||
    (await warmupPurposeHash(terms)) !== request_sha256
  )
    fail();
  if (mode && p.mode !== mode)
    throw new WalletWarmupV2AttemptError(
      'This ID has a different saved read purpose. Recover it using its original mode.',
      409,
      lease.id,
    );
  return p;
}
/** At most one metadata page, one saved-only batch, no packet/provider reads. */
export async function readWarmupPurposePage(
  db: D1Database,
  leases: WarmupV2AttemptRow[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (leases.length > 25) return fail();
  if (!(await warmupRuntimeInstalled(db))) return leases.map(() => null);
  if (!leases.length) return [];
  const rows = await db.batch(
    leases.map((lease) =>
      db
        .prepare(
          'SELECT * FROM wallet_warmup_session_v2_attempt_purposes WHERE owner_id=? AND attempt_id=?',
        )
        .bind(lease.owner_id, lease.id),
    ),
  );
  signal.throwIfAborted();
  if (rows.length !== leases.length) return fail();
  return Promise.all(
    rows.map((row, index) => {
      if (row.success !== true || row.results.length > 1) return fail();
      return admitPurpose(row.results[0] ?? null, leases[index]);
    }),
  );
}
export async function requireActiveWarmupRuntimePurpose(
  db: D1Database,
  lease: WarmupV2AttemptRow,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const p = await readWarmupPurpose(db, lease, 'runtime');
  const current = await db
    .prepare(
      `SELECT a.id FROM wallet_warmup_session_v2_attempts a JOIN wallet_warmup_session_v2_attempt_context c ON c.owner_id=a.owner_id AND c.journal_id=a.journal_id AND c.version=a.review_version AND c.head_sha256=a.review_sha256 AND c.terms_sha256=a.terms_sha256 AND c.action_id=a.action_id WHERE a.owner_id=? AND a.id=? AND a.created_at=? AND a.expires_at=? AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<a.expires_at AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_outcomes o WHERE o.owner_id=a.owner_id AND o.attempt_id=a.id)`,
    )
    .bind(lease.owner_id, lease.id, lease.created_at, lease.expires_at)
    .first();
  signal.throwIfAborted();
  if (!current || !p) fail();
  return p;
}
const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  slot = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  text = z.string().max(2048);
const inventory = z
  .object({
    executionAllowed: z.literal(false),
    wallet: addr,
    mint: addr,
    decimals: z.number().int().min(0).max(255),
    tokenProgram: addr,
    mintExtensions: z.array(text).max(128).nullable(),
    accountExtensions: z
      .array(
        z
          .object({
            address: addr,
            extensions: z.array(text).max(128).nullable(),
          })
          .strict(),
      )
      .max(512),
    blockedExtensions: z.array(text).max(128),
    mintSlot: slot.nullable(),
    totalRaw: units,
    frozenRaw: units,
    unfrozenRaw: units,
    unfrozenAmount: text.nullable(),
    requestedRaw: units.nullable(),
    amountCovered: z.boolean(),
    preparationSupported: z.boolean(),
    source: text,
    minSlot: slot,
    maxSlot: slot,
    observedAt: iso,
    expiresAt: iso,
    limitations: z.string().max(4096),
  })
  .strict();
const requestSchema = z
  .object({
    requestSha256: hash,
    wallet: addr,
    mint: addr,
    side: z.enum(['Buy', 'Sell']),
    inputRaw: units,
    feeAndRentLimitRaw: units,
    deadline: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    inventory: inventory.nullable(),
  })
  .strict();
const identity = z
  .object({
    address: addr,
    loader: addr,
    programData: addr.nullable(),
    deploymentSlot: units.nullable(),
    upgradeAuthority: addr.nullable(),
    codeSha256: hash,
    codeBytes: z.number().int().min(0).max(10485760),
    identityKind: z.enum(['native-system', 'elf-code']),
  })
  .strict();
const programs = z.array(identity).min(1).max(16);
const runtimeSchema = z
  .object({
    format: z.literal('pair-order-runtime-preview-v1'),
    packetSha256: hash,
    preflightSha256: hash,
    pairSha256: hash,
    reviewSha256: hash,
    programs,
    traceSha256: hash,
    codeIdentityObserved: z.literal(true),
    minimumSlot: slot,
    maximumSlot: slot,
    recheckBlockHeight: units,
    observedAt: iso,
    expiresAt: iso,
    programCodeAttested: z.literal(false),
    semanticAuditEstablished: z.literal(false),
    trustedProgramPolicyEstablished: z.literal(false),
    innerInstructionPolicyVerified: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
    sha256: hash,
  })
  .strict();
const native = z
  .object({
    walletLamportsBeforeRaw: units,
    walletLamportsAfterRaw: units,
    networkFeeRaw: units,
    nativeTradeDeltaRaw: z.string().regex(/^(0|-?[1-9]\d{0,19})$/),
    retainedAccountRentRaw: units,
    retainedNonNativeAccountRentRaw: units,
    retainedNativeAccountRentRaw: units,
    refundedNonNativeAccountRentRaw: units,
    auxiliaryWrappedSolGainRaw: units,
  })
  .strict();
const docSchema = z
  .object({
    format: z.literal('wallet-warmup-retained-runtime-v1'),
    purposeSha256: hash,
    packetSha256: hash,
    wallet: addr,
    actionId: z.string().max(256),
    readRequestDocument: z.string().max(65536),
    readRequestSha256: hash,
    feeAndRentLimitRaw: units,
    contextSha256: hash,
    contextDocument: z.string().max(65536),
    reviewDocument: z.string().max(196608),
    clockObservations: z
      .array(
        z
          .object({ channel: z.literal('account'), slot, unixTimestamp: units })
          .strict(),
      )
      .min(1)
      .max(600),
    reviewSha256: hash,
    traceSha256: hash,
    minimumSlot: slot,
    maximumSlot: slot,
    observedAt: iso,
    runtimeExpiresAt: iso,
    referenceMinimum: z.literal('order-self'),
    codeClockPolicy: z.literal('context-slot-floor-only'),
    codeScans: z.tuple([programs, programs]),
    runtime: runtimeSchema,
    nativeSettlement: native,
    independentPriceProtectionEstablished: z.literal(false),
    programCodeAttested: z.literal(false),
    trustedProgramPolicyEstablished: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
  })
  .strict();
const rowSchema = z
  .object({
    owner_id: z.string(),
    attempt_id: uuid,
    purpose_sha256: hash,
    packet_sha256: hash,
    document: z.string().max(262144),
    document_sha256: hash,
    outcome_sha256: hash,
    created_at: iso,
    expires_at: iso,
  })
  .strict();
type RuntimeRow = z.infer<typeof rowSchema>;
async function admitDocument(
  value: unknown,
  lease: WarmupV2AttemptRow,
  purpose: Purpose,
  summary: WarmupPreparationSummary,
  reserve: string,
) {
  const d = docSchema.parse(value),
    r = requestSchema.parse(JSON.parse(d.readRequestDocument)),
    { sha256, ...runtime } = d.runtime;
  const context = JSON.parse(d.contextDocument) as SolanaSwapRuntimeContext,
    review = JSON.parse(
      d.reviewDocument,
    ) as WarmupRuntimeMaterial['result']['runtime']['review'],
    { sha256: reviewSha, ...reviewBody } = review,
    { sha256: pairSha, ...assets } = context.quote.pair;
  if (
    canonical(d) !== canonical(value) ||
    canonical(r) !== d.readRequestDocument ||
    (await walletWarmupRuntimeOrderRequestDigest(r)) !== r.requestSha256 ||
    r.requestSha256 !== d.readRequestSha256 ||
    r.feeAndRentLimitRaw !== reserve ||
    d.feeAndRentLimitRaw !== reserve ||
    d.purposeSha256 !== purpose.request_sha256 ||
    d.packetSha256 !== summary.transaction.sha256 ||
    d.wallet !== summary.wallet ||
    d.actionId !== lease.action_id ||
    r.wallet !== summary.wallet ||
    r.side !== summary.side ||
    r.inputRaw !== summary.inAmountRaw ||
    r.mint !==
      (summary.side === 'Buy' ? summary.outputMint : summary.inputMint) ||
    r.deadline !== Date.parse(lease.expires_at) ||
    d.maximumSlot < d.minimumSlot ||
    d.maximumSlot - d.minimumSlot > 32 ||
    d.runtime.minimumSlot < d.minimumSlot ||
    d.runtime.maximumSlot > d.maximumSlot ||
    d.runtime.maximumSlot < d.runtime.minimumSlot ||
    d.runtime.packetSha256 !== d.packetSha256 ||
    d.runtime.preflightSha256 !== d.contextSha256 ||
    d.runtime.reviewSha256 !== d.reviewSha256 ||
    d.runtime.traceSha256 !== d.traceSha256 ||
    d.runtime.expiresAt !== d.runtimeExpiresAt ||
    Date.parse(d.runtime.observedAt) > Date.parse(d.observedAt) ||
    Date.parse(d.observedAt) >= Date.parse(d.runtimeExpiresAt) ||
    Date.parse(d.runtimeExpiresAt) >
      Math.min(Date.parse(lease.expires_at), Date.parse(summary.expiresAt)) ||
    (await pairRuntimeDigest(runtime)) !== sha256 ||
    canonical(context) !== d.contextDocument ||
    JSON.stringify(review) !== d.reviewDocument ||
    (await digest(JSON.stringify(reviewBody))) !== reviewSha ||
    reviewSha !== d.reviewSha256 ||
    context.contextSha256 !== d.contextSha256 ||
    context.wallet !== r.wallet ||
    context.funding.userFeeAndRentLimitRaw !== reserve ||
    context.quote.side !== r.side ||
    context.quote.inputRaw !== r.inputRaw ||
    context.quote.quote.minimumOutAmount !== summary.minimumOutRaw ||
    context.quote.pair.base.address !== r.mint ||
    context.quote.pair.quote.address !==
      'So11111111111111111111111111111111111111112' ||
    (await pairRuntimeDigest({
      format: 'warmup-runtime-assets-v1',
      ...assets,
    })) !== pairSha ||
    pairSha !== d.runtime.pairSha256 ||
    (await pairRuntimeDigest({
      format: 'warmup-runtime-context-v1',
      request: r,
      assets,
      wallet: context.evidence,
      packetSha256: d.packetSha256,
    })) !== d.contextSha256 ||
    review.wallet !== r.wallet ||
    review.packetSha256 !== d.packetSha256 ||
    review.preflightSha256 !== d.contextSha256 ||
    review.pairSha256 !== pairSha ||
    review.runtimeTrace?.sha256 !== d.traceSha256 ||
    review.signingAllowed !== false ||
    review.executionAllowed !== false ||
    review.programCodeAttested !== false ||
    review.applicationReservationsChecked !== false ||
    review.economicSimulationVerified !== true ||
    d.clockObservations.some(
      (c) => c.slot < d.minimumSlot || c.slot > d.maximumSlot,
    ) ||
    canonical(d.codeScans[0]) !== canonical(d.codeScans[1]) ||
    canonical(d.runtime.programs) !== canonical(d.codeScans[1]) ||
    new Set(d.runtime.programs.map((p) => p.address)).size !==
      d.runtime.programs.length ||
    d.nativeSettlement.networkFeeRaw !==
      summary.simulation.networkFeeLamports ||
    (
      BigInt(d.nativeSettlement.walletLamportsAfterRaw) -
      BigInt(d.nativeSettlement.walletLamportsBeforeRaw)
    ).toString() !== summary.simulation.nativeChangeRaw
  )
    fail();
  if (
    summary.side === 'Buy'
      ? r.inventory !== null
      : !r.inventory ||
        !summary.inventory ||
        Object.entries(summary.inventory).some(
          ([key, value]) =>
            canonical(value) !==
            canonical(r.inventory![key as keyof typeof r.inventory]),
        )
  )
    fail();
  return d;
}
export async function warmupRuntimeDocument(
  material: WarmupRuntimeMaterial,
  lease: WarmupV2AttemptRow,
  purpose: Purpose,
  summary: WarmupPreparationSummary,
  reserve: string,
) {
  const { result, request } = structuredClone(material),
    { runtime, review, codeScans } = result.runtime;
  const { sha256: reviewHash, ...reviewBody } = review;
  if (
    (await digest(JSON.stringify(reviewBody))) !== reviewHash ||
    review.packetSha256 !== summary.transaction.sha256 ||
    result.simulation.sha256 !== review.packetSha256 ||
    review.economicSimulationVerified !== true ||
    result.observation.requestSha256 !== request.requestSha256 ||
    result.order.preparation.sha256 !== review.packetSha256 ||
    result.context.wallet !== request.wallet ||
    result.context.funding.userFeeAndRentLimitRaw !== reserve ||
    review.programCodeAttested !== false ||
    review.applicationReservationsChecked !== false ||
    review.signingAllowed !== false ||
    review.executionAllowed !== false ||
    review.simulation.signatureVerified !== false ||
    review.simulation.providerObservationOnly !== true ||
    review.simulation.economicSimulationVerified !== true ||
    result.simulation.nativeChangeRaw !== summary.simulation.nativeChangeRaw ||
    result.simulation.observedAt !== summary.simulation.observedAt
  )
    fail();
  const { sha256: pairSha, ...assets } = result.context.quote.pair;
  if (
    (await pairRuntimeDigest({
      format: 'warmup-runtime-assets-v1',
      ...assets,
    })) !== pairSha ||
    (await pairRuntimeDigest({
      format: 'warmup-runtime-context-v1',
      request,
      assets,
      wallet: result.context.evidence,
      packetSha256: review.packetSha256,
    })) !== result.context.contextSha256
  )
    fail();
  for (const [key, value] of Object.entries(
    result.observation.nativeSettlement,
  ))
    if (review.simulation[key as keyof typeof review.simulation] !== value)
      fail();
  const data = {
    format: 'wallet-warmup-retained-runtime-v1' as const,
    purposeSha256: purpose.request_sha256,
    packetSha256: review.packetSha256,
    wallet: summary.wallet,
    actionId: lease.action_id,
    readRequestDocument: canonical(request),
    readRequestSha256: request.requestSha256,
    feeAndRentLimitRaw: reserve,
    contextSha256: result.context.contextSha256,
    contextDocument: canonical(result.context),
    reviewDocument: JSON.stringify(review),
    clockObservations: result.observation.clockObservations,
    reviewSha256: reviewHash,
    traceSha256: runtime.traceSha256,
    minimumSlot: result.observation.minimumSlot,
    maximumSlot: result.observation.maximumSlot,
    observedAt: result.simulation.observedAt,
    runtimeExpiresAt: runtime.expiresAt,
    referenceMinimum: 'order-self' as const,
    codeClockPolicy: 'context-slot-floor-only' as const,
    codeScans: structuredClone(codeScans),
    runtime,
    nativeSettlement: result.observation.nativeSettlement,
    independentPriceProtectionEstablished: false as const,
    programCodeAttested: false as const,
    trustedProgramPolicyEstablished: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  const admitted = await admitDocument(data, lease, purpose, summary, reserve),
    document = canonical(admitted);
  if (new TextEncoder().encode(document).byteLength > 262144) fail();
  return document;
}
export async function warmupRuntimeInsert(
  db: D1Database,
  lease: WarmupV2AttemptRow,
  purpose: Purpose,
  outcome: WarmupV2OutcomeRow,
  document: string,
) {
  return db
    .prepare(
      'INSERT INTO wallet_warmup_session_v2_runtime_observations VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      lease.owner_id,
      lease.id,
      purpose.request_sha256,
      outcome.packet_sha256,
      document,
      await digest(document),
      outcome.record_sha256,
      outcome.created_at,
      outcome.expires_at,
    );
}
export async function readWarmupRuntimeObservation(
  db: D1Database,
  lease: WarmupV2AttemptRow,
  outcome: WarmupV2OutcomeRow | null,
  summary: WarmupPreparationSummary | null,
  reserve: string,
) {
  const purpose = await readWarmupPurpose(db, lease, 'runtime');
  if (!purpose) return fail();
  const raw = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_v2_runtime_observations WHERE owner_id=? AND attempt_id=?',
    )
    .bind(lease.owner_id, lease.id)
    .first<RuntimeRow>();
  if (!outcome || outcome.kind === 'refused') {
    if (!outcome && raw) throw new WarmupRuntimeReadRace();
    if (raw) fail();
    return { purpose, observation: null };
  }
  if (!raw || !summary) fail();
  const row = stored(rowSchema, raw);
  if (
    row.owner_id !== lease.owner_id ||
    row.attempt_id !== lease.id ||
    row.purpose_sha256 !== purpose.request_sha256 ||
    row.packet_sha256 !== outcome.packet_sha256 ||
    row.outcome_sha256 !== outcome.record_sha256 ||
    row.created_at !== outcome.created_at ||
    row.expires_at !== outcome.expires_at ||
    (await digest(row.document)) !== row.document_sha256
  )
    fail();
  let observation: Awaited<ReturnType<typeof admitDocument>>;
  try {
    observation = await admitDocument(
      JSON.parse(row.document),
      lease,
      purpose,
      summary,
      reserve,
    );
  } catch {
    return fail();
  }
  if (
    canonical(observation) !== row.document ||
    Date.parse(observation.runtimeExpiresAt) <= Date.parse(row.created_at)
  )
    fail();
  return { purpose, observation };
}
