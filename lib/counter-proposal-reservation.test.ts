import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { counterBuyFixture } from '../test/counter-buy-fixture';
import { initialCounterLedger } from './counter-trade';
import {
  reserveCounterProposal,
  readCounterReservation,
  type CounterReservationRequest,
} from './counter-proposal-reservation';
let mf: Miniflare,
  db: D1Database,
  owner: string,
  plan: ReturnType<typeof counterBuyFixture>['plan'],
  terms: CounterReservationRequest;
const wallet = bs58.encode(new Uint8Array(32).fill(44));
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'counter-reservation-fixture',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'counter-reservation-test' } },
        },
      },
    ],
  });
  db = await mf.getD1Database('DB', 'counter-reservation-fixture');
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,address TEXT,document TEXT,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,PRIMARY KEY(owner_id,chain,address))',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE imported_swap_preparations(id TEXT PRIMARY KEY,owner_id TEXT,project_id TEXT,project_revision INTEGER,wallet_revision INTEGER,wallet_address TEXT,document TEXT,created_at TEXT)',
    'CREATE TABLE warmup_signing_intents(id TEXT PRIMARY KEY,owner_id TEXT,preparation_id TEXT,wallet_address TEXT,document TEXT,state TEXT,signature TEXT,created_at TEXT,updated_at TEXT)',
  ])
    await db.prepare(sql).run();
  for (const file of [
    '0047_shared_swap_reservations.sql',
    '0076_flaky_crusher_hogan.sql',
    '0077_worried_owl.sql',
  ]) {
    const text = await readFile(
      new URL('../drizzle/' + file, import.meta.url),
      'utf8',
    );
    for (const sql of text
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  }
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  owner = 'owner-' + crypto.randomUUID();
  const f = counterBuyFixture();
  plan = structuredClone(f.plan);
  plan.rules.ignoredWallets = [wallet];
  plan.ledger.rulesKey = initialCounterLedger(
    plan.rules,
    plan.ledger.scope,
  ).rulesKey;
  plan.projectDocument = JSON.stringify({
    token: {
      chain: 'Solana',
      address: plan.ledger.scope.mint,
      decimals: plan.ledger.scope.decimals,
    },
  });
  await db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,0,?,?,?)')
    .bind(
      owner,
      plan.projectId,
      'Solana',
      plan.ledger.scope.mint,
      plan.projectDocument,
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,0)')
    .bind(owner, 'Solana', wallet, 1)
    .run();
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .bind(owner, 'Solana', wallet)
    .run();
  const initial = {
    ...plan,
    revision: 1,
    updatedAt: plan.createdAt,
    ledger: initialCounterLedger(plan.rules, plan.ledger.scope),
  };
  await db
    .prepare('INSERT INTO counter_trade_plans VALUES(?,?,?,?,?,?)')
    .bind(owner, plan.projectId, plan.id, 1, 'active', JSON.stringify(initial))
    .run();
  await db
    .prepare(
      'UPDATE counter_trade_plans SET revision=2,document=? WHERE owner_id=? AND project_id=? AND id=?',
    )
    .bind(JSON.stringify(plan), owner, plan.projectId, plan.id)
    .run();
  terms = {
    id: crypto.randomUUID(),
    projectId: plan.projectId,
    projectRevision: 1,
    planId: plan.id,
    planRevision: 2,
    decisionIdentity: f.identity,
    wallet,
    walletRevision: 1,
    sha256: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 29000).toISOString(),
    maximumInputRaw: '1005',
    minimumOutputRaw: plan.ledger.decisions[0].proposalTokenRaw!,
    maximumFeeAndRentRaw: '5000',
  };
});
async function preparation(id = terms.id) {
  await db
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
    .bind(
      id,
      owner,
      plan.projectId,
      1,
      1,
      wallet,
      JSON.stringify({
        side: 'Buy',
        wallet,
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: plan.ledger.scope.mint,
        transaction: { sha256: terms.sha256 },
        counter: { claimId: terms.id },
      }),
      new Date().toISOString(),
    )
    .run();
}
async function approve(
  patch: Record<string, unknown> = {},
  counterPatch: Record<string, unknown> = {},
) {
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const document = {
    format: 'counter-signing-review-v1',
    id,
    preparationId: terms.id,
    wallet,
    sha256: terms.sha256,
    expiresAt: terms.expiresAt,
    swapMode: 'ExactOut',
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: plan.ledger.scope.mint,
    inputRaw: terms.maximumInputRaw,
    minimumOutputRaw: terms.minimumOutputRaw,
    counter: {
      claimId: terms.id,
      projectId: plan.projectId,
      projectRevision: 1,
      planId: plan.id,
      planRevision: 2,
      decisionIdentity: terms.decisionIdentity,
      side: 'Buy',
      proposalTokenRaw: terms.minimumOutputRaw,
      maximumInputRaw: terms.maximumInputRaw,
      minimumOutputRaw: terms.minimumOutputRaw,
      maximumFeeAndRentRaw: terms.maximumFeeAndRentRaw,
      ...counterPatch,
    },
    ...patch,
  };
  await db
    .prepare(
      "INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',?,?)",
    )
    .bind(id, owner, terms.id, wallet, JSON.stringify(document), now, now)
    .run();
  return id;
}
it('persists one owner-scoped claim and replays reordered identical terms without another write', async () => {
  const first = await reserveCounterProposal(db, owner, terms);
  expect(first).toMatchObject({
    replayed: false,
    executionAllowed: false,
    reservation: { approvalId: null, document: { sha256: terms.sha256 } },
  });
  expect(
    await reserveCounterProposal(
      db,
      owner,
      Object.fromEntries(
        Object.entries(terms).reverse(),
      ) as CounterReservationRequest,
    ),
  ).toMatchObject({
    replayed: true,
    reservation: { document: { id: terms.id } },
  });
  expect(
    await readCounterReservation(
      db,
      'foreign',
      plan.projectId,
      plan.id,
      terms.decisionIdentity,
    ),
  ).toBeNull();
});
it('allows only one winner for simultaneous different packets for the same proposal', async () => {
  const outcomes = await Promise.allSettled([
    reserveCounterProposal(db, owner, terms),
    reserveCounterProposal(db, owner, {
      ...terms,
      id: crypto.randomUUID(),
      sha256: 'b'.repeat(64),
    }),
  ]);
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(
    (await db
      .prepare(
        'SELECT count(*) AS n FROM counter_proposal_reservations WHERE owner_id=?',
      )
      .bind(owner)
      .first<{ n: number }>())!.n,
  ).toBe(1);
});
it('rejects unknown fields, malformed units, wrong targets and unavailable owners/wallet revisions', async () => {
  for (const patch of [
    { maximumInputRaw: '1e6' },
    { maximumInputRaw: '01' },
    { minimumOutputRaw: '1' },
    { walletRevision: 2 },
    { projectRevision: 2 },
    { planRevision: 3 },
    { decisionIdentity: 'other' },
    { extra: true },
    { sha256: 'secret' },
    { maximumFeeAndRentRaw: '18446744073709551616' },
  ])
    await expect(
      reserveCounterProposal(db, owner, { ...terms, ...patch }),
    ).rejects.toThrow();
  await expect(reserveCounterProposal(db, 'foreign', terms)).rejects.toThrow();
});
it('rejects watch-only or archived wallets and newly owned wallets missing from exclusions', async () => {
  await db
    .prepare('DELETE FROM wallet_ownership_proofs WHERE owner_id=?')
    .bind(owner)
    .run();
  await expect(reserveCounterProposal(db, owner, terms)).rejects.toThrow();
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .bind(owner, 'Solana', wallet)
    .run();
  await db
    .prepare('UPDATE workspace_wallets SET archived=1 WHERE owner_id=?')
    .bind(owner)
    .run();
  await expect(reserveCounterProposal(db, owner, terms)).rejects.toThrow();
  await db
    .prepare('UPDATE workspace_wallets SET archived=0 WHERE owner_id=?')
    .bind(owner)
    .run();
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .bind(owner, 'Solana', bs58.encode(new Uint8Array(32).fill(55)))
    .run();
  await expect(reserveCounterProposal(db, owner, terms)).rejects.toThrow();
});
it('can replace an expired unapproved packet but preserves its original creation time', async () => {
  terms.expiresAt = new Date(Date.now() + 1200).toISOString();
  const first = await reserveCounterProposal(db, owner, terms);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const replacement = await reserveCounterProposal(db, owner, {
    ...terms,
    id: crypto.randomUUID(),
    sha256: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + 29000).toISOString(),
  });
  expect(replacement.reservation.document.id).not.toBe(
    first.reservation.document.id,
  );
  expect(replacement.reservation.createdAt).toBe(first.reservation.createdAt);
});
it('binds an existing signing intent atomically and permanently retains the signal even after cancellation', async () => {
  await reserveCounterProposal(db, owner, terms);
  await preparation();
  const approvalId = await approve();
  expect(
    await readCounterReservation(
      db,
      owner,
      plan.projectId,
      plan.id,
      terms.decisionIdentity,
    ),
  ).toMatchObject({ approvalId });
  await db
    .prepare(
      "UPDATE imported_swap_signing_intents SET state='cancelled' WHERE owner_id=? AND id=?",
    )
    .bind(owner, approvalId)
    .run();
  await expect(
    reserveCounterProposal(db, owner, {
      ...terms,
      id: crypto.randomUUID(),
      sha256: 'b'.repeat(64),
    }),
  ).rejects.toThrow('retained');
  await expect(
    db
      .prepare(
        'DELETE FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, approvalId)
      .run(),
  ).rejects.toThrow('retained');
  await expect(
    db
      .prepare(
        'UPDATE counter_proposal_reservations SET approval_id=NULL WHERE owner_id=?',
      )
      .bind(owner)
      .run(),
  ).rejects.toThrow('immutable');
});
it('rejects mismatched approval terms and rolls back the existing shared wallet reservation', async () => {
  await reserveCounterProposal(db, owner, terms);
  await preparation();
  for (const [patch, counterPatch] of [
    [{ sha256: 'b'.repeat(64) }, {}],
    [{ swapMode: 'ExactIn' }, {}],
    [{ outputMint: wallet }, {}],
    [{}, { maximumInputRaw: '1006' }],
    [{}, { planId: crypto.randomUUID() }],
    [{ format: 'ordinary' }, {}],
  ])
    await expect(approve(patch, counterPatch)).rejects.toThrow(
      'reserved proposal',
    );
  expect(
    await db
      .prepare('SELECT * FROM solana_swap_reservations WHERE owner_id=?')
      .bind(owner)
      .first(),
  ).toBeNull();
  expect(
    (await readCounterReservation(
      db,
      owner,
      plan.projectId,
      plan.id,
      terms.decisionIdentity,
    ))!.approvalId,
  ).toBeNull();
});
it('cannot approve without a saved reserved preparation or bypass the Counter format through an ordinary intent', async () => {
  await reserveCounterProposal(db, owner, terms);
  await expect(approve()).rejects.toThrow();
  await preparation();
  await expect(
    approve({ format: 'ordinary', counter: undefined }),
  ).rejects.toThrow('reserved proposal');
});
it('rejects stale project or paused-plan approval admission while allowing retained claim recovery', async () => {
  await reserveCounterProposal(db, owner, terms);
  await preparation();
  plan = {
    ...plan,
    revision: 3,
    state: 'paused',
    updatedAt: new Date().toISOString(),
  };
  await db
    .prepare(
      "UPDATE counter_trade_plans SET revision=3,state='paused',document=? WHERE owner_id=? AND id=?",
    )
    .bind(JSON.stringify(plan), owner, plan.id)
    .run();
  await expect(approve()).rejects.toThrow();
  expect(
    await readCounterReservation(
      db,
      owner,
      plan.projectId,
      plan.id,
      terms.decisionIdentity,
    ),
  ).not.toBeNull();
});
it('enforces canonical u64 raw budgets and retained history at the database boundary', async () => {
  await reserveCounterProposal(db, owner, {
    ...terms,
    maximumInputRaw: '18446744073709551615',
  });
  await expect(
    db
      .prepare('DELETE FROM counter_proposal_reservations WHERE owner_id=?')
      .bind(owner)
      .run(),
  ).rejects.toThrow('retained');
  const row = await readCounterReservation(
    db,
    owner,
    plan.projectId,
    plan.id,
    terms.decisionIdentity,
  );
  expect(row!.document.maximumInputRaw).toBe('18446744073709551615');
});
