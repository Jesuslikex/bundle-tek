import { expect, it } from 'vitest';
import { admitWarmupExecutionInventory as admit } from './wallet-warmup-execution-inventory-view';
import { warmupExecutionInventoryUiFixture as fixture } from '@/test/warmup-execution-inventory-ui-fixture';
function chronological(
  status: ReturnType<typeof fixture>['first']['rows'][number]['status'],
) {
  const page = fixture().first,
    r = page.rows[0],
    q = page.quota;
  page.snapshotAt = '2026-10-23T00:00:45.000Z';
  r.expired = false;
  q.expiredNeverApproved = 0;
  r.status = status;
  if (status !== 'incomplete') {
    r.storedBytes = 100;
    r.storedChunks = 1;
    q.storedChunkBytes = 100;
    q.storedChunks = 1;
    q.incomplete = 0;
  }
  if (['published', 'approval-recorded', 'root-recorded'].includes(status))
    r.publishedAt = '2026-10-23T00:00:10.000Z';
  if (['approval-recorded', 'root-recorded'].includes(status)) {
    r.approvedAt = '2026-10-23T00:00:20.000Z';
    q.approved = 1;
  }
  if (status === 'root-recorded') {
    r.rootCreatedAt = '2026-10-23T00:00:30.000Z';
    r.rootSha256 = 'c'.repeat(64);
    r.manifestSha256 = 'd'.repeat(64);
    q.roots = 1;
  }
  return page;
}
it('admits empty and expired incomplete metadata while preserving lifetime reservations', () => {
  expect(admit(fixture(0).first).quota.remainingProposals).toBe(128);
  const value = admit(fixture().first);
  expect(value.quota).toMatchObject({
    proposals: 1,
    declaredBytes: 100,
    remainingProposals: 127,
    incomplete: 1,
    expiredNeverApproved: 1,
  });
  expect(value.rows[0]).toMatchObject({ expired: true, status: 'incomplete' });
});
it('binds ordered metadata pages to canonical cursors without combining their snapshots', () => {
  const { first, older } = fixture(26);
  expect(admit(first).rows).toHaveLength(25);
  expect(admit(older, first.nextCursor!).rows).toHaveLength(1);
  expect(() => admit(older)).toThrow('could not be verified');
  expect(() => admit(first, first.nextCursor!)).toThrow(
    'could not be verified',
  );
  expect(() => admit(older, first.nextCursor! + '=')).toThrow(
    'could not be verified',
  );
});
it.each(['staged', 'published', 'approval-recorded', 'root-recorded'] as const)(
  'admits only consistent %s metadata without granting authority',
  (status) => {
    const page = fixture().first,
      row = page.rows[0];
    row.storedBytes = 100;
    row.storedChunks = 1;
    row.status = status;
    page.quota.storedChunkBytes = 100;
    page.quota.storedChunks = 1;
    page.quota.incomplete = 0;
    if (status !== 'staged') row.publishedAt = '2026-10-23T00:00:10.000Z';
    if (status === 'approval-recorded' || status === 'root-recorded') {
      row.approvedAt = '2026-10-23T00:00:20.000Z';
      page.quota.approved = 1;
      page.quota.expiredNeverApproved = 0;
    }
    if (status === 'root-recorded') {
      row.rootCreatedAt = '2026-10-23T00:00:30.000Z';
      row.rootSha256 = 'c'.repeat(64);
      row.manifestSha256 = 'd'.repeat(64);
      page.quota.roots = 1;
    }
    expect(admit(page)).toMatchObject({
      contentReplayed: false,
      humanApprovalVerified: false,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
  },
);
it('derives expiry from SQL snapshot rather than the browser clock', () => {
  const page = fixture().first;
  page.snapshotAt = '2026-10-23T00:00:30.000Z';
  page.rows[0].expired = false;
  page.quota.expiredNeverApproved = 0;
  expect(admit(page).rows[0].expired).toBe(false);
  page.rows[0].expired = true;
  expect(() => admit(page)).toThrow('could not be verified');
});
it.each([
  'contentReplayed',
  'receiptProvenanceVerified',
  'currentSourceVerified',
  'currentHeadVerified',
  'financialReservationVerified',
  'humanApprovalVerified',
  'signingAllowed',
  'executionAllowed',
  'automaticExecutionAllowed',
] as const)('refuses enabled %s', (flag) => {
  const page = fixture().first;
  Object.assign(page, { [flag]: true });
  expect(() => admit(page)).toThrow('could not be verified');
});
const invalidMutations: Array<
  (p: ReturnType<typeof fixture>['first']) => void
> = [
  (p) => {
    p.quota.remainingProposals = 128;
  },
  (p) => {
    p.quota.remainingDeclaredBytes++;
  },
  (p) => {
    p.quota.storedChunkBytes = 101;
  },
  (p) => {
    p.rows[0].status = 'root-recorded';
  },
  (p) => {
    p.rows[0].storedBytes = 101;
  },
  (p) => {
    p.rows[0].expectedChunks = 2;
  },
  (p) => {
    p.rows[0].rootSha256 = 'd'.repeat(64);
  },
  (p) => {
    p.rows[0].publishedAt = p.rows[0].expiresAt;
  },
  (p) => {
    p.rows[0].createdAt = p.rows[0].expiresAt;
  },
  (p) => {
    p.rows[0].consentId = p.rows[0].id;
  },
  (p) => {
    p.rows[0].approvedAt = p.rows[0].createdAt;
  },
  (p) => {
    Object.assign(p.quota, { pruningSupported: true });
  },
  (p) => {
    Object.assign(p, { ownerId: 'private-owner' });
  },
  (p) => {
    Object.assign(p.rows[0], { transaction: 'private-data' });
  },
];
it.each(invalidMutations)(
  'refuses contradictory or additional metadata %#',
  (change) => {
    const page = fixture().first;
    change(page);
    expect(() => admit(page)).toThrow('could not be verified');
  },
);
it('refuses duplicate, unordered, missing and altered cursor rows', () => {
  const page = fixture(26).first;
  const mutations = [
    (p: typeof page) => {
      p.rows.reverse();
    },
    (p: typeof page) => {
      p.rows[1].id = p.rows[0].id;
    },
    (p: typeof page) => {
      p.rows[1].reviewId = p.rows[0].consentId;
    },
    (p: typeof page) => {
      p.rows.pop();
    },
    (p: typeof page) => {
      p.nextCursor = null;
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(page);
    mutate(copy);
    expect(() => admit(copy)).toThrow('could not be verified');
  }
});

it('admits exact lifetime ceilings and rejects a count, byte or policy overflow', () => {
  expect(admit(fixture(128).first).quota.remainingProposals).toBe(0);
  const exact = fixture(4).first;
  for (const r of exact.rows) {
    r.declaredBytes = 67108864;
    r.expectedChunks = Math.ceil(r.declaredBytes / 196608);
  }
  exact.quota.declaredBytes = 268435456;
  exact.quota.remainingDeclaredBytes = 0;
  expect(admit(exact).quota.remainingDeclaredBytes).toBe(0);
  const overCount = fixture(128).first;
  overCount.quota.proposals = 129;
  expect(() => admit(overCount)).toThrow();
  const overBytes = structuredClone(exact);
  overBytes.quota.declaredBytes++;
  expect(() => admit(overBytes)).toThrow();
  const wrongMaximum = fixture().first;
  Object.assign(wrongMaximum.quota, { maximumProposals: 129 });
  expect(() => admit(wrongMaximum)).toThrow();
  const impossible = fixture().first;
  impossible.quota.declaredBytes = 67108865;
  impossible.quota.remainingDeclaredBytes = 268435456 - 67108865;
  expect(() => admit(impossible)).toThrow();
});
it.each(['createdAt', 'publishedAt', 'approvedAt', 'rootCreatedAt'] as const)(
  'refuses %s later than the snapshot with otherwise valid parent chronology',
  (field) => {
    const status =
      field === 'createdAt'
        ? 'incomplete'
        : field === 'publishedAt'
          ? 'published'
          : field === 'approvedAt'
            ? 'approval-recorded'
            : 'root-recorded';
    const page = chronological(status);
    expect(() => admit(page)).not.toThrow();
    page.rows[0][field] = '2026-10-23T00:00:50.000Z';
    expect(() => admit(page)).toThrow();
  },
);
it('refuses approval before publication and root before approval with valid parents and counts', () => {
  const approval = chronological('approval-recorded');
  expect(() => admit(approval)).not.toThrow();
  approval.rows[0].approvedAt = '2026-10-23T00:00:05.000Z';
  expect(() => admit(approval)).toThrow();
  const root = chronological('root-recorded');
  expect(() => admit(root)).not.toThrow();
  root.rows[0].rootCreatedAt = '2026-10-23T00:00:15.000Z';
  expect(() => admit(root)).toThrow();
});
it('uses createdAt before ID when a page crosses different timestamp boundaries', () => {
  const { first, older } = fixture(26);
  first.rows.forEach((r, index) => {
    r.createdAt = new Date(Date.parse(r.createdAt) + 25 - index).toISOString();
  });
  const last = first.rows.at(-1)!;
  first.nextCursor = btoa(
    JSON.stringify({ createdAt: last.createdAt, id: last.id }),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  older.rows[0].id = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  expect(() => admit(first)).not.toThrow();
  expect(admit(older, first.nextCursor).rows).toHaveLength(1);
  older.rows[0].createdAt = last.createdAt;
  expect(() => admit(older, first.nextCursor!)).toThrow();
});
