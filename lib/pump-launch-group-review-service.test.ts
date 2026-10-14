import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import type { Client } from '@libsql/client';
import { pumpOwnedGroupFixture } from '../test/pump-owned-group-fixture';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import {
  preparePumpLaunchGroupReview,
  readPumpLaunchGroupReview,
  cancelUnsignedPumpLaunchGroupReview,
  listPumpLaunchGroupPage,
  refreshPumpLaunchGroupReview,
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
it('revalidates original group bytes at a fresh bank without changing the saved manifest or history', async () => {
  const f = await fixture(),
    saved = await f.prepare();
  const before = (
    await f.client.execute({
      sql: 'SELECT review,simulation,state FROM pump_launch_reviews WHERE id=?',
      args: [saved.review.id],
    })
  ).rows[0];
  f.input.create.global.slot = 200;
  f.creationPreflight.simulation.minimumSlot = 200;
  f.creationPreflight.simulation.maximumSlot = 200;
  f.creationPreflight.simulation.slot = 200;
  const rpc: import('./pump-launch-simulation').PumpLaunchRpc = async (
    method,
    params,
    signal,
  ) => {
    const value = await f.rpc(method, params, signal);
    if (value && typeof value === 'object' && 'context' in value) {
      const cloned = structuredClone(value) as { context: { slot: string } };
      cloned.context.slot = '200';
      return cloned;
    }
    return value;
  };
  const refreshed = await refreshPumpLaunchGroupReview(
    f.db,
    'alice',
    saved.review.id,
    new AbortController().signal,
    rpc,
  );
  expect(refreshed).toMatchObject({
    reviewContextSha256: saved.review.contextSha256,
    sourceRevalidated: true,
    approvalRequired: true,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(refreshed.checked.group.manifestSha256).toBe(
    saved.review.manifestSha256,
  );
  expect(refreshed.checked.simulation.bankSlot).toBe(200);
  expect(refreshed.checked.group.manifest.creationInput.global.slot).toBe(100);
  expect(
    (
      await f.client.execute({
        sql: 'SELECT review,simulation,state FROM pump_launch_reviews WHERE id=?',
        args: [saved.review.id],
      })
    ).rows[0],
  ).toEqual(before);
}, 30000);
it('rejects changed configuration bytes before replay and keeps the original review intact', async () => {
  const f = await fixture(),
    saved = await f.prepare();
  f.calls.length = 0;
  f.input.create.global.data[9] ^= 1;
  await expect(
    refreshPumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('configuration, targets or limits differ');
  expect(
    f.calls.filter((call) => call.method === 'simulateBundle'),
  ).toHaveLength(0);
  expect(
    (await readPumpLaunchGroupReview(f.db, 'alice', saved.review.id)).review
      .contextSha256,
  ).toBe(saved.review.contextSha256);
}, 30000);
it('rejects changed wallet source even when it still covers the full declared cap', async () => {
  const f = await fixture(),
    saved = await f.prepare();
  const account = f.before.get(f.input.holders[0].address)!;
  account.lamports = (BigInt(account.lamports) + 1n).toString();
  for (const [i, packet] of f.group.packets.entries()) {
    const keys = getCompiledTransactionMessageDecoder()
      .decode(
        getTransactionDecoder().decode(
          Buffer.from(packet.transaction, 'base64'),
        ).messageBytes,
      )
      .staticAccounts.map(String);
    const index = keys.indexOf(f.input.holders[0].address);
    if (index < 0) continue;
    const frame = f.response.value.transactionResults[i];
    for (const accounts of [
      frame.preExecutionAccounts,
      frame.postExecutionAccounts,
    ]) {
      const value = accounts[index]!;
      value.lamports = (BigInt(value.lamports) + 1n).toString();
    }
  }
  // Fresh funding/replay/economics are internally valid; the saved wallet source still must not silently change.
  await expect(
    refreshPumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('source, fees, deployment or economic results changed');
  expect(
    (await readPumpLaunchGroupReview(f.db, 'alice', saved.review.id)).state,
  ).toBe('review');
}, 30000);
it('rejects cancellation during revalidation without restoring or approving its old row', async () => {
  const f = await fixture(),
    saved = await f.prepare();
  let cancelled = false;
  const rpc: import('./pump-launch-simulation').PumpLaunchRpc = async (
    method,
    params,
    signal,
  ) => {
    if (!cancelled && method === 'getMinimumBalanceForRentExemption') {
      cancelled = true;
      await cancelUnsignedPumpLaunchGroupReview(
        f.db,
        'alice',
        saved.review.id,
        new AbortController().signal,
      );
    }
    return f.rpc(method, params, signal);
  };
  await expect(
    refreshPumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      new AbortController().signal,
      rpc,
    ),
  ).rejects.toThrow('review changed during revalidation');
  expect(
    (await readPumpLaunchGroupReview(f.db, 'alice', saved.review.id)).state,
  ).toBe('cancelled');
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
