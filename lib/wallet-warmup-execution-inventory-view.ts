import { z } from 'zod';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.uuid().refine((value) => value === value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso
  .datetime()
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
const cursor = z.object({ createdAt: timestamp, id }).strict();
function encodeCursor(value: z.infer<typeof cursor>) {
  return btoa(JSON.stringify({ createdAt: value.createdAt, id: value.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function decodeCursor(value: string) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw Error();
  const parsed = cursor.parse(
    JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))),
  );
  if (encodeCursor(parsed) !== value) throw Error();
  return parsed;
}
const row = z
  .object({
    id,
    consentId: id,
    reviewId: id,
    headerSha256: hash,
    requestSha256: hash,
    createdAt: timestamp,
    expiresAt: timestamp,
    publishedAt: timestamp.nullable(),
    approvedAt: timestamp.nullable(),
    rootCreatedAt: timestamp.nullable(),
    rootSha256: hash.nullable(),
    manifestSha256: hash.nullable(),
    declaredBytes: integer.min(1).max(67108864),
    storedBytes: integer,
    storedChunks: integer,
    expectedChunks: integer,
    expired: z.boolean(),
    status: z.enum([
      'incomplete',
      'staged',
      'published',
      'approval-recorded',
      'root-recorded',
    ]),
  })
  .strict();
const schema = z
  .object({
    format: z.literal('wallet-warmup-execution-inventory-v1'),
    scope: z.literal('owned-metadata-only-not-content-replayed'),
    snapshotAt: timestamp,
    quota: z
      .object({
        policy: z.literal('lifetime-declared-reservations'),
        maximumProposals: z.literal(128),
        maximumDeclaredBytes: z.literal(268435456),
        proposals: integer.max(128),
        declaredBytes: integer.max(268435456),
        remainingProposals: integer,
        remainingDeclaredBytes: integer,
        storedChunkBytes: integer,
        storedChunks: integer,
        expiredNeverApproved: integer,
        incomplete: integer,
        approved: integer,
        roots: integer,
        capacityReserved: z.literal(false),
        pruningSupported: z.literal(false),
      })
      .strict(),
    rows: z.array(row).max(25),
    nextCursor: z.string().max(256).nullable(),
    contentReplayed: z.literal(false),
    receiptProvenanceVerified: z.literal(false),
    currentSourceVerified: z.literal(false),
    currentHeadVerified: z.literal(false),
    financialReservationVerified: z.literal(false),
    humanApprovalVerified: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
  })
  .strict();
export type WarmupExecutionInventoryView = z.infer<typeof schema>;

/** Browser-only metadata admission. No content, currentness, human or financial authority. */
export function admitWarmupExecutionInventory(value: unknown, before?: string) {
  try {
    const page = schema.parse(value),
      q = page.quota,
      boundary = before === undefined ? null : decodeCursor(before);
    if (
      q.declaredBytes > q.proposals * 67108864 ||
      q.remainingProposals !== 128 - q.proposals ||
      q.remainingDeclaredBytes !== 268435456 - q.declaredBytes ||
      q.storedChunkBytes > q.declaredBytes ||
      q.storedChunks > q.storedChunkBytes ||
      q.storedChunkBytes > q.storedChunks * 196608 ||
      q.proposals > q.declaredBytes ||
      q.incomplete + q.approved > q.proposals ||
      q.roots > q.approved ||
      q.expiredNeverApproved > q.proposals - q.approved ||
      page.rows.length > q.proposals ||
      (!boundary && q.proposals > 0 && page.rows.length === 0) ||
      (q.proposals === 0 && (q.declaredBytes !== 0 || q.storedChunks !== 0))
    )
      throw Error();
    const seen = new Set<string>();
    let bytes = 0,
      stored = 0,
      chunks = 0,
      approved = 0,
      roots = 0,
      incomplete = 0,
      expired = 0;
    let previous = boundary;
    for (const r of page.rows) {
      const expectedStatus =
        r.rootCreatedAt !== null
          ? 'root-recorded'
          : r.approvedAt !== null
            ? 'approval-recorded'
            : r.publishedAt !== null
              ? 'published'
              : r.storedChunks === r.expectedChunks
                ? 'staged'
                : 'incomplete';
      if (
        [r.id, r.reviewId, r.consentId].some((i) => seen.has(i)) ||
        new Set([r.id, r.reviewId, r.consentId]).size !== 3 ||
        (previous &&
          !(
            r.createdAt < previous.createdAt ||
            (r.createdAt === previous.createdAt && r.id < previous.id)
          )) ||
        r.createdAt >= r.expiresAt ||
        r.createdAt > page.snapshotAt ||
        r.expired !== page.snapshotAt >= r.expiresAt ||
        r.status !== expectedStatus ||
        r.expectedChunks !== Math.ceil(r.declaredBytes / 196608) ||
        r.storedChunks > r.expectedChunks ||
        r.storedBytes > r.declaredBytes ||
        r.storedBytes < r.storedChunks ||
        r.storedBytes > r.storedChunks * 196608 ||
        (r.storedChunks === r.expectedChunks &&
          r.storedBytes !== r.declaredBytes) ||
        (r.publishedAt !== null &&
          (r.storedChunks !== r.expectedChunks ||
            r.publishedAt < r.createdAt ||
            r.publishedAt >= r.expiresAt ||
            r.publishedAt > page.snapshotAt)) ||
        (r.approvedAt !== null &&
          (r.publishedAt === null ||
            r.approvedAt < r.publishedAt ||
            r.approvedAt >= r.expiresAt ||
            r.approvedAt > page.snapshotAt)) ||
        (r.rootCreatedAt !== null &&
          (r.approvedAt === null ||
            r.rootCreatedAt < r.approvedAt ||
            r.rootCreatedAt >= r.expiresAt ||
            r.rootCreatedAt > page.snapshotAt)) ||
        (r.rootCreatedAt === null) !== (r.rootSha256 === null) ||
        (r.rootCreatedAt === null) !== (r.manifestSha256 === null)
      )
        throw Error();
      [r.id, r.reviewId, r.consentId].forEach((i) => seen.add(i));
      previous = r;
      bytes += r.declaredBytes;
      stored += r.storedBytes;
      chunks += r.storedChunks;
      approved += Number(r.approvedAt !== null);
      roots += Number(r.rootCreatedAt !== null);
      incomplete += Number(r.status === 'incomplete');
      expired += Number(r.expired && r.approvedAt === null);
    }
    if (
      bytes > q.declaredBytes ||
      stored > q.storedChunkBytes ||
      chunks > q.storedChunks ||
      approved > q.approved ||
      roots > q.roots ||
      incomplete > q.incomplete ||
      expired > q.expiredNeverApproved
    )
      throw Error();
    if (
      !boundary &&
      page.rows.length === q.proposals &&
      (bytes !== q.declaredBytes ||
        stored !== q.storedChunkBytes ||
        chunks !== q.storedChunks ||
        approved !== q.approved ||
        roots !== q.roots ||
        incomplete !== q.incomplete ||
        expired !== q.expiredNeverApproved)
    )
      throw Error();
    if (page.nextCursor !== null) {
      const last = page.rows.at(-1);
      if (
        !last ||
        page.rows.length !== 25 ||
        q.proposals <= page.rows.length ||
        page.nextCursor !== encodeCursor(last)
      )
        throw Error();
      decodeCursor(page.nextCursor);
    } else if (!boundary && q.proposals > page.rows.length) throw Error();
    return page;
  } catch {
    throw Error(
      'Stored warmup metadata response could not be verified. No record was changed.',
    );
  }
}
export const WARMUP_EXECUTION_INVENTORY_LABELS = {
  incomplete: 'Incomplete stored proposal',
  staged: 'All proposal chunks stored',
  published: 'Published for review',
  'approval-recorded': 'Approval metadata recorded',
  'root-recorded': 'Root metadata recorded',
} as const;
