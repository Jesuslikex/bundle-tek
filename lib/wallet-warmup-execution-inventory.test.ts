import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { warmupReconstructionFixture } from '../test/warmup-reconstruction-fixture';
import {
  solanaFamilyExclusionFixture,
  familyExclusionD1,
  advanceFamilyExclusionClock,
} from '../test/solana-family-exclusion-fixture';
import { packWarmupExecutionProposal } from './wallet-warmup-execution-proposal-codec';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { retainWarmupExecutionApproval } from './wallet-warmup-execution-approval';
import { WARMUP_EXECUTION_ACKNOWLEDGEMENT } from './wallet-warmup-execution-terms';
import {
  readWarmupExecutionInventory as read,
  parseWarmupExecutionInventoryCursor,
} from './wallet-warmup-execution-inventory';
import {
  WARMUP_PROPOSAL_SCHEMA_SHA256,
  warmupProposalSqlTokens,
} from './wallet-warmup-execution-proposal-schema';
import { WARMUP_EXECUTION_APPROVAL_SCHEMA_SHA256 } from './wallet-warmup-execution-approval-schema';
import { admitWarmupExecutionInventory } from './wallet-warmup-execution-inventory-view';
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});
const signal = () => new AbortController().signal;
function readOnly(db: D1Database, intercept?: (sql: string) => unknown) {
  const statements: string[] = [];
  return {
    statements,
    db: {
      prepare(sql: string) {
        statements.push(sql);
        if (!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql))
          throw Error('Unexpected inventory write');
        let st = db.prepare(sql);
        const w = {
          bind(...v: unknown[]) {
            st = st.bind(...v);
            return w;
          },
          async first() {
            const replacement = intercept?.(sql);
            return replacement === undefined ? st.first() : replacement;
          },
          async all() {
            return { ...(await st.all()), success: true };
          },
        };
        return w;
      },
    } as unknown as D1Database,
  };
}
async function fixture(
  kind:
    | 'incomplete'
    | 'staged'
    | 'published'
    | 'approval'
    | 'root' = 'incomplete',
) {
  const f = await warmupReconstructionFixture();
  disposals.push(f.dispose);
  const packed = await packWarmupExecutionProposal(
    {
      format: 'wallet-warmup-execution-proposal-content-v1',
      terms: f.proposed.terms,
      verifierEvidence: f.proposed.verifierEvidence,
    },
    signal(),
  );
  const request = {
    ...f.input,
    rootId: f.expected.id,
    consentId: f.expected.consentId,
    sessionExpiresAt: f.proposed.terms.intent.expiresAt,
    feeRentLimits: f.proposed.budget.feeRentLimits,
  };
  f.actual!.sqlite.prepare(
    "INSERT INTO wallet_warmup_execution_proposal_stages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).run(
    f.owner,
    f.expected.id,
    f.expected.consentId,
    f.input.reviewId,
    f.input.reviewSha256,
    f.proposed.budget.sourceSnapshotSha256,
    await digest(canonical(request)),
    canonical(packed.header),
    packed.headerSha256,
    packed.header.bytes,
    f.proposed.verifierEvidence.assets.checkedAt,
    packed.header.proposalExpiresAt,
  );
  if (kind !== 'incomplete')
    for (const c of packed.chunks)
      f.actual!.sqlite.prepare(
        'INSERT INTO wallet_warmup_execution_proposal_chunks VALUES(?,?,?,?,?)',
      ).run(
        f.owner,
        f.expected.id,
        c.index,
        c.data,
        packed.header.chunks[c.index].sha256,
      );
  if (kind === 'published' || kind === 'approval' || kind === 'root')
    f.actual!.sqlite.prepare(
      "INSERT INTO wallet_warmup_execution_proposal_publications VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(f.owner, f.expected.id, packed.headerSha256);
  if (kind === 'root' || kind === 'approval') {
    const writable = {
      prepare(sql: string) {
        const st = f.db.prepare(sql);
        const w = {
          bind(...v: unknown[]) {
            st.bind(...v);
            return w;
          },
          first: () => st.first(),
          async all() {
            return { ...(await st.all()), success: true };
          },
          async run() {
            if (
              kind === 'approval' &&
              sql.startsWith('INSERT INTO wallet_warmup_execution_roots')
            )
              throw Error('Synthetic interrupted root publication');
            return { ...(await st.run()), success: true };
          },
        };
        return w;
      },
    } as unknown as D1Database;
    const approved = retainWarmupExecutionApproval(
      writable,
      f.owner,
      {
        proposalId: f.expected.id,
        headerSha256: packed.headerSha256,
        termsSha256: f.proposed.termsSha256,
        approved: true,
        acknowledgement: WARMUP_EXECUTION_ACKNOWLEDGEMENT,
      },
      signal(),
    );
    if (kind === 'approval') await expect(approved).rejects.toThrow();
    else await approved;
  }
  return { ...f, packed, readonly: readOnly(f.db) };
}
it('reads empty owned capacity from the actual full native schema without any write or provider', async () => {
  const sqlite = solanaFamilyExclusionFixture();
  disposals.push(() => sqlite.close());
  const ro = readOnly(familyExclusionD1(sqlite));
  const result = await read(ro.db, 'owner', undefined, signal());
  expect(result.quota).toMatchObject({
    proposals: 0,
    declaredBytes: 0,
    remainingProposals: 128,
    remainingDeclaredBytes: 268435456,
    storedChunkBytes: 0,
    capacityReserved: false,
    pruningSupported: false,
  });
  expect(result.rows).toEqual([]);
  expect(result.nextCursor).toBeNull();
  expect(result.contentReplayed).toBe(false);
  expect(
    ro.statements.every((s) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(s)),
  ).toBe(true);
});
it.each(['incomplete', 'staged', 'published', 'approval', 'root'] as const)(
  'discovers actual retained %s metadata with honest declared/stored bytes',
  async (kind) => {
    const f = await fixture(kind),
      calls = f.providerCalls(),
      result = await read(f.readonly.db, f.owner, undefined, signal());
    expect(f.providerCalls()).toBe(calls);
    // Actual populated native-SQL service output, not the browser UI fixture.
    expect(admitWarmupExecutionInventory(result)).toEqual(result);
    expect(result.rows[0]).toMatchObject({
      id: f.expected.id,
      consentId: f.expected.consentId,
      reviewId: f.input.reviewId,
      status:
        kind === 'root'
          ? 'root-recorded'
          : kind === 'approval'
            ? 'approval-recorded'
            : kind,
      declaredBytes: f.packed.header.bytes,
      storedBytes: kind === 'incomplete' ? 0 : f.packed.header.bytes,
    });
    expect(result.quota.declaredBytes).toBe(f.packed.header.bytes);
    expect(result).toMatchObject({
      contentReplayed: false,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
      currentHeadVerified: false,
      humanApprovalVerified: false,
      financialReservationVerified: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /reconstruction\.invalid|verifierEvidence|transaction|sourceDocument|"data"|owner_id/,
    );
  },
);
it('keeps expired incomplete reservations charged and isolates the owner', async () => {
  const f = await fixture();
  advanceFamilyExclusionClock(f.actual!.sqlite, 60000);
  const result = await read(f.readonly.db, f.owner, undefined, signal());
  expect(result.rows[0]).toMatchObject({ expired: true, status: 'incomplete' });
  expect(result.quota).toMatchObject({
    proposals: 1,
    expiredNeverApproved: 1,
    incomplete: 1,
    declaredBytes: f.packed.header.bytes,
  });
  expect(
    (await read(f.readonly.db, 'different-owner', undefined, signal())).rows,
  ).toEqual([]);
});
it('reads actual retained inventory under SQLite query_only while actual INSERT and persistent PRAGMA writes are refused', async () => {
  const f = await fixture('root'),
    sqlite = f.actual!.sqlite;
  sqlite.exec('PRAGMA query_only=ON');
  expect(sqlite.prepare('PRAGMA query_only').get()?.query_only).toBe(1);
  expect(() =>
    sqlite.exec(
      "INSERT INTO wallet_warmup_execution_proposal_stages(owner_id,id) VALUES('query-only','probe')",
    ),
  ).toThrow(/read.?only/i);
  expect(() => sqlite.exec('PRAGMA user_version=701')).toThrow(/read.?only/i);
  const result = await read(f.readonly.db, f.owner, undefined, signal());
  expect(result.rows[0].status).toBe('root-recorded');
  // query_only is a real database-write guard, not a general PRAGMA sandbox.
  // SQLite permits this connection setting; admission must still reject it.
  sqlite.exec('PRAGMA foreign_keys=OFF');
  expect(sqlite.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(0);
  await expect(
    read(f.readonly.db, f.owner, undefined, signal()),
  ).rejects.toThrow('unavailable');
});
it.each(['headerMismatch', 'invalidChunks', 'linkMismatch'] as const)(
  'refuses actual SQL-generated %s after byte-identical immutable guards are restored',
  async (flag) => {
    const f = await fixture(flag === 'linkMismatch' ? 'root' : 'staged'),
      sqlite = f.actual!.sqlite;
    const name =
      flag === 'headerMismatch'
        ? 'warmup_proposal_stage_no_update'
        : flag === 'invalidChunks'
          ? 'warmup_proposal_chunk_no_update'
          : 'warmup_execution_root_no_update';
    const before = sqlite
      .prepare('SELECT sql FROM sqlite_master WHERE name=?')
      .get(name) as { sql: string };
    sqlite.exec(`DROP TRIGGER ${name}`);
    try {
      if (flag === 'headerMismatch')
        sqlite
          .prepare(
            "UPDATE wallet_warmup_execution_proposal_stages SET header=json_set(header,'$.id',?) WHERE owner_id=? AND id=?",
          )
          .run(crypto.randomUUID(), f.owner, f.expected.id);
      if (flag === 'invalidChunks')
        sqlite
          .prepare(
            'UPDATE wallet_warmup_execution_proposal_chunks SET sha256=? WHERE owner_id=? AND proposal_id=?',
          )
          .run('f'.repeat(64), f.owner, f.expected.id);
      if (flag === 'linkMismatch')
        sqlite
          .prepare(
            'UPDATE wallet_warmup_execution_roots SET terms_sha256=? WHERE owner_id=? AND proposal_id=?',
          )
          .run('f'.repeat(64), f.owner, f.expected.id);
    } finally {
      sqlite.exec(before.sql);
    }
    expect(
      sqlite.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)
        ?.sql,
    ).toBe(before.sql);
    await expect(
      read(f.readonly.db, f.owner, undefined, signal()),
    ).rejects.toThrow('unavailable');
    const actualSql = f.readonly.statements.find((sql) =>
      sql.startsWith('WITH selected'),
    )!;
    expect(actualSql).toBeTruthy();
    const result = sqlite.prepare(actualSql).get(f.owner) as {
      document: string;
    };
    expect(JSON.parse(result.document).rows[0][flag]).toBe(1);
  },
);
it.each(['missing', 'changed', 'foreign-keys'] as const)(
  'refuses %s schema instead of guessing capacity',
  async (kind) => {
    const sqlite = solanaFamilyExclusionFixture();
    disposals.push(() => sqlite.close());
    if (kind === 'foreign-keys') sqlite.exec('PRAGMA foreign_keys=OFF');
    else {
      sqlite.exec('DROP TRIGGER warmup_proposal_chunk_no_delete');
      if (kind === 'changed')
        sqlite.exec(
          "CREATE TRIGGER warmup_proposal_chunk_no_delete BEFORE DELETE ON wallet_warmup_execution_proposal_chunks BEGIN SELECT RAISE(ABORT,'changed');END",
        );
    }
    await expect(
      read(
        readOnly(familyExclusionD1(sqlite)).db,
        'owner',
        undefined,
        signal(),
      ),
    ).rejects.toThrow('unavailable');
  },
);
it('refuses schema drift during the read and preserves caller cancellation', async () => {
  const f = await fixture();
  let changed = false;
  const wrapped = readOnly(f.db, (sql) => {
    if (sql.startsWith('WITH selected') && !changed) {
      changed = true;
      f.actual!.sqlite.exec('DROP TRIGGER warmup_proposal_chunk_no_delete');
    }
    return undefined;
  });
  await expect(read(wrapped.db, f.owner, undefined, signal())).rejects.toThrow(
    'unavailable',
  );
  const c = new AbortController(),
    reason = Error('cancel');
  c.abort(reason);
  await expect(read(f.readonly.db, f.owner, undefined, c.signal)).rejects.toBe(
    reason,
  );
});
it('cancels an uncooperative read without waiting for the database promise', async () => {
  const c = new AbortController(),
    reason = Error('stop'),
    db = {
      prepare() {
        const st = {
          bind() {
            return st;
          },
          all() {
            queueMicrotask(() => c.abort(reason));
            return new Promise(() => {});
          },
        };
        return st;
      },
    } as unknown as D1Database;
  await expect(read(db, 'owner', undefined, c.signal)).rejects.toBe(reason);
});
type SnapshotTransport = {
  snapshotAt: string;
  count: number;
  declaredBytes: number;
  rows: Record<string, unknown>[];
};
function transport(
  f: Awaited<ReturnType<typeof fixture>>,
  change: (snapshot: SnapshotTransport) => void,
) {
  return readOnly(f.db, (sql) => {
    if (!sql.startsWith('WITH selected')) return;
    return (async () => {
      const row = await f.db
        .prepare(sql)
        .bind(f.owner)
        .first<{ document: string }>();
      const snapshot = JSON.parse(row!.document) as SnapshotTransport;
      change(snapshot);
      return { document: JSON.stringify(snapshot) };
    })();
  });
}
it('admits service-made canonical cursors for an injected 26-row snapshot in stable keyset order', async () => {
  const f = await fixture(),
    seed = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let insertNewer = false;
  const synthetic = transport(f, (s) => {
    const original = s.rows[0];
    s.rows = Array.from({ length: 26 }, (_, i) => ({
      ...original,
      id: seed(i + 1),
      consentId: seed(i + 101),
      reviewId: seed(i + 201),
    }));
    if (insertNewer)
      s.rows.unshift({
        ...original,
        id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        consentId: seed(1000),
        reviewId: seed(1001),
      });
    s.count = s.rows.length;
    s.declaredBytes = s.rows.length * Number(original.declaredBytes);
  });
  const first = await read(synthetic.db, f.owner, undefined, signal());
  // The service computes these DTOs/cursors; only the SELECT transport's row
  // expansion is injected. This is not evidence of 26 actual SQL stage writes.
  expect(admitWarmupExecutionInventory(first)).toEqual(first);
  expect(first.rows).toHaveLength(25);
  expect(first.rows[0].id).toBe(seed(26));
  expect(first.rows.at(-1)?.id).toBe(seed(2));
  expect(first.nextCursor).not.toBeNull();
  insertNewer = true;
  const second = await read(synthetic.db, f.owner, first.nextCursor, signal());
  expect(admitWarmupExecutionInventory(second, first.nextCursor!)).toEqual(
    second,
  );
  expect(second.rows.map((r) => r.id)).toEqual([seed(1)]);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(
    26,
  );
});
it.each([
  'count',
  'bytes',
  'chunk',
  'link',
  'header',
  'future',
  'duplicateIdentity',
  'storedBytes',
] as const)(
  'refuses contradictory %s metadata instead of reporting usable capacity',
  async (kind) => {
    const f = await fixture();
    const synthetic = transport(f, (s) => {
      if (kind === 'count') s.count++;
      if (kind === 'bytes') s.declaredBytes++;
      if (kind === 'chunk') s.rows[0].invalidChunks = 1;
      if (kind === 'link') s.rows[0].linkMismatch = 1;
      if (kind === 'header') s.rows[0].headerMismatch = 1;
      if (kind === 'future') s.rows[0].createdAt = '2099-01-01T00:00:00.000Z';
      if (kind === 'duplicateIdentity') s.rows[0].consentId = s.rows[0].id;
      if (kind === 'storedBytes') s.rows[0].storedBytes = 1;
    });
    await expect(
      read(synthetic.db, f.owner, undefined, signal()),
    ).rejects.toThrow('unavailable');
  },
);
it.each([
  '',
  'garbage',
  'a'.repeat(257),
  btoa('{}'),
  btoa(
    JSON.stringify({
      createdAt: '2026-01-01T00:00:00.000Z',
      id: crypto.randomUUID(),
      authority: true,
    }),
  ).replaceAll('=', ''),
])('refuses malformed cursor %s before database work', async (cursor) => {
  expect(() => parseWarmupExecutionInventoryCursor(cursor)).toThrow('cursor');
});
it('runs SELECT-only capacity through the actual Turso adapter and all unchanged migrations', async () => {
  const client = createClient({ url: 'file::memory:' });
  disposals.push(() => client.close());
  const db = createTursoDatabase(client);
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries)
    await client.executeMultiple(
      readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'),
    );
  await client.execute('PRAGMA foreign_keys=ON');
  expect(
    (await db.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>())
      ?.foreign_keys,
  ).toBe(1);
  const expected = {
    ...WARMUP_PROPOSAL_SCHEMA_SHA256,
    ...WARMUP_EXECUTION_APPROVAL_SCHEMA_SHA256,
  };
  const mismatches: string[] = [];
  for (const [name, sha] of Object.entries(expected)) {
    const row = await db
      .prepare('SELECT sql FROM sqlite_master WHERE name=?')
      .bind(name)
      .first<{ sql: string }>();
    if (!row || (await digest(warmupProposalSqlTokens(row.sql))) !== sha)
      mismatches.push(name);
  }
  expect(mismatches).toEqual([]);
  const result = await read(readOnly(db).db, 'owner', undefined, signal());
  expect(result.quota.proposals).toBe(0);
  expect(result.rows).toEqual([]);
});
it('runs SELECT-only capacity through actual disposable D1 with all unchanged migrations', async () => {
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'warmup-execution-inventory-only',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("synthetic local only")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'warmup-execution-inventory-only' } },
        },
      },
    ],
  });
  try {
    const db = (await mf.getD1Database('DB')) as unknown as D1Database;
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { tag: string }[] };
    for (const entry of journal.entries)
      await db.batch(
        readFileSync(`drizzle/${entry.tag}.sql`, 'utf8')
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    const ro = readOnly(db),
      result = await read(ro.db, 'owner', undefined, signal());
    expect(result.quota.proposals).toBe(0);
    expect(result.rows).toEqual([]);
  } finally {
    await mf.dispose();
  }
});
