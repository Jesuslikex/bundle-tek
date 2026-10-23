import type { WarmupExecutionInventoryView } from '@/lib/wallet-warmup-execution-inventory-view';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export function warmupExecutionInventoryUiFixture(count = 1) {
  const rows = Array.from({ length: count }, (_, index) => {
    const n = 2000 - index * 3;
    return {
      id: uuid(n),
      consentId: uuid(n + 1),
      reviewId: uuid(n + 2),
      headerSha256: 'a'.repeat(64),
      requestSha256: 'b'.repeat(64),
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T00:01:00.000Z',
      publishedAt: null,
      approvedAt: null,
      rootCreatedAt: null,
      rootSha256: null,
      manifestSha256: null,
      declaredBytes: 100,
      storedBytes: 0,
      storedChunks: 0,
      expectedChunks: 1,
      expired: true,
      status: 'incomplete' as const,
    };
  });
  const metadata: WarmupExecutionInventoryView = {
    format: 'wallet-warmup-execution-inventory-v1',
    scope: 'owned-metadata-only-not-content-replayed',
    snapshotAt: '2026-10-23T12:00:00.000Z',
    quota: {
      policy: 'lifetime-declared-reservations',
      maximumProposals: 128,
      maximumDeclaredBytes: 268435456,
      proposals: count,
      declaredBytes: count * 100,
      remainingProposals: 128 - count,
      remainingDeclaredBytes: 268435456 - count * 100,
      storedChunkBytes: 0,
      storedChunks: 0,
      expiredNeverApproved: count,
      incomplete: count,
      approved: 0,
      roots: 0,
      capacityReserved: false,
      pruningSupported: false,
    },
    rows: rows.slice(0, 25),
    nextCursor: null,
    contentReplayed: false,
    receiptProvenanceVerified: false,
    currentSourceVerified: false,
    currentHeadVerified: false,
    financialReservationVerified: false,
    humanApprovalVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  };
  const last = metadata.rows.at(-1);
  if (count > 25 && last)
    metadata.nextCursor = btoa(
      JSON.stringify({ createdAt: last.createdAt, id: last.id }),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  return {
    first: metadata,
    older: {
      ...structuredClone(metadata),
      rows: rows.slice(25, 50),
      nextCursor: null,
    },
  };
}
