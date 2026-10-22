import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import {
  bindWarmupExecutionManifest,
  warmupExecutionHash,
  warmupExecutionId,
} from './wallet-warmup-execution-manifest';

export const WARMUP_ARCHIVE_CHUNK_BYTES = 720 * 1024;
export const WARMUP_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
const maxChunks = Math.ceil(
  WARMUP_ARCHIVE_MAX_BYTES / WARMUP_ARCHIVE_CHUNK_BYTES,
);
const expectedSchema = z
  .object({
    id: warmupExecutionId,
    ownerId: z.string().min(1).max(256),
    manifestSha256: warmupExecutionHash,
  })
  .strict();
const headerSchema = expectedSchema
  .extend({
    format: z.literal('wallet-warmup-execution-archive-v1'),
    bytes: z.number().int().positive().max(WARMUP_ARCHIVE_MAX_BYTES),
    chunks: z
      .array(
        z
          .object({
            index: z
              .number()
              .int()
              .min(0)
              .max(maxChunks - 1),
            bytes: z.number().int().positive().max(WARMUP_ARCHIVE_CHUNK_BYTES),
            sha256: warmupExecutionHash,
          })
          .strict(),
      )
      .min(1)
      .max(maxChunks),
    scope: z.literal('execution-bookkeeping-model-only'),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
  })
  .strict();
type Expected = z.infer<typeof expectedSchema>;
export type WarmupExecutionArchiveHeader = z.infer<typeof headerSchema>;
export type WarmupExecutionArchiveChunk = { index: number; data: Uint8Array };
// Only private, detached copies reach this helper; do not duplicate the whole
// assembled archive again merely to hash it. Web Crypto admits the byte view.
const sha = async (data: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
function fail(): never {
  throw Error(
    'Execution archive is incomplete or differs from its expected manifest.',
  );
}
function header(value: unknown) {
  const h = headerSchema.parse(value);
  if (
    h.chunks.length !== Math.ceil(h.bytes / WARMUP_ARCHIVE_CHUNK_BYTES) ||
    h.chunks.some(
      (c, i) =>
        c.index !== i ||
        c.bytes !==
          Math.min(
            WARMUP_ARCHIVE_CHUNK_BYTES,
            h.bytes - i * WARMUP_ARCHIVE_CHUNK_BYTES,
          ),
    )
  )
    fail();
  return h;
}

/** Unmounted encoding only. Hashes are integrity links, not consent, ownership,
 * real evidence or publication authority. Chunks are BLOB bytes, not JSON/TEXT
 * fragments: a UTF8 code point may span chunks. No caller or storage is wired. */
export async function packWarmupExecutionArchive(value: unknown) {
  const bound = await bindWarmupExecutionManifest(value);
  const bytes = new TextEncoder().encode(canonical(bound.manifest));
  if (
    bytes.length > WARMUP_ARCHIVE_MAX_BYTES ||
    (await sha(bytes)) !== bound.sha256
  )
    fail();
  const chunks: WarmupExecutionArchiveChunk[] = [];
  const descriptors: WarmupExecutionArchiveHeader['chunks'] = [];
  for (
    let offset = 0;
    offset < bytes.length;
    offset += WARMUP_ARCHIVE_CHUNK_BYTES
  ) {
    const data = bytes.slice(offset, offset + WARMUP_ARCHIVE_CHUNK_BYTES);
    const index = chunks.length;
    chunks.push({ index, data });
    descriptors.push({ index, bytes: data.length, sha256: await sha(data) });
  }
  return {
    header: header({
      format: 'wallet-warmup-execution-archive-v1',
      id: bound.manifest.id,
      ownerId: bound.manifest.ownerId,
      manifestSha256: bound.sha256,
      bytes: bytes.length,
      chunks: descriptors,
      scope: 'execution-bookkeeping-model-only',
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    }),
    chunks,
  };
}

/** The expected identity/hash must come from separately admitted owned storage,
 * never from this archive itself. Complete replay still grants no authority. */
export async function unpackWarmupExecutionArchive(
  rawHeader: unknown,
  rawChunks: readonly WarmupExecutionArchiveChunk[],
  rawExpected: Expected,
) {
  // Capture all mutable inputs before the first asynchronous digest.
  const h = header(rawHeader),
    expected = expectedSchema.parse(rawExpected);
  if (
    h.id !== expected.id ||
    h.ownerId !== expected.ownerId ||
    h.manifestSha256 !== expected.manifestSha256 ||
    !Array.isArray(rawChunks) ||
    rawChunks.length !== h.chunks.length
  )
    fail();
  const chunks = rawChunks.map((chunk, i) => {
    if (
      !chunk ||
      Object.keys(chunk).sort().join(',') !== 'data,index' ||
      chunk.index !== i ||
      !(chunk.data instanceof Uint8Array) ||
      chunk.data.byteLength !== h.chunks[i].bytes
    )
      fail();
    return Uint8Array.from(chunk.data);
  });
  const bytes = new Uint8Array(h.bytes);
  for (let i = 0, offset = 0; i < chunks.length; i++) {
    if ((await sha(chunks[i])) !== h.chunks[i].sha256) fail();
    bytes.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  if ((await sha(bytes)) !== expected.manifestSha256) fail();
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const bound = await bindWarmupExecutionManifest(JSON.parse(text));
  if (
    bound.sha256 !== expected.manifestSha256 ||
    canonical(bound.manifest) !== text ||
    bound.manifest.id !== expected.id ||
    bound.manifest.ownerId !== expected.ownerId
  )
    fail();
  return {
    manifest: bound.manifest,
    manifestSha256: bound.sha256,
    scope: h.scope,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
