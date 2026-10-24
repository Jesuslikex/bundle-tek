import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import bs58 from 'bs58';
import { createTursoDatabase } from '@/db/turso';
import { pumpLaunchGroupReviewFixture } from '../test/pump-launch-group-review-fixture';
import { pumpHolderSettlementFixture } from '../test/pump-holder-settlement-fixture';
import { encodePumpSigningInput } from './pump-launch-signing';
import { PANEL_JSON_RESPONSE_BYTES } from './read-bounded-panel-json';
import type { LaunchInspectionReference } from './launch-recovery-inspection';
import {
  readLaunchRecoveryInspection,
  LaunchInspectionStoredError,
} from './launch-recovery-inspection-server';

let client: Client, db: D1Database;
const payer = bs58.encode(new Uint8Array(32).fill(1)),
  mint = bs58.encode(new Uint8Array(32).fill(2)),
  quote = bs58.encode(new Uint8Array(32).fill(3)),
  holder = bs58.encode(new Uint8Array(32).fill(4));
const signature = bs58.encode(new Uint8Array(64).fill(7)),
  sha = 'a'.repeat(64),
  updated = '2026-10-01T00:00:00.000Z';
type JsonRecord = Record<string, unknown>;
function reference(
  source: LaunchInspectionReference['source'] = 'pump',
  reviewKind: LaunchInspectionReference['reviewKind'] = source === 'pump'
    ? 'create'
    : 'single',
): LaunchInspectionReference {
  return {
    source,
    reviewKind,
    id: '00000000-0000-4000-8000-000000000001',
    projectId: 'historic-project',
    mint,
    createdAt: '2026-10-01T01:00:00.000Z',
    expiresAt: '2026-10-01T01:01:00.000Z',
  };
}
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  // Real table CHECKs only. Financial triggers/indexes and execution admission are not under test.
  for (const file of [
    '0079_real_justice.sql',
    '0145_venue_launch_recoveries.sql',
    '0146_launchlab_launch_recoveries.sql',
  ])
    await db
      .prepare(
        readFileSync(
          new URL('../drizzle/' + file, import.meta.url),
          'utf8',
        ).split('--> statement-breakpoint')[0],
      )
      .run();
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
function material(ref: LaunchInspectionReference) {
  const terms: JsonRecord = {
    projectId: ref.projectId,
    updatedAt: updated,
    releaseId: sha,
    origin: 'https://bundle.test',
    payer,
    payerRevision: 3,
    mint,
  };
  const create = {
    name: 'Historical coin',
    symbol: 'OLD',
    mint,
    payer,
    quoteMint: quote,
  };
  const review: JsonRecord = {
    id: ref.id,
    projectId: ref.projectId,
    projectUpdatedAt: updated,
    releaseId: sha,
    expiresAt: ref.expiresAt,
    sha256: sha,
    input: create,
    transaction: 'SECRET_UNSIGNED_PACKET',
    document: { secret: 'SECRET_REVIEW_DOCUMENT' },
  };
  if (ref.source === 'pump') {
    terms.feeAndRentLimitRaw = '5000';
    review.feeAndRentLimitRaw = '5000';
    if (ref.reviewKind === 'developer') {
      terms.maximumQuoteCostRaw = '100';
      review.input = {
        create,
        maximumQuoteCostRaw: '100',
        tokenAmountRaw: '200',
        transactionVersion: 1,
      };
    }
    if (ref.reviewKind === 'holders' || ref.reviewKind === 'groups') {
      terms.developerMaximumQuoteCostRaw = '100';
      review.format =
        ref.reviewKind === 'holders'
          ? 'pump-create-holders-review-v1'
          : 'pump-launch-group-review-v1';
      review.contextSha256 = sha;
      review.input = {
        create,
        developer: { maximumQuoteCostRaw: '100', tokenAmountRaw: '200' },
        holders: [
          {
            address: holder,
            kind: 'exact-quote-input',
            quoteAmountRaw: '30',
            minimumTokenOutputRaw: '40',
          },
        ],
      };
      review.allowances = {
        deployerFeeAndRentLimitRaw: '5000',
        developerMaximumQuoteCostRaw: '100',
        holders: [
          {
            address: holder,
            feeAndRentLimitRaw: '6000',
            maximumQuoteCostRaw: null,
            minimumTokenOutputRaw: '40',
          },
        ],
      };
      if (ref.reviewKind === 'groups') {
        review.manifestSha256 = sha;
        review.simulationSha256 = sha;
        review.packets = [
          { index: 0, sha256: sha, transaction: 'SECRET_GROUP_PACKET_0' },
          {
            index: 1,
            sha256: 'b'.repeat(64),
            transaction: 'SECRET_GROUP_PACKET_1',
          },
        ];
      }
    }
  } else {
    terms.devBuyRaw = '100';
    terms.solLimitLamports = '9000';
    if (ref.source === 'launchlab') terms.venue = 'LetsBonk';
    review.format =
      ref.source === 'meteora-dbc'
        ? 'meteora-dbc-launch-review-v1'
        : ref.source === 'stonkfun'
          ? 'stonkfun-launch-review-v1'
          : 'launchlab-launch-review-v1';
    review.terms = Object.fromEntries(
      Object.entries(terms).filter(([key]) => key !== 'origin'),
    );
    review.minimumSlot = 123;
    review.input = {
      ...create,
      devBuyRaw: '100',
      minTokensOutRaw: '70',
      ...(ref.source === 'launchlab' ? { venue: 'LetsBonk' } : {}),
    };
    review.summary = {
      devBuyRaw: '100',
      solLimitLamports: '9000',
      solCostLamports: '7000',
      poolCreationFeeLamports: '8000',
      ...(ref.source === 'launchlab' ? { venue: 'LetsBonk' } : {}),
    };
  }
  return { terms, review };
}
async function insert(
  ref = reference(),
  options: {
    owner?: string;
    state?: string;
    signature?: string | null;
    receipt?: string | null;
    terms?: JsonRecord;
    review?: JsonRecord;
    payer?: string;
    createdAt?: string;
    expiresAt?: string;
  } = {},
) {
  const { terms, review } = material(ref);
  const common = [
    ref.id,
    options.owner ?? 'alice',
    ref.projectId,
    options.payer ?? payer,
    ref.mint,
    'SECRET_PROJECT_DOCUMENT',
    JSON.stringify(options.terms ?? terms),
    JSON.stringify(options.review ?? review),
    options.state ?? 'review',
    'SECRET_SIGNED_PACKET',
    options.signature === undefined ? signature : options.signature,
    options.receipt === undefined
      ? JSON.stringify({ secret: 'SECRET_RECEIPT' })
      : options.receipt,
    options.createdAt ?? ref.createdAt,
    options.expiresAt ?? ref.expiresAt,
  ];
  if (ref.source === 'pump')
    await db
      .prepare(
        'INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,state,signed,signature,receipt,created_at,expires_at,simulation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(...common, 'SECRET_SIMULATION')
      .run();
  else {
    common[5] = JSON.stringify({ secret: 'SECRET_PROJECT_DOCUMENT' });
    const table =
      ref.source === 'launchlab'
        ? 'launchlab_launch_recoveries'
        : 'venue_launch_recoveries';
    await db
      .prepare(
        `INSERT INTO ${table}(id,owner_id,project_id,payer,mint,project_document,terms,review,state,signed,signature,receipt,created_at,expires_at,venue,sha256,minimum_slot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(...common, ref.source, sha, 123)
      .run();
  }
}
const read = (
  ref = reference(),
  owner = 'alice',
  signal = new AbortController().signal,
) => readLaunchRecoveryInspection(db, owner, ref, signal);
it.each(['create', 'developer', 'holders', 'groups'] as const)(
  'projects Pump %s stored evidence without opaque financial material',
  async (kind) => {
    const ref = reference('pump', kind);
    await insert(ref);
    const query = vi.spyOn(db, 'prepare'),
      fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(Error('Provider forbidden'));
    const result = await read(ref);
    expect(result).toMatchObject({
      reference: ref,
      name: 'Historical coin',
      symbol: 'OLD',
      payer,
      payerRevision: 3,
      projectUpdatedAt: updated,
      quoteMint: quote,
      recordedState: 'review',
      receiptPresent: true,
      signature,
      signatureScope:
        kind === 'groups' ? 'first-group-packet' : 'single-transaction',
      packetCount: kind === 'groups' ? 2 : 1,
      signingAllowed: false,
      executionAllowed: false,
      receiptVerified: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|"transaction"|signedEvidence|simulationLimits|completeLaunch/,
    );
    expect(query).toHaveBeenCalledOnce();
    const sql = query.mock.calls[0][0];
    expect(sql).not.toMatch(
      /project_document|\bsigned\b|\bsimulation\b|SELECT \*|JOIN|INSERT|UPDATE/i,
    );
    expect(sql).toContain('(receipt IS NOT NULL) AS hasReceipt');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each(['meteora-dbc', 'stonkfun', 'launchlab'] as const)(
  'projects %s with exact venue terms and stored-only budgets',
  async (source) => {
    const ref = reference(source);
    await insert(ref);
    const result = await read(ref);
    expect(result.reference).toEqual(ref);
    expect(result.budgets).toContainEqual({
      kind: 'developer-buy',
      address: payer,
      raw: '100',
      units: 'raw-quote',
    });
    expect(result.budgets).toContainEqual({
      kind: 'sol-cost-estimate',
      address: payer,
      raw: '7000',
      units: 'lamports',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|"transaction"|signedEvidence/,
    );
  },
);
it('preserves all holder nulls and raw-unit labels without inventing zero or SOL', async () => {
  const ref = reference('pump', 'holders');
  const { terms, review } = material(ref);
  const allowances = review.allowances as JsonRecord;
  allowances.developerMaximumQuoteCostRaw = null;
  delete (review.input as JsonRecord).developer;
  delete terms.developerMaximumQuoteCostRaw;
  await insert(ref, { terms, review });
  const result = await read(ref);
  expect(result.budgets).toContainEqual({
    kind: 'developer-max-quote',
    address: payer,
    raw: null,
    units: 'raw-quote',
  });
  expect(result.budgets).toContainEqual({
    kind: 'developer-token-output',
    address: payer,
    raw: null,
    units: 'raw-token',
  });
  expect(result.budgets).toContainEqual({
    kind: 'holder-max-quote',
    address: holder,
    raw: null,
    units: 'raw-quote',
  });
});
it('preserves explicit zero separately from absent budgets', async () => {
  const ref = reference('stonkfun'),
    { terms, review } = material(ref);
  terms.devBuyRaw = '0';
  (review.terms as JsonRecord).devBuyRaw = '0';
  (review.input as JsonRecord).devBuyRaw = '0';
  (review.summary as JsonRecord).devBuyRaw = '0';
  delete (review.input as JsonRecord).minTokensOutRaw;
  await insert(ref, { terms, review });
  const result = await read(ref);
  expect(result.budgets.find((b) => b.kind === 'developer-buy')?.raw).toBe('0');
  expect(
    result.budgets.find((b) => b.kind === 'minimum-token-output')?.raw,
  ).toBeNull();
});
it('does not need a current project or wallet table', async () => {
  await insert();
  expect((await read()).reference.projectId).toBe('historic-project');
});
it('separates owners and returns the same404 for missing and foreign records', async () => {
  await insert(reference(), { owner: 'bob' });
  await expect(read()).rejects.toMatchObject({ status: 404 });
  await expect(
    read({ ...reference(), id: 'missing-id' }),
  ).rejects.toMatchObject({ status: 404 });
  expect((await read(reference(), 'bob')).payer).toBe(payer);
});
it('selects the same record ID independently across venue tables', async () => {
  for (const source of ['pump', 'meteora-dbc', 'launchlab'] as const)
    await insert(reference(source));
  for (const source of ['pump', 'meteora-dbc', 'launchlab'] as const)
    expect((await read(reference(source))).reference.source).toBe(source);
  await expect(read(reference('stonkfun'))).rejects.toMatchObject({
    status: 404,
  });
});
it.each([
  'review',
  'approved',
  'signed',
  'submitting',
  'submitted',
  'finalized',
  'failed',
  'cancelled',
])(
  'admits legitimate saved state progression to%s without calling it verified',
  async (state) => {
    await insert(reference(), { state });
    expect(await read()).toMatchObject({
      recordedState: state,
      receiptVerified: false,
      signingAllowed: false,
      executionAllowed: false,
    });
  },
);
it.each(['reviewKind', 'projectId', 'mint', 'createdAt', 'expiresAt'] as const)(
  'refuses changed immutable reference %s',
  async (field) => {
    await insert();
    const ref = {
      ...reference(),
      [field]:
        field === 'reviewKind'
          ? 'developer'
          : field === 'mint'
            ? quote
            : field === 'createdAt' || field === 'expiresAt'
              ? '2026-10-02T00:00:00.000Z'
              : 'another-project',
    } as LaunchInspectionReference;
    await expect(read(ref)).rejects.toMatchObject({ status: 503 });
  },
);
it('explicitly refuses uncategorized formats without reading storage', async () => {
  const prepare = vi.spyOn(db, 'prepare');
  await expect(read(reference('pump', 'uncategorized'))).rejects.toMatchObject({
    status: 409,
  });
  expect(prepare).not.toHaveBeenCalled();
});
it.each([
  'id',
  'projectId',
  'projectUpdatedAt',
  'releaseId',
  'expiresAt',
  'sha256',
])('refuses corrupt Pump review binding%s', async (field) => {
  const ref = reference(),
    { review } = material(ref);
  review[field] = 'SECRET_CORRUPT_VALUE';
  await insert(ref, { review });
  await expect(read(ref)).rejects.toMatchObject({
    status: 503,
    message: 'Saved launch inspection is unavailable.',
  });
});
it.each(['payer', 'mint'])(
  'refuses nested Pump identity mismatch%s',
  async (field) => {
    const ref = reference('pump', 'developer'),
      { review } = material(ref);
    ((review.input as JsonRecord).create as JsonRecord)[field] = quote;
    await insert(ref, { review });
    await expect(read(ref)).rejects.toMatchObject({ status: 503 });
  },
);
it.each(['01', '-1', 1, '', 'SECRET', '9'.repeat(81)])(
  'refuses malformed raw budgets%j',
  async (value) => {
    const ref = reference(),
      { terms, review } = material(ref);
    terms.feeAndRentLimitRaw = value;
    review.feeAndRentLimitRaw = value;
    await insert(ref, { terms, review });
    await expect(read(ref)).rejects.toMatchObject({ status: 503 });
  },
);
it('refuses terms/review allowance mismatch', async () => {
  const ref = reference('pump', 'developer'),
    { terms, review } = material(ref);
  terms.maximumQuoteCostRaw = '99';
  await insert(ref, { terms, review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it('refuses non-Pump scalar terms differing from the stored terms', async () => {
  const ref = reference('meteora-dbc'),
    { terms, review } = material(ref);
  (review.terms as JsonRecord).solLimitLamports = '999';
  await insert(ref, { terms, review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it('refuses LaunchLab input/summary venue mismatch', async () => {
  const ref = reference('launchlab'),
    { review } = material(ref);
  (review.input as JsonRecord).venue = 'Surge';
  await insert(ref, { review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it('refuses duplicate holders and incorrect allowance addresses', async () => {
  const ref = reference('pump', 'holders'),
    { review } = material(ref);
  ((review.allowances as JsonRecord).holders as JsonRecord[])[0].address =
    quote;
  await insert(ref, { review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it('refuses reordered group packet indexes', async () => {
  const ref = reference('pump', 'groups'),
    { review } = material(ref);
  (review.packets as JsonRecord[])[1].index = 0;
  await insert(ref, { review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it.each([0, 6])('refuses group packet count%s', async (count) => {
  const ref = reference('pump', 'groups'),
    { review } = material(ref);
  review.packets = Array.from({ length: count }, (_, index) => ({
    index,
    sha256: sha,
  }));
  await insert(ref, { review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it.each(['state', 'signature'])(
  'refuses corrupt saved scalar%s',
  async (field) => {
    await insert();
    await db
      .prepare(`UPDATE pump_launch_reviews SET ${field}=?`)
      .bind('SECRET_CORRUPT')
      .run();
    await expect(read()).rejects.toMatchObject({ status: 503 });
  },
);
it.each(['projectId', 'payer', 'mint'])(
  'refuses stored Pump terms binding%s',
  async (field) => {
    const ref = reference(),
      { terms, review } = material(ref);
    terms[field] = quote;
    await insert(ref, { terms, review });
    await expect(read(ref)).rejects.toMatchObject({ status: 503 });
  },
);
it('refuses non-Pump observation-slot mismatch', async () => {
  const ref = reference('stonkfun'),
    { review } = material(ref);
  review.minimumSlot = 124;
  await insert(ref, { review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it.each(['payer', 'mint'])(
  'refuses non-Pump input identity mismatch%s',
  async (field) => {
    const ref = reference('meteora-dbc'),
      { review } = material(ref);
    (review.input as JsonRecord)[field] = quote;
    await insert(ref, { review });
    await expect(read(ref)).rejects.toMatchObject({ status: 503 });
  },
);
it('keeps missing quote selection and missing budgets explicitly unknown', async () => {
  const ref = reference(),
    { terms, review } = material(ref);
  delete (review.input as JsonRecord).quoteMint;
  delete review.feeAndRentLimitRaw;
  delete terms.feeAndRentLimitRaw;
  await insert(ref, { terms, review });
  const result = await read(ref);
  expect(result.quoteMint).toBeNull();
  expect(result.budgets).toEqual([
    { kind: 'fee-rent-limit', address: payer, raw: null, units: 'lamports' },
  ]);
});
it('bounds raw terms by UTF8 bytes as well as review text', async () => {
  await insert();
  await db
    .prepare('UPDATE pump_launch_reviews SET terms=?')
    .bind(JSON.stringify({ value: 'é'.repeat(PANEL_JSON_RESPONSE_BYTES / 2) }))
    .run();
  await expect(read()).rejects.toMatchObject({ status: 503 });
});
it('admits200 holders and refuses201 without omitting any participant', async () => {
  const ref = reference('pump', 'holders'),
    { review } = material(ref);
  const holders = Array.from({ length: 200 }, (_, index) => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, index + 1);
    return { address: bs58.encode(bytes), kind: 'none' };
  });
  (review.input as JsonRecord).holders = holders;
  delete review.allowances;
  await insert(ref, { review });
  const result = await read(ref);
  expect(result.budgets).toHaveLength(605);
  expect(result.budgets.slice(5).every((item) => item.raw === null)).toBe(true);
  expect(result.participants).toHaveLength(201);
  (review.input as JsonRecord).holders = [
    ...holders,
    { address: holder, kind: 'none' },
  ];
  await db
    .prepare('UPDATE pump_launch_reviews SET review=?')
    .bind(JSON.stringify(review))
    .run();
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it('does not parse or validate full stored receipts', async () => {
  await insert(reference(), { receipt: 'NOT_JSON_SECRET_RECEIPT' });
  expect((await read()).receiptPresent).toBe(true);
});
it('preserves absent signature and receipt markers', async () => {
  await insert(reference(), { signature: null, receipt: null });
  expect(await read()).toMatchObject({
    signature: null,
    receiptPresent: false,
  });
});
it('bounds raw JSON parsing and sanitizes malformed stored text', async () => {
  await insert();
  await db
    .prepare('UPDATE pump_launch_reviews SET review=?')
    .bind('SECRET_BAD_JSON')
    .run();
  await expect(read()).rejects.toMatchObject({
    status: 503,
    message: 'Saved launch inspection is unavailable.',
  });
  await db
    .prepare('UPDATE pump_launch_reviews SET review=?')
    .bind(' '.repeat(PANEL_JSON_RESPONSE_BYTES + 1))
    .run();
  await expect(read()).rejects.toMatchObject({ status: 503 });
});
it('fails closed on a missing source table', async () => {
  await db.prepare('DROP TABLE pump_launch_reviews').run();
  await expect(read()).rejects.toBeInstanceOf(LaunchInspectionStoredError);
});
it('cancellation wins before any query', async () => {
  const controller = new AbortController(),
    reason = Error('stopped'),
    prepare = vi.spyOn(db, 'prepare');
  controller.abort(reason);
  await expect(read(reference(), 'alice', controller.signal)).rejects.toBe(
    reason,
  );
  expect(prepare).not.toHaveBeenCalled();
});
it('cancellation after a read discards its returned row', async () => {
  await insert();
  const controller = new AbortController(),
    reason = Error('stopped');
  const actual = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = actual(sql),
      bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values),
        first = bound.first.bind(bound);
      bound.first = async (...args: Parameters<typeof first>) => {
        const result = await first(...args);
        controller.abort(reason);
        return result;
      };
      return bound;
    };
    return statement;
  });
  await expect(read(reference(), 'alice', controller.signal)).rejects.toBe(
    reason,
  );
});
it('captures the exact reference before awaiting the database', async () => {
  const ref = reference(),
    original = { ...ref };
  await insert(ref);
  const actual = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = actual(sql),
      bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values),
        first = bound.first.bind(bound);
      bound.first = async (...args: Parameters<typeof first>) => {
        const result = await first(...args);
        ref.projectId = 'mutated-after-query';
        return result;
      };
      return bound;
    };
    return statement;
  });
  expect((await read(ref)).reference).toEqual(original);
});
it.each(['exact-base-output', 'exact-quote-input'] as const)(
  'retains original holder%s target separately from its nullable allowances',
  async (kind) => {
    const ref = reference('pump', 'holders'),
      { review } = material(ref);
    const h = ((review.input as JsonRecord).holders as JsonRecord[])[0];
    h.kind = kind;
    delete h.quoteAmountRaw;
    const limit = (
      (review.allowances as JsonRecord).holders as JsonRecord[]
    )[0];
    limit.minimumTokenOutputRaw = null;
    if (kind === 'exact-base-output') {
      h.tokenAmountRaw = '1234567890123456789';
      h.maximumQuoteCostRaw = '60';
      delete h.minimumTokenOutputRaw;
    } else h.quoteAmountRaw = '789';
    await insert(ref, { review });
    const result = await read(ref);
    expect(result.budgets).toContainEqual({
      kind:
        kind === 'exact-base-output'
          ? 'holder-token-output'
          : 'holder-quote-input',
      address: holder,
      raw: kind === 'exact-base-output' ? '1234567890123456789' : '789',
      units: kind === 'exact-base-output' ? 'raw-token' : 'raw-quote',
    });
    expect(result.budgets).toContainEqual({
      kind: 'holder-max-quote',
      address: holder,
      raw: null,
      units: 'raw-quote',
    });
    expect(result.participants).toContainEqual({
      role: 'holder',
      address: holder,
      mode: kind,
    });
    expect(result.budgets).toContainEqual({
      kind:
        kind === 'exact-base-output'
          ? 'holder-input-max-quote'
          : 'holder-input-min-output',
      address: holder,
      raw: kind === 'exact-base-output' ? '60' : '40',
      units: kind === 'exact-base-output' ? 'raw-quote' : 'raw-token',
    });
    expect(
      result.budgets.some(
        (b) =>
          b.kind ===
          (kind === 'exact-base-output'
            ? 'holder-quote-input'
            : 'holder-token-output'),
      ),
    ).toBe(false);
  },
);
it('does not invent target entries for holders without retained target fields', async () => {
  const ref = reference('pump', 'holders'),
    { review } = material(ref);
  const h = ((review.input as JsonRecord).holders as JsonRecord[])[0];
  h.kind = 'none';
  delete h.quoteAmountRaw;
  delete h.minimumTokenOutputRaw;
  await insert(ref, { review });
  expect(
    (await read(ref)).budgets.some((b) =>
      ['holder-token-output', 'holder-quote-input'].includes(b.kind),
    ),
  ).toBe(false);
});
it('retains canonical80-digit display scalars without treating them as spend admission', async () => {
  const ref = reference(),
    { terms, review } = material(ref),
    amount = '9'.repeat(80);
  terms.feeAndRentLimitRaw = amount;
  review.feeAndRentLimitRaw = amount;
  await insert(ref, { terms, review });
  expect((await read(ref)).budgets[0].raw).toBe(amount);
});
it('retains every original target and input limit for200 holders under the output cap', async () => {
  const ref = reference('pump', 'holders'),
    { review } = material(ref);
  const holders = Array.from({ length: 200 }, (_, index) => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, index + 1);
    return {
      address: bs58.encode(bytes),
      kind: 'exact-quote-input',
      quoteAmountRaw: '30',
      minimumTokenOutputRaw: '40',
    };
  });
  (review.input as JsonRecord).holders = holders;
  delete review.allowances;
  await insert(ref, { review });
  expect((await read(ref)).budgets).toHaveLength(1005);
  (review.input as JsonRecord).holders = [
    ...holders,
    { address: holder, kind: 'none' },
  ];
  await db
    .prepare('UPDATE pump_launch_reviews SET review=?')
    .bind(JSON.stringify(review))
    .run();
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it.each([false, true])(
  'projects actual offline retained group review and all holder targets (stock=%s)',
  async (stock) => {
    const { review } = await pumpLaunchGroupReviewFixture(stock);
    const create = review.input.create;
    const ref: LaunchInspectionReference = {
      source: 'pump',
      reviewKind: 'groups',
      id: review.id,
      projectId: review.projectId,
      mint: create.mint,
      createdAt: new Date(Date.parse(review.expiresAt) - 10000).toISOString(),
      expiresAt: review.expiresAt,
    };
    const terms = {
      projectId: review.projectId,
      updatedAt: review.projectUpdatedAt,
      releaseId: review.releaseId,
      origin: 'https://bundle.test',
      payer: create.payer,
      payerRevision: 1,
      mint: create.mint,
      feeAndRentLimitRaw: review.allowances.deployerFeeAndRentLimitRaw,
      developerMaximumQuoteCostRaw:
        review.allowances.developerMaximumQuoteCostRaw,
      holderLimits: review.allowances.holders,
    };
    await insert(ref, {
      payer: create.payer,
      terms,
      review: JSON.parse(JSON.stringify(review)) as JsonRecord,
    });
    const result = await read(ref);
    expect(result.packetCount).toBe(review.packets.length);
    expect(result.name).toBe(create.name);
    expect(result.quoteMint).toBe(create.quoteMint);
    expect(result.signatureScope).toBe('first-group-packet');
    expect(result.hashes.filter((h) => h.kind === 'packet')).toEqual(
      review.packets.map((p) => ({
        kind: 'packet',
        index: p.index,
        sha256: p.sha256,
      })),
    );
    for (const h of review.input.holders) {
      if (h.kind === 'exact-base-output')
        expect(result.budgets).toContainEqual({
          kind: 'holder-token-output',
          address: h.address,
          raw: h.tokenAmountRaw,
          units: 'raw-token',
        });
      if (h.kind === 'exact-quote-input')
        expect(result.budgets).toContainEqual({
          kind: 'holder-quote-input',
          address: h.address,
          raw: h.quoteAmountRaw,
          units: 'raw-quote',
        });
    }
    const text = JSON.stringify(result);
    for (const packet of review.packets)
      expect(text).not.toContain(packet.transaction);
    expect(text).not.toMatch(
      /SECRET|"packets"|"transaction"|"signedEvidence"|"simulation"\s*:|"document"/,
    );
    expect(result).toMatchObject({
      signingAllowed: false,
      executionAllowed: false,
      receiptVerified: false,
    });
  },
);
it('projects both targets from actual offline holder-builder input without running settlement', async () => {
  const fixture = await pumpHolderSettlementFixture(false, false, true, true);
  const ref = {
    ...reference('pump', 'holders'),
    mint: fixture.input.create.mint,
  };
  const { terms, review } = material(ref);
  terms.payer = fixture.input.create.payer;
  terms.mint = fixture.input.create.mint;
  terms.feeAndRentLimitRaw = fixture.limits.deployerFeeAndRentLimitRaw;
  terms.developerMaximumQuoteCostRaw =
    fixture.limits.developerMaximumQuoteCostRaw;
  review.input = {
    ...fixture.input,
    create: encodePumpSigningInput(fixture.input.create),
  };
  review.allowances = fixture.limits;
  review.sha256 = fixture.packet.packetSha256;
  await insert(ref, { payer: fixture.input.create.payer, terms, review });
  const result = await read(ref);
  const base = fixture.input.holders.find(
    (h) => h.kind === 'exact-base-output',
  );
  const quoted = fixture.input.holders.find(
    (h) => h.kind === 'exact-quote-input',
  );
  expect(base?.kind).toBe('exact-base-output');
  expect(quoted?.kind).toBe('exact-quote-input');
  if (
    base?.kind !== 'exact-base-output' ||
    quoted?.kind !== 'exact-quote-input'
  )
    throw Error('Offline fixture targets unavailable.');
  expect(result.budgets).toContainEqual({
    kind: 'holder-token-output',
    address: base.address,
    raw: base.tokenAmountRaw,
    units: 'raw-token',
  });
  expect(result.budgets).toContainEqual({
    kind: 'holder-quote-input',
    address: quoted.address,
    raw: quoted.quoteAmountRaw,
    units: 'raw-quote',
  });
  expect(JSON.stringify(result)).not.toContain(fixture.packet.transaction);
});
it.each(['create', 'developer', 'holders', 'groups'] as const)(
  'records Pump%s developer intent without claiming execution',
  async (kind) => {
    const ref = reference('pump', kind);
    await insert(ref);
    expect((await read(ref)).participants[0]).toEqual({
      role: 'developer',
      address: payer,
      mode: kind === 'create' ? 'not-requested' : 'exact-base-output',
    });
  },
);
it.each(['holders', 'groups'] as const)(
  'distinguishes absent developer intent and explicit none from unknown holder mode for%s',
  async (kind) => {
    const ref = reference('pump', kind),
      { terms, review } = material(ref);
    const input = review.input as JsonRecord;
    delete input.developer;
    terms.developerMaximumQuoteCostRaw = null;
    (review.allowances as JsonRecord).developerMaximumQuoteCostRaw = null;
    const h = (input.holders as JsonRecord[])[0];
    h.kind = 'none';
    delete h.quoteAmountRaw;
    delete h.minimumTokenOutputRaw;
    await insert(ref, { terms, review });
    let result = await read(ref);
    expect(result.participants).toEqual([
      { role: 'developer', address: payer, mode: 'not-requested' },
      { role: 'holder', address: holder, mode: 'not-requested' },
    ]);
    delete h.kind;
    await db
      .prepare('UPDATE pump_launch_reviews SET review=?')
      .bind(JSON.stringify(review))
      .run();
    result = await read(ref);
    expect(result.participants[1].mode).toBe('unavailable');
  },
);
it('refuses an unrecognized holder mode instead of silently calling it unavailable', async () => {
  const ref = reference('pump', 'holders'),
    { review } = material(ref);
  ((review.input as JsonRecord).holders as JsonRecord[])[0].kind =
    'SECRET_UNKNOWN_KIND';
  await insert(ref, { review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it.each(['0', '100', null])(
  'records non-Pump developer intent for stored amount%j',
  async (amount) => {
    const ref = reference('stonkfun'),
      { terms, review } = material(ref);
    terms.devBuyRaw = amount;
    (review.terms as JsonRecord).devBuyRaw = amount;
    (review.input as JsonRecord).devBuyRaw = amount;
    (review.summary as JsonRecord).devBuyRaw = amount;
    await insert(ref, { terms, review });
    expect((await read(ref)).participants).toEqual([
      {
        role: 'developer',
        address: payer,
        mode:
          amount === null
            ? 'unavailable'
            : amount === '0'
              ? 'not-requested'
              : 'exact-quote-input',
      },
    ]);
  },
);
it('retains known terms fees separately when the review fee is unavailable', async () => {
  const ref = reference(),
    { review } = material(ref);
  delete review.feeAndRentLimitRaw;
  await insert(ref, { review });
  expect((await read(ref)).budgets).toEqual([
    { kind: 'fee-rent-limit', address: payer, raw: null, units: 'lamports' },
    {
      kind: 'terms-fee-rent-limit',
      address: payer,
      raw: '5000',
      units: 'lamports',
    },
  ]);
});
it('keeps original developer input cap distinct from an unavailable allowance', async () => {
  const ref = reference('pump', 'holders'),
    { review } = material(ref);
  (review.allowances as JsonRecord).developerMaximumQuoteCostRaw = null;
  await insert(ref, { review });
  const result = await read(ref);
  expect(result.budgets).toContainEqual({
    kind: 'developer-max-quote',
    address: payer,
    raw: null,
    units: 'raw-quote',
  });
  expect(result.budgets).toContainEqual({
    kind: 'developer-input-max-quote',
    address: payer,
    raw: '100',
    units: 'raw-quote',
  });
});
it('uses input provenance for initial developer cap rather than claiming an allowance', async () => {
  const ref = reference('pump', 'developer');
  await insert(ref);
  const result = await read(ref);
  expect(result.budgets).toContainEqual({
    kind: 'developer-input-max-quote',
    address: payer,
    raw: '100',
    units: 'raw-quote',
  });
  expect(result.budgets.some((b) => b.kind === 'developer-max-quote')).toBe(
    false,
  );
});
it('binds optional stored holder terms to allowance rows while normalizing nullable omissions', async () => {
  const ref = reference('pump', 'holders'),
    { terms, review } = material(ref);
  const limit = ((review.allowances as JsonRecord).holders as JsonRecord[])[0];
  const original = { ...limit };
  delete original.maximumQuoteCostRaw;
  terms.holderLimits = [original];
  await insert(ref, { terms, review });
  expect((await read(ref)).participants[1].mode).toBe('exact-quote-input');
});
it.each([
  'address',
  'feeAndRentLimitRaw',
  'maximumQuoteCostRaw',
  'minimumTokenOutputRaw',
] as const)('refuses stored holder terms mismatch%s', async (field) => {
  const ref = reference('pump', 'holders'),
    { terms, review } = material(ref);
  const limit = {
    ...((review.allowances as JsonRecord).holders as JsonRecord[])[0],
  };
  limit[field] = field === 'address' ? quote : '999';
  terms.holderLimits = [limit];
  await insert(ref, { terms, review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it.each([
  null,
  {},
  [],
  [{ address: holder }],
  [{ address: holder }, { address: quote }],
])(
  'refuses malformed, missing or incomplete terms holder-limit arrays%j',
  async (holderLimits) => {
    const ref = reference('pump', 'holders'),
      { terms, review } = material(ref);
    terms.holderLimits = holderLimits;
    await insert(ref, { terms, review });
    await expect(read(ref)).rejects.toMatchObject({ status: 503 });
  },
);
it('refuses present terms holder limits when review allowances are unavailable', async () => {
  const ref = reference('pump', 'holders'),
    { terms, review } = material(ref);
  terms.holderLimits = (review.allowances as JsonRecord).holders;
  delete review.allowances;
  await insert(ref, { terms, review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it('refuses reordered holder terms even when every wallet and limit is present', async () => {
  const ref = reference('pump', 'holders'),
    { terms, review } = material(ref);
  const input = review.input as JsonRecord,
    allowances = review.allowances as JsonRecord;
  (input.holders as JsonRecord[]).push({ address: quote, kind: 'none' });
  (allowances.holders as JsonRecord[]).push({
    address: quote,
    feeAndRentLimitRaw: '0',
    maximumQuoteCostRaw: null,
    minimumTokenOutputRaw: null,
  });
  terms.holderLimits = [...(allowances.holders as JsonRecord[])].reverse();
  await insert(ref, { terms, review });
  await expect(read(ref)).rejects.toMatchObject({ status: 503 });
});
it.each(
  (['holders', 'groups'] as const).flatMap((kind) =>
    (['terms', 'allowances'] as const).flatMap((source) =>
      ['0', '100'].map((amount) => ({ kind, source, amount })),
    ),
  ),
)(
  'refuses absent developer input with nonnull $source cap $amount for$kind',
  async ({ kind, source, amount }) => {
    const ref = reference('pump', kind),
      { terms, review } = material(ref);
    delete (review.input as JsonRecord).developer;
    terms.developerMaximumQuoteCostRaw = null;
    const allowances = review.allowances as JsonRecord;
    allowances.developerMaximumQuoteCostRaw = null;
    if (source === 'terms') terms.developerMaximumQuoteCostRaw = amount;
    else allowances.developerMaximumQuoteCostRaw = amount;
    await insert(ref, { terms, review });
    await expect(read(ref)).rejects.toMatchObject({ status: 503 });
  },
);
it('keeps a200-holder full retained-shape capacity projection below the1MiB transport cap', async () => {
  // Capacity model using actual offline review/input/allowance shapes. Expanding
  // its roster does not claim a reconstructed packet or financial admission.
  const { review } = await pumpLaunchGroupReviewFixture();
  const original = review.input.holders.find(
    (h) => h.kind === 'exact-base-output',
  );
  if (!original || original.kind !== 'exact-base-output')
    throw Error('Offline exact-base fixture unavailable.');
  const originalLimit = review.allowances.holders.find(
    (h) => h.address === original.address,
  );
  if (!originalLimit) throw Error('Offline allowance unavailable.');
  const holders = Array.from({ length: 200 }, (_, index) => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, index + 1);
    return { ...original, address: bs58.encode(bytes) };
  });
  review.input.holders = holders;
  review.allowances.holders = holders.map((h) => ({
    ...originalLimit,
    address: h.address,
  }));
  const create = review.input.create;
  const ref: LaunchInspectionReference = {
    source: 'pump',
    reviewKind: 'groups',
    id: review.id,
    projectId: review.projectId,
    mint: create.mint,
    createdAt: new Date(Date.parse(review.expiresAt) - 10000).toISOString(),
    expiresAt: review.expiresAt,
  };
  const terms = {
    projectId: review.projectId,
    updatedAt: review.projectUpdatedAt,
    releaseId: review.releaseId,
    origin: 'https://bundle.test',
    payer: create.payer,
    payerRevision: 1,
    mint: create.mint,
    feeAndRentLimitRaw: review.allowances.deployerFeeAndRentLimitRaw,
    developerMaximumQuoteCostRaw:
      review.allowances.developerMaximumQuoteCostRaw,
    holderLimits: review.allowances.holders,
  };
  await insert(ref, {
    payer: create.payer,
    terms,
    review: JSON.parse(JSON.stringify(review)) as JsonRecord,
  });
  const result = await read(ref);
  expect(result.participants).toHaveLength(201);
  expect(result.budgets).toHaveLength(1005);
  expect(
    result.budgets
      .filter((b) => b.kind.startsWith('holder-'))
      .every((b) =>
        b.kind === 'holder-min-output' ? b.raw === null : b.raw !== null,
      ),
  ).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(
    PANEL_JSON_RESPONSE_BYTES,
  );
  expect(result).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    receiptVerified: false,
  });
});
