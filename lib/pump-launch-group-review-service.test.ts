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
  approvePumpLaunchGroupReview,
  registerPumpLaunchGroupSignatures,
} from './pump-launch-group-review-service';
import { listPumpLaunches, getPumpLaunch } from './pump-launch-service';
import { pumpHistoryPageRequest } from './pump-launch-history-page';
import { signSyntheticPumpGroup } from '../test/pump-group-synthetic-signatures';
import type {
  PumpLaunchGroupReview,
  PumpLaunchGroupConsent,
} from './pump-launch-group-review';
vi.mock('./owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('./owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
const clients: Client[] = [];
const mocked = vi.mocked(preflightOwnedPumpCreate);
afterEach(() => {
  mocked.mockReset();
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});
async function fixture(
  installed = true,
  approvalInstalled = true,
  signaturesInstalled = true,
  sqlClock?: Date,
) {
  const f = await pumpOwnedGroupFixture(mocked, clients);
  await f.client.execute(
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
  );
  for (const file of [
    '0079_real_justice',
    '0081_pump_holder_reservations',
    ...(installed ? ['0082_pump_group_reviews'] : []),
    ...(installed && approvalInstalled ? ['0083_pump_group_approvals'] : []),
    ...(installed && approvalInstalled && signaturesInstalled
      ? ['0084_pump_group_signatures']
      : []),
  ])
    for (const sql of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim())
        // Only this disposable fixture replaces SQLite's wall clock. Keep all
        // production trigger conditions and freshness durations unchanged.
        await f.client.execute(
          sqlClock
            ? sql.replaceAll(
                "julianday('now')",
                `julianday('${sqlClock.toISOString()}')`,
              )
            : sql,
        );
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
const consentFor = (review: PumpLaunchGroupReview): PumpLaunchGroupConsent => ({
  approved: true,
  reviewId: review.id,
  manifestSha256: review.manifestSha256,
  contextSha256: review.contextSha256,
  simulationSha256: review.simulationSha256,
  approvedScope: 'complete-create-developer-holder-packet-group',
  acknowledgeSimulationLimits: true,
});
const signFor = (
  f: Awaited<ReturnType<typeof fixture>>,
  review: PumpLaunchGroupReview,
) =>
  signSyntheticPumpGroup(review.packets, [
    f.f.f.payerSigner,
    f.f.f.mintSigner,
    ...f.holderSigners,
  ]);
it('atomically retains the whole approved signed group, resumes exact data and never enables submission', async () => {
  const clock = new Date('2026-10-15T12:00:00.000Z');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  const f = await fixture(true, true, true, clock),
    saved = await f.prepare(),
    consent = consentFor(saved.review);
  await approvePumpLaunchGroupReview(
    f.db,
    'alice',
    saved.review.id,
    consent,
    new AbortController().signal,
    f.rpc,
  );
  const transactions = await signFor(f, saved.review);
  f.calls.length = 0;
  const registered = await registerPumpLaunchGroupSignatures(
    f.db,
    'alice',
    saved.review.id,
    consent,
    transactions,
    new AbortController().signal,
  );
  expect(registered).toMatchObject({
    state: 'signed',
    approvalRequired: false,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  expect(
    registered.signedEvidence!.packets.map((packet) => packet.transaction),
  ).toEqual(transactions);
  expect(
    await registerPumpLaunchGroupSignatures(
      f.db,
      'alice',
      saved.review.id,
      consent,
      transactions,
      new AbortController().signal,
    ),
  ).toEqual(registered);
  expect(
    (await f.client.execute('SELECT count(*) AS n FROM pump_group_signatures'))
      .rows[0].n,
  ).toBe(1);
  expect(f.calls).toHaveLength(0);
  await expect(
    f.client.execute("UPDATE pump_group_signatures SET signed='{}'"),
  ).rejects.toThrow('Immutable');
  await expect(
    f.client.execute('DELETE FROM pump_group_signatures'),
  ).rejects.toThrow('history retained');
  await expect(
    f.client.execute({
      sql: "UPDATE pump_launch_reviews SET state='submitting' WHERE id=?",
      args: [saved.review.id],
    }),
  ).rejects.toThrow('not enabled');
  await expect(
    f.client.execute({
      sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
      args: ['alice', f.input.holders[0].address, 'warmup', 'busy', 'approved'],
    }),
  ).rejects.toThrow('reserved');
}, 120000);
it('requires exact recorded approval and complete signatures before writing registration', async () => {
  const f = await fixture(),
    saved = await f.prepare(),
    consent = consentFor(saved.review),
    transactions = await signFor(f, saved.review);
  await expect(
    registerPumpLaunchGroupSignatures(
      f.db,
      'alice',
      saved.review.id,
      consent,
      transactions,
      new AbortController().signal,
    ),
  ).rejects.toThrow('Approve the exact');
  await approvePumpLaunchGroupReview(
    f.db,
    'alice',
    saved.review.id,
    consent,
    new AbortController().signal,
    f.rpc,
  );
  await expect(
    registerPumpLaunchGroupSignatures(
      f.db,
      'bob',
      saved.review.id,
      consent,
      transactions,
      new AbortController().signal,
    ),
  ).rejects.toThrow('not found');
  await expect(
    registerPumpLaunchGroupSignatures(
      f.db,
      'alice',
      saved.review.id,
      consent,
      transactions.slice(1),
      new AbortController().signal,
    ),
  ).rejects.toThrow('Every exact');
  expect(
    (await f.client.execute('SELECT count(*) AS n FROM pump_group_signatures'))
      .rows[0].n,
  ).toBe(0);
}, 30000);
it('rolls back signature evidence when its atomic parent transition fails', async () => {
  const f = await fixture(),
    saved = await f.prepare(),
    consent = consentFor(saved.review);
  await approvePumpLaunchGroupReview(
    f.db,
    'alice',
    saved.review.id,
    consent,
    new AbortController().signal,
    f.rpc,
  );
  const transactions = await signFor(f, saved.review);
  await f.client.execute(
    "CREATE TRIGGER test_signed_transition_failure BEFORE UPDATE OF state ON pump_launch_reviews WHEN NEW.state='signed' BEGIN SELECT RAISE(ABORT,'Controlled signed transition failure'); END;",
  );
  await expect(
    registerPumpLaunchGroupSignatures(
      f.db,
      'alice',
      saved.review.id,
      consent,
      transactions,
      new AbortController().signal,
    ),
  ).rejects.toThrow('signature state changed');
  expect(
    (await f.client.execute('SELECT count(*) AS n FROM pump_group_signatures'))
      .rows[0].n,
  ).toBe(0);
  expect(
    (await readPumpLaunchGroupReview(f.db, 'alice', saved.review.id)).state,
  ).toBe('approved');
}, 30000);
it('requires signature migration without generating permission or calling a provider', async () => {
  const f = await fixture(true, true, false),
    saved = await f.prepare(),
    consent = consentFor(saved.review);
  await approvePumpLaunchGroupReview(
    f.db,
    'alice',
    saved.review.id,
    consent,
    new AbortController().signal,
    f.rpc,
  );
  f.calls.length = 0;
  await expect(
    registerPumpLaunchGroupSignatures(
      f.db,
      'alice',
      saved.review.id,
      consent,
      [],
      new AbortController().signal,
    ),
  ).rejects.toThrow('signature migration');
  expect(f.calls).toHaveLength(0);
}, 30000);
it('uses historical review validation for registration when the application clock crosses expiry', async () => {
  const f = await fixture(),
    saved = await f.prepare(),
    consent = consentFor(saved.review);
  await approvePumpLaunchGroupReview(
    f.db,
    'alice',
    saved.review.id,
    consent,
    new AbortController().signal,
    f.rpc,
  );
  const transactions = await signFor(f, saved.review);
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(saved.review.expiresAt) + 1);
  try {
    expect(
      (
        await registerPumpLaunchGroupSignatures(
          f.db,
          'alice',
          saved.review.id,
          consent,
          transactions,
          new AbortController().signal,
        )
      ).state,
    ).toBe('signed');
  } finally {
    clock.mockRestore();
  }
}, 30000);
it('atomically records exact consent and approval while retaining all reservations and disabled signing', async () => {
  const f = await fixture(),
    saved = await f.prepare();
  const consent = consentFor(saved.review);
  const approved = await approvePumpLaunchGroupReview(
    f.db,
    'alice',
    saved.review.id,
    consent,
    new AbortController().signal,
    f.rpc,
  );
  expect(approved).toMatchObject({
    state: 'approved',
    approvalRequired: false,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  const record = (await f.client.execute('SELECT * FROM pump_group_approvals'))
    .rows[0];
  expect(JSON.parse(record.consent as string)).toEqual(consent);
  expect(JSON.parse(record.fresh as string).sourceRevalidated).toBe(true);
  expect(
    await approvePumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      consent,
      new AbortController().signal,
      f.rpc,
    ),
  ).toEqual(approved);
  expect(
    (await f.client.execute('SELECT count(*) AS n FROM pump_group_approvals'))
      .rows[0].n,
  ).toBe(1);
  await expect(
    f.client.execute("UPDATE pump_group_approvals SET fresh='{}'"),
  ).rejects.toThrow('Immutable');
  await expect(
    f.client.execute('DELETE FROM pump_group_approvals'),
  ).rejects.toThrow('history retained');
  await expect(
    cancelUnsignedPumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      new AbortController().signal,
    ),
  ).rejects.toThrow('never-approved');
  await expect(
    f.client.execute({
      sql: "UPDATE pump_launch_reviews SET state='signed',signed='invalid',signature='invalid' WHERE id=?",
      args: [saved.review.id],
    }),
  ).rejects.toThrow('not enabled');
  await expect(
    f.client.execute({
      sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
      args: ['alice', f.input.holders[0].address, 'warmup', 'busy', 'approved'],
    }),
  ).rejects.toThrow('reserved');
}, 30000);
it('requires approval migration and exact simulation consent before fresh provider reads', async () => {
  const f = await fixture(true, false),
    saved = await f.prepare();
  f.calls.length = 0;
  await expect(
    approvePumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      consentFor(saved.review),
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('approval migration');
  expect(f.calls).toHaveLength(0);
  const g = await fixture(),
    review = await g.prepare();
  g.calls.length = 0;
  await expect(
    approvePumpLaunchGroupReview(
      g.db,
      'alice',
      review.review.id,
      { ...consentFor(review.review), simulationSha256: 'f'.repeat(64) },
      new AbortController().signal,
      g.rpc,
    ),
  ).rejects.toThrow('Explicit approval');
  expect(g.calls).toHaveLength(0);
}, 30000);
it('rolls back the consent row when the atomic parent transition itself fails', async () => {
  const f = await fixture(),
    saved = await f.prepare();
  await f.client.execute(
    "CREATE TRIGGER test_group_transition_failure BEFORE UPDATE OF state ON pump_launch_reviews WHEN NEW.state='approved' BEGIN SELECT RAISE(ABORT,'Controlled transition failure'); END;",
  );
  await expect(
    approvePumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      consentFor(saved.review),
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('approval ownership');
  expect(
    (await f.client.execute('SELECT count(*) AS n FROM pump_group_approvals'))
      .rows[0].n,
  ).toBe(0);
  expect(
    (await readPumpLaunchGroupReview(f.db, 'alice', saved.review.id)).state,
  ).toBe('review');
}, 30000);
it('rolls back approval at the atomic insert boundary when a zero-slot ownership proof is revoked', async () => {
  const f = await fixture(),
    saved = await f.prepare();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind')
          return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'run')
          return async () => {
            await f.client.execute({
              sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
              args: [f.input.holders[2].address],
            });
            return target.run();
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return sql.startsWith('INSERT INTO pump_group_approvals')
            ? wrap(statement)
            : statement;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    approvePumpLaunchGroupReview(
      db,
      'alice',
      saved.review.id,
      consentFor(saved.review),
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('approval ownership');
  expect(
    (await f.client.execute('SELECT count(*) AS n FROM pump_group_approvals'))
      .rows[0].n,
  ).toBe(0);
  expect(
    (await readPumpLaunchGroupReview(f.db, 'alice', saved.review.id)).state,
  ).toBe('review');
}, 30000);
it('persists and resumes a complete immutable owned review without enabling approval or signing', async () => {
  const f = await fixture(),
    result = await f.prepare();
  expect(result).toMatchObject({
    state: 'review',
    durableReview: true,
    approvalRequired: true,
    signingAllowed: false,
    executionAllowed: false,
    receipt: null,
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
  const stored = await f.db
    .prepare(
      'SELECT created_at FROM pump_launch_reviews WHERE owner_id=? AND id=?',
    )
    .bind('alice', result.review.id)
    .first<{ created_at: string }>();
  expect(stored).not.toBeNull();
  expect(
    (await listPumpLaunchGroupPage(f.db, 'alice', 'group', { before: null }))
      .launches,
  ).toEqual([{ ...result, createdAt: stored!.created_at }]);
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
