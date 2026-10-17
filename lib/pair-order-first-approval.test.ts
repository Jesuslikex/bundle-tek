import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { pairOrderFixture } from '../test/pair-order-fixture';

const runtime = vi.hoisted(() => ({
  trusted: false,
  reads: 0,
  fresh: undefined as undefined | ((candidate: never) => unknown),
}));
vi.mock('./pair-read-rpc', async (original) => ({
  ...(await original<typeof import('./pair-read-rpc')>()),
  // No provider is contacted: approval recheck evidence is a declared double.
  createPairReadRpc: () => {
    runtime.reads++;
    return { rpc: vi.fn(), programRpc: vi.fn(), close: () => {} };
  },
}));
vi.mock('./pair-runtime-preview', async (original) => ({
  ...(await original<typeof import('./pair-runtime-preview')>()),
  collectPairRuntimePreview: vi.fn(async (candidate: never) =>
    runtime.fresh!(candidate),
  ),
}));
vi.mock('./pair-trusted-programs', async (original) => {
  const real = await original<typeof import('./pair-trusted-programs')>();
  return {
    ...real,
    requirePairTrustedPrograms: (a: never, b: never) => {
      if (runtime.trusted) return true;
      return real.requirePairTrustedPrograms(a, b);
    },
  };
});
const { approveOwnedPairOrderFirstReview, prepareOwnedPairOrderFirstReview } =
  await import('./pair-order-first-service');

let f: Awaited<ReturnType<typeof pairOrderFixture>> | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  runtime.trusted = false;
  runtime.reads = 0;
  f?.close();
  f = undefined;
});
async function setup() {
  const v = (f = await pairOrderFixture());
  v.sqlite.exec(
    `CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT,observed_at TEXT);
CREATE TABLE solana_execution_reservations(owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,scope TEXT NOT NULL,intent_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,wallet_address));
CREATE TABLE pump_launch_reviews(id TEXT,owner_id TEXT,payer TEXT,state TEXT,review TEXT);`,
  );
  for (const file of [
    '0013_fresh_sandman',
    '0089_pair_order_first_reviews',
    '0090_pair_order_first_authorizations',
    '0091_pair_order_independent_price_consent',
    '0097_pair_order_executions',
  ])
    v.sqlite.exec(
      readFileSync(
        new URL(`../drizzle/${file}.sql`, import.meta.url),
        'utf8',
      ).replaceAll('--> statement-breakpoint', ''),
    );
  v.sqlite
    .prepare('INSERT INTO wallet_ownership_proofs VALUES (?,?,?,?,?)')
    .run('alice', 'Solana', v.wallet, new Date().toISOString(), 'test-proof');
  // Transactional batch, like D1.
  (v.db as unknown as { batch: unknown }).batch = async (
    statements: { run: () => Promise<{ meta: { changes: number } }> }[],
  ) => {
    v.sqlite.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      v.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      v.sqlite.exec('ROLLBACK');
      throw e;
    }
  };
  const saved = await prepareOwnedPairOrderFirstReview(
    v.db,
    'alice',
    { ...v.orderRequest, absoluteMinimumRaw: null },
    new AbortController().signal,
    v.orderDependencies,
  );
  const r = saved.review;
  const consent = {
    reviewSha256: r.sha256,
    packetSha256: r.packetSha256,
    approvedMinimumOutputRaw: r.minimumOutputRaw,
    approveExactOrder: true as const,
    acknowledgeIndependentDifference: false,
    acknowledgeUnavailableIndependentPrice: true,
  };
  runtime.fresh = (candidate: never) => {
    const c = candidate as {
      review: {
        packetSha256: string;
        sourceSnapshotSha256: string;
        minimumSlot: number;
      };
    };
    const program = {
      address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      loader: 'BPFLoaderUpgradeab1e11111111111111111111111',
      programData: null,
      deploymentSlot: '1',
      upgradeAuthority: null,
      codeSha256: 'a'.repeat(64),
      codeBytes: 1,
      identityKind: 'elf-code',
    };
    return {
      review: c.review,
      runtime: {
        sha256: 'b'.repeat(64),
        minimumSlot: c.review.minimumSlot,
        maximumSlot: c.review.minimumSlot + 4,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        codeIdentityObserved: true,
      },
      codeScans: [[program], [program]],
    };
  };
  const approve = () =>
    approveOwnedPairOrderFirstReview(
      v.db,
      'alice',
      saved.id,
      consent,
      Date.now(),
    );
  const count = (table: string) =>
    (
      v.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;
  return { v, saved, approve, count };
}

it('stays disabled without the exact server flag and performs no recheck reads', async () => {
  const { approve, count } = await setup();
  for (const value of ['', 'TRUE', '1']) {
    vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', value);
    await expect(approve()).rejects.toThrow(/disabled/);
  }
  expect(runtime.reads).toBe(0);
  expect(count('pair_order_first_authorizations')).toBe(0);
});

it('refuses with the flag on when a program is not pinned in the trusted allowlist', async () => {
  const { approve, count } = await setup();
  vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', 'true');
  await expect(approve()).rejects.toThrow(/code qualification/);
  expect(count('pair_order_first_authorizations')).toBe(0);
  expect(count('pair_order_executions')).toBe(0);
});

it('refuses when the wallet is already reserved by another swap, withdrawal or launch', async () => {
  const { v, approve, count } = await setup();
  vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', 'true');
  runtime.trusted = true;
  v.sqlite
    .prepare('INSERT INTO solana_execution_reservations VALUES (?,?,?,?,?)')
    .run('alice', v.wallet, 'withdrawal', 'w1', 'reserved');
  await expect(approve()).rejects.toThrow(/code qualification/);
  expect(count('pair_order_first_authorizations')).toBe(0);
});

it('with flag, trusted programs and a free wallet, atomically issues a sign-only authorization and reservation', async () => {
  const { v, approve, count, saved } = await setup();
  vi.stubEnv('SOLANA_STOCK_SIGNING_ENABLED', 'true');
  runtime.trusted = true;
  const auth = await approve();
  expect(auth).toMatchObject({
    scope: 'sign-exact-reviewed-packet-only',
    signingAllowed: true,
    submissionAllowed: false,
    executionAllowed: false,
    packetSha256: saved.review.packetSha256,
    execution: {
      state: 'reserved',
      reservationHeld: true,
      wallet: v.wallet,
      packetSha256: saved.review.packetSha256,
      minimumOutputRaw: saved.review.minimumOutputRaw,
    },
  });
  expect(count('pair_order_executions')).toBe(1);
  // One authorization per review: a second approval rolls back both inserts.
  await expect(approve()).rejects.toThrow();
  expect(count('pair_order_first_authorizations')).toBe(1);
  expect(count('pair_order_executions')).toBe(1);
  expect(() =>
    v.sqlite
      .prepare('INSERT INTO solana_execution_reservations VALUES (?,?,?,?,?)')
      .run('alice', v.wallet, 'imported', 'i1', 'reserved'),
  ).toThrow(/stock pair/);
});
