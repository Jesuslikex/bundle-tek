import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { pumpOwnedGroupFixture } from '../test/pump-owned-group-fixture';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import {
  preparePumpLaunchGroupReview,
  readPumpLaunchGroupReview,
  cancelUnsignedPumpLaunchGroupReview,
  listPumpLaunchGroupPage,
} from './pump-launch-group-review-service';
import { listPumpLaunches, getPumpLaunch } from './pump-launch-service';
import { pumpHistoryPageRequest } from './pump-launch-history-page';
vi.mock('./owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('./owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
const clients: Client[] = [];
const mocked = vi.mocked(preflightOwnedPumpCreate);
afterEach(() => {
  mocked.mockReset();
  for (const client of clients.splice(0)) client.close();
});
async function fixture(installed = true) {
  const f = await pumpOwnedGroupFixture(mocked, clients);
  await f.client.execute(
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
  );
  for (const file of [
    '0079_real_justice',
    '0081_pump_holder_reservations',
    ...(installed ? ['0082_pump_group_reviews'] : []),
  ])
    for (const sql of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await f.client.execute(sql);
  const prepare = () =>
    preparePumpLaunchGroupReview(
      f.db,
      'alice',
      f.terms,
      new AbortController().signal,
      f.rpc,
    );
  return { ...f, prepare };
}
it('persists and resumes a complete immutable owned review without enabling approval or signing', async () => {
  const f = await fixture(),
    result = await f.prepare();
  expect(result).toMatchObject({
    state: 'review',
    durableReview: true,
    approvalRequired: true,
    signingAllowed: false,
    executionAllowed: false,
  });
  f.calls.length = 0;
  expect(await f.prepare()).toEqual(result);
  expect(f.calls).toHaveLength(0);
  await expect(
    readPumpLaunchGroupReview(f.db, 'bob', result.review.id),
  ).rejects.toThrow('not found');
  expect(await listPumpLaunches(f.db, 'alice', 'group')).toEqual([]);
  await expect(getPumpLaunch(f.db, 'alice', result.review.id)).rejects.toThrow(
    'not found',
  );
  expect(
    (await listPumpLaunchGroupPage(f.db, 'alice', 'group', { before: null }))
      .launches,
  ).toEqual([result]);
}, 30000);
it('refuses preparation without migration guards before any provider read', async () => {
  const f = await fixture(false);
  await expect(f.prepare()).rejects.toThrow('migration is not installed');
  expect(f.calls).toHaveLength(0);
}, 30000);
it('blocks legacy launch conflicts in both directions through the database reservation guard', async () => {
  const insertLegacy = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const payer = f.input.holders[0].address;
    const document = {
      ...f.document,
      options: {
        ...f.document.options,
        wallets: {
          ...f.document.options.wallets!,
          deployer: {
            ...f.document.options.wallets!.deployer!,
            address: payer,
          },
        },
      },
    };
    await f.client.execute({
      sql: 'INSERT INTO workspace_projects VALUES(?,?,?,?,0)',
      args: ['alice', 'legacy', JSON.stringify(document), f.terms.updatedAt],
    });
    return f.client.execute({
      sql: "INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)",
      args: [
        crypto.randomUUID(),
        'alice',
        'legacy',
        payer,
        f.input.holders[3].address,
        JSON.stringify(document),
        JSON.stringify({ ...f.terms, projectId: 'legacy', payer }),
        JSON.stringify({ format: 'legacy' }),
        '{}',
        new Date().toISOString(),
        new Date(Date.now() + 59000).toISOString(),
      ],
    });
  };
  const f = await fixture();
  await f.prepare();
  await expect(insertLegacy(f)).rejects.toThrow('wallet already reserved');
  const g = await fixture();
  await insertLegacy(g);
  await expect(g.prepare()).rejects.toThrow('reservation changed');
  expect(
    (await g.client.execute('SELECT count(*) AS n FROM pump_launch_reviews'))
      .rows[0].n,
  ).toBe(1);
}, 30000);
it('reserves every active holder against shared execution while zero slots stay unreserved', async () => {
  const f = await fixture();
  await f.prepare();
  for (const scope of ['warmup', 'imported', 'withdrawal'])
    await expect(
      f.client.execute({
        sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
        args: ['alice', f.input.holders[0].address, scope, scope, 'approved'],
      }),
    ).rejects.toThrow('reserved');
  await f.client.execute({
    sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
    args: ['alice', f.input.holders[2].address, 'warmup', 'zero', 'approved'],
  });
}, 30000);
it('rejects an existing shared reservation without storing a partial review or clearing it', async () => {
  const f = await fixture();
  await f.client.execute({
    sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
    args: ['alice', f.input.holders[0].address, 'imported', 'busy', 'approved'],
  });
  await expect(f.prepare()).rejects.toThrow('reservation changed');
  expect(
    (await f.client.execute('SELECT count(*) AS n FROM pump_launch_reviews'))
      .rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM solana_execution_reservations',
      )
    ).rows[0].n,
  ).toBe(1);
}, 30000);
it('retains immutable unsigned history, blocks approval and releases reservations only on cancellation', async () => {
  const f = await fixture(),
    result = await f.prepare();
  await expect(
    f.client.execute({
      sql: "UPDATE pump_launch_reviews SET state='approved' WHERE id=?",
      args: [result.review.id],
    }),
  ).rejects.toThrow('not enabled');
  await expect(
    f.client.execute({
      sql: 'UPDATE pump_launch_reviews SET review=? WHERE id=?',
      args: ['{}', result.review.id],
    }),
  ).rejects.toThrow();
  await expect(
    f.client.execute({
      sql: 'DELETE FROM pump_launch_reviews WHERE id=?',
      args: [result.review.id],
    }),
  ).rejects.toThrow('history retained');
  await expect(
    cancelUnsignedPumpLaunchGroupReview(
      f.db,
      'bob',
      result.review.id,
      new AbortController().signal,
    ),
  ).rejects.toThrow('not found');
  expect(
    (
      await cancelUnsignedPumpLaunchGroupReview(
        f.db,
        'alice',
        result.review.id,
        new AbortController().signal,
      )
    ).state,
  ).toBe('cancelled');
  await f.client.execute({
    sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
    args: [
      'alice',
      f.input.holders[0].address,
      'warmup',
      'released',
      'approved',
    ],
  });
  expect(
    (await readPumpLaunchGroupReview(f.db, 'alice', result.review.id)).state,
  ).toBe('cancelled');
}, 30000);
it('enforces all holder ownership proofs at SQL insertion, including zero slots', async () => {
  const f = await fixture(),
    result = await f.prepare();
  const raw = (
    await f.client.execute({
      sql: 'SELECT * FROM pump_launch_reviews WHERE id=?',
      args: [result.review.id],
    })
  ).rows[0];
  await cancelUnsignedPumpLaunchGroupReview(
    f.db,
    'alice',
    result.review.id,
    new AbortController().signal,
  );
  await f.client.execute({
    sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
    args: [f.input.holders[2].address],
  });
  const id = crypto.randomUUID(),
    review = { ...result.review, id };
  // Direct SQL bypasses application crypto validation, to independently test the atomic proof guard.
  await expect(
    f.client.execute({
      sql: "INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)",
      args: [
        id,
        'alice',
        'group',
        f.terms.payer,
        f.terms.mint,
        raw.project_document,
        raw.terms,
        JSON.stringify(review),
        raw.simulation,
        new Date().toISOString(),
        review.expiresAt,
      ],
    }),
  ).rejects.toThrow('proof, role, revision');
}, 30000);
it('isolates paged group history and binds its cursor to type, project and authenticated owner', async () => {
  const f = await fixture(),
    result = await f.prepare();
  await cancelUnsignedPumpLaunchGroupReview(
    f.db,
    'alice',
    result.review.id,
    new AbortController().signal,
  );
  const raw = (
    await f.client.execute({
      sql: 'SELECT * FROM pump_launch_reviews WHERE id=?',
      args: [result.review.id],
    })
  ).rows[0];
  for (let i = 0; i < 22; i++) {
    const id = crypto.randomUUID(),
      review = { ...result.review, id };
    await f.client.execute({
      sql: "INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'review',?,?)",
      args: [
        id,
        'alice',
        'group',
        f.terms.payer,
        f.terms.mint,
        raw.project_document,
        raw.terms,
        JSON.stringify(review),
        raw.simulation,
        new Date().toISOString(),
        review.expiresAt,
      ],
    });
    await f.client.execute({
      sql: "UPDATE pump_launch_reviews SET state='cancelled' WHERE id=?",
      args: [id],
    });
  }
  const first = await listPumpLaunchGroupPage(f.db, 'alice', 'group', {
    before: null,
  });
  expect(first.launches).toHaveLength(20);
  expect(first.nextCursor).not.toBeNull();
  const params = new URLSearchParams({ page: '1', cursor: first.nextCursor! });
  const rest = await listPumpLaunchGroupPage(
    f.db,
    'alice',
    'group',
    pumpHistoryPageRequest(params, 'group', 'groups')!,
  );
  expect(rest.launches).toHaveLength(3);
  expect(
    new Set([...first.launches, ...rest.launches].map((row) => row.review.id))
      .size,
  ).toBe(23);
  expect(
    (await listPumpLaunchGroupPage(f.db, 'bob', 'group', { before: null }))
      .launches,
  ).toEqual([]);
  expect(() => pumpHistoryPageRequest(params, 'group', 'create')).toThrow(
    'Invalid',
  );
}, 30000);
