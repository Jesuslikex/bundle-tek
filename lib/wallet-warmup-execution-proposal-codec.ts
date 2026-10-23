import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { bindWarmupExecutionTerms } from './wallet-warmup-execution-terms';
import { warmupExecutionReviewEvidenceSchema } from './wallet-warmup-execution-budget-review';
import {
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';

// Complete pre-approval proposal, NOT the old manifest archive format. The
// ceiling is a local resource policy, not proof of hosted or worst-case capacity.
export const WARMUP_PROPOSAL_CHUNK_BYTES = 192 * 1024;
export const WARMUP_PROPOSAL_MAX_BYTES = 64 * 1024 * 1024;
const maxChunks = Math.ceil(
  WARMUP_PROPOSAL_MAX_BYTES / WARMUP_PROPOSAL_CHUNK_BYTES,
);
const owner = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const identity = z
  .object({ id: uuid, ownerId: owner, consentId: uuid, reviewId: uuid })
  .strict();
const expectedSchema = identity.extend({ headerSha256: hash }).strict();
const headerSchema = identity
  .extend({
    format: z.literal('wallet-warmup-execution-proposal-blobs-v1'),
    proposalSha256: hash,
    termsSha256: hash,
    verifierEvidenceSha256: hash,
    proposalExpiresAt: iso,
    bytes: z.number().int().positive().max(WARMUP_PROPOSAL_MAX_BYTES),
    chunks: z
      .array(
        z
          .object({
            index: z
              .number()
              .int()
              .min(0)
              .max(maxChunks - 1),
            bytes: z.number().int().positive().max(WARMUP_PROPOSAL_CHUNK_BYTES),
            sha256: hash,
          })
          .strict(),
      )
      .min(1)
      .max(maxChunks),
  })
  .strict();
const envelopeSchema = z
  .object({
    format: z.literal('wallet-warmup-execution-proposal-content-v1'),
    terms: z.unknown(),
    verifierEvidence: warmupExecutionReviewEvidenceSchema,
  })
  .strict();
export type WarmupProposalHeader = z.infer<typeof headerSchema>;
export type WarmupProposalChunk = { index: number; data: Uint8Array };
const flags = {
  scope: 'complete-proposal-transport-integrity-only' as const,
  humanApprovalVerified: false as const,
  currentSourceVerified: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
};
export class WarmupProposalCodecError extends Error {
  constructor() {
    super(
      'Warmup proposal is incomplete or differs from its expected content.',
    );
    this.name = 'WarmupProposalCodecError';
  }
}
function fail(): never {
  throw new WarmupProposalCodecError();
}
const sha = async (data: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
// Read the actual typed-array byte length, not an overridable own property.
const typedArrayByteLengthDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
)!;
const typedArrayTagDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)!;

/** Shape only; an independent owned header digest is still mandatory. */
export function parseWarmupExecutionProposalHeader(value: unknown) {
  const h = headerSchema.parse(value);
  if (
    h.chunks.length !== Math.ceil(h.bytes / WARMUP_PROPOSAL_CHUNK_BYTES) ||
    h.chunks.some(
      (c, i) =>
        c.index !== i ||
        c.bytes !==
          Math.min(
            WARMUP_PROPOSAL_CHUNK_BYTES,
            h.bytes - i * WARMUP_PROPOSAL_CHUNK_BYTES,
          ),
    )
  )
    fail();
  return h;
}

/** Structural and hash links only. Actual original owned-source reconstruction,
 * currentness and publication predicates remain mandatory at future admission. */
async function content(value: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const input = envelopeSchema.parse(value);
  // The binder snapshots unknown terms synchronously before its first await;
  // the strict schema above already detached the complete evidence tree.
  const bound = await bindWarmupExecutionTerms(input.terms);
  signal.throwIfAborted();
  const v = input.verifierEvidence,
    b = v.freshBudget,
    a = v.assets;
  if (
    (await digest(canonical(a))) !== v.assetEvidenceSha256 ||
    (await digest(canonical(b))) !== v.freshBudgetSha256 ||
    (await digest(canonical(v))) !== bound.terms.verifierEvidenceSha256 ||
    b.ownerId !== bound.terms.intent.ownerId ||
    a.ownerId !== b.ownerId ||
    b.rootId !== bound.terms.intent.id ||
    b.consentId !== bound.terms.intent.consentId ||
    b.reviewId !== bound.terms.review.id ||
    a.reviewId !== b.reviewId ||
    b.reviewSha256 !== bound.terms.review.sha256 ||
    a.reviewSha256 !== b.reviewSha256 ||
    b.sourceSnapshotSha256 !== bound.terms.intent.sourceSha256 ||
    a.sourceSnapshotSha256 !== b.sourceSnapshotSha256 ||
    b.assetEvidenceSha256 !== v.assetEvidenceSha256 ||
    b.proposalExpiresAt !== a.expiresAt ||
    b.proposedSessionExpiresAt !== bound.terms.intent.expiresAt
  )
    fail();
  signal.throwIfAborted();
  return {
    envelope: { format: input.format, terms: bound.terms, verifierEvidence: v },
    termsSha256: bound.termsSha256,
  };
}

/** Unmounted transport primitive. Encode only the complete proposal, before any
 * approval. No publication time, consent, root, DB writes or deadline renewal.
 * Future writer must obtain these bytes from the real internal budget service. */
export async function packWarmupExecutionProposal(
  value: unknown,
  signal: AbortSignal,
) {
  try {
    const { envelope, termsSha256 } = await content(value, signal);
    const bytes = new TextEncoder().encode(canonical(envelope));
    if (!bytes.length || bytes.length > WARMUP_PROPOSAL_MAX_BYTES) fail();
    const chunks: WarmupProposalChunk[] = [],
      descriptors: WarmupProposalHeader['chunks'] = [];
    for (
      let offset = 0;
      offset < bytes.length;
      offset += WARMUP_PROPOSAL_CHUNK_BYTES
    ) {
      signal.throwIfAborted();
      const data = bytes.slice(offset, offset + WARMUP_PROPOSAL_CHUNK_BYTES),
        index = chunks.length;
      chunks.push({ index, data });
      descriptors.push({ index, bytes: data.length, sha256: await sha(data) });
    }
    const { terms, verifierEvidence } = envelope;
    const header = parseWarmupExecutionProposalHeader({
      format: 'wallet-warmup-execution-proposal-blobs-v1',
      id: terms.intent.id,
      ownerId: terms.intent.ownerId,
      consentId: terms.intent.consentId,
      reviewId: terms.review.id,
      proposalSha256: await sha(bytes),
      termsSha256,
      verifierEvidenceSha256: terms.verifierEvidenceSha256,
      proposalExpiresAt: verifierEvidence.assets.expiresAt,
      bytes: bytes.length,
      chunks: descriptors,
    });
    const headerSha256 = await digest(canonical(header));
    signal.throwIfAborted();
    return { header, headerSha256, chunks, ...flags };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}

/** Expected identity/header hash must come from independent owned publication
 * storage, never the incoming packet. Every BLOB is copied before awaiting;
 * UTF8 decoding happens once after assembly. No partial proposal is returned. */
export async function unpackWarmupExecutionProposal(
  rawHeader: unknown,
  rawChunks: readonly WarmupProposalChunk[],
  rawExpected: unknown,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    const h = parseWarmupExecutionProposalHeader(rawHeader),
      expected = expectedSchema.parse(rawExpected);
    if (
      h.id !== expected.id ||
      h.ownerId !== expected.ownerId ||
      h.consentId !== expected.consentId ||
      h.reviewId !== expected.reviewId ||
      !Array.isArray(rawChunks) ||
      rawChunks.length !== h.chunks.length
    )
      fail();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    // Do not invoke a caller-supplied array map/species implementation.
    for (let i = 0; i < h.chunks.length; i++) {
      const c = rawChunks[i];
      if (!c || Object.keys(c).sort().join(',') !== 'data,index') fail();
      const index = c.index,
        data = c.data;
      if (
        index !== i ||
        !(data instanceof Uint8Array) ||
        !ArrayBuffer.isView(data) ||
        typedArrayTagDescriptor.get!.call(data) !== 'Uint8Array' ||
        typedArrayByteLengthDescriptor.get!.call(data) !== h.chunks[i].bytes
      )
        fail();
      // Typed-array construction uses internal slots, never a caller iterator.
      chunks.push(new Uint8Array(data));
    }
    if ((await digest(canonical(h))) !== expected.headerSha256) fail();
    const bytes = new Uint8Array(h.bytes);
    for (let i = 0, offset = 0; i < chunks.length; i++) {
      signal.throwIfAborted();
      if ((await sha(chunks[i])) !== h.chunks[i].sha256) fail();
      bytes.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    if ((await sha(bytes)) !== h.proposalSha256) fail();
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const { envelope, termsSha256 } = await content(JSON.parse(text), signal);
    const { terms, verifierEvidence } = envelope;
    if (
      canonical(envelope) !== text ||
      termsSha256 !== h.termsSha256 ||
      terms.verifierEvidenceSha256 !== h.verifierEvidenceSha256 ||
      verifierEvidence.assets.expiresAt !== h.proposalExpiresAt ||
      terms.intent.id !== expected.id ||
      terms.intent.ownerId !== expected.ownerId ||
      terms.intent.consentId !== expected.consentId ||
      terms.review.id !== expected.reviewId
    )
      fail();
    signal.throwIfAborted();
    return {
      ...envelope,
      termsSha256,
      proposalSha256: h.proposalSha256,
      headerSha256: expected.headerSha256,
      ...flags,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
