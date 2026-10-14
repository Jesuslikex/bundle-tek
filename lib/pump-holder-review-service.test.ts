import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '../db/turso';
import { pumpHolderSettlementFixture } from '../test/pump-holder-settlement-fixture';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from './workspace-project';
import { preflightOwnedPumpHolderSimulation } from './pump-holder-preparation';
import {
  preparePumpHolderReview,
  refreshPumpHolderReview,
  listPumpHolderReviews,
  cancelUnsignedPumpHolderReview,
  approvePumpHolderReview,
  registerPumpHolderSignedPacket,
} from './pump-holder-review-service';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
  requirePumpHolderReview,
  type PumpHolderReview,
} from './pump-holder-review';
import type { PumpHolderConsent } from './pump-holder-signing';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  address,
  type SignatureBytes,
} from '@solana/kit-v1';
import { listPumpLaunches } from './pump-launch-service';
import {
  buildPumpCreateHolderMessage,
  type PumpHolderBuy,
} from './pump-holder-message';
import type { PumpLaunchRpc } from './pump-launch-simulation';
vi.mock('./pump-holder-preparation', async (original) => ({
  ...(await original<typeof import('./pump-holder-preparation')>()),
  preflightOwnedPumpHolderSimulation: vi.fn(),
}));
const mocked = vi.mocked(preflightOwnedPumpHolderSimulation),
  clients: Client[] = [];
beforeEach(() => {
  mocked.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.close();
});
const consentFor = (review: PumpHolderReview): PumpHolderConsent => ({
  approved: true,
  reviewId: review.id,
  sha256: review.sha256,
  contextSha256: review.contextSha256,
  approvedScope: 'create-developer-and-holder-buys',
  acknowledgeSimulationLimits: true,
});
async function syntheticSigned(
  f: Awaited<ReturnType<typeof fixture>>,
  review: PumpHolderReview,
) {
  const tx = getTransactionDecoder().decode(
      Buffer.from(review.transaction, 'base64'),
    ),
    signatures = { ...tx.signatures };
  for (const signer of [
    f.g.f.f.payerSigner,
    f.g.f.f.mintSigner,
    ...f.g.holderSigners,
  ]) {
    if (!(signer.address in signatures)) continue;
    signatures[address(signer.address)] = new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        signer.keyPair.privateKey,
        Uint8Array.from(tx.messageBytes),
      ),
    ) as SignatureBytes;
  }
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({ ...tx, signatures }),
  );
}
const rpc: PumpLaunchRpc = async () => {
  throw new Error('Unexpected provider read outside the mocked preflight');
};
const signal = () => new AbortController().signal;

async function fixture() {
  const g = await pumpHolderSettlementFixture(false, false, true, false),
    client = createClient({ url: 'file::memory:' });
  clients.push(client);
  for (const sql of [
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,role TEXT,revision INTEGER,archived INTEGER,folder_id TEXT,folder_ids TEXT)',
    'CREATE TABLE wallet_folders(owner_id TEXT,id TEXT,chain TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
  ])
    await client.execute(sql);
  for (const file of ['0079_real_justice', '0081_pump_holder_reservations'])
    for (const sql of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await client.execute(sql);
  const document = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: g.input.create.name,
      ticker: g.input.create.symbol,
      developerBuy: 0.1,
      holdersBuy: 0.3,
      holderCount: 3,
      holdersDistribution: {
        kind: 'custom',
        weights: ['2', '1', '0'],
        deviationPercent: 0,
        seed: 'a'.repeat(32),
      },
    },
    identity: EMPTY_IDENTITY,
    options: {
      ...DEFAULT_VENUE_OPTIONS,
      wallets: {
        chain: 'Solana',
        deployer: {
          address: g.input.create.payer,
          revision: 1,
          folderRevision: 0,
          root: true,
        },
        recipients: g.input.holders.map((h) => ({
          address: h.address,
          revision: 1,
          folderRevision: 0,
          root: true,
        })),
      },
    },
  });
  const terms = {
    projectId: 'holders',
    updatedAt: '2026-10-14T00:00:00Z',
    origin: 'https://bundle.example',
    releaseId: 'a'.repeat(64),
    payer: g.input.create.payer,
    payerRevision: 1,
    mint: g.input.create.mint,
    feeAndRentLimitRaw: '10000000',
    developerMaximumQuoteCostRaw: '100000000',
    holderLimits: g.input.holders.map((h) => ({
      address: h.address,
      feeAndRentLimitRaw: h.kind === 'none' ? '0' : '10000000',
      ...(h.kind === 'exact-base-output'
        ? { maximumQuoteCostRaw: h.maximumQuoteCostRaw }
        : {}),
    })),
  };
  await client.execute({
    sql: 'INSERT INTO workspace_projects VALUES(?,?,?,?,0)',
    args: ['alice', terms.projectId, JSON.stringify(document), terms.updatedAt],
  });
  for (const [key, role] of [
    [terms.payer, 'Deployer'],
    ...g.input.holders.map((h) => [h.address, 'Recipient']),
  ]) {
    await client.execute({
      sql: "INSERT INTO workspace_wallets VALUES('alice','Solana',?,?,1,0,'',NULL)",
      args: [key, role],
    });
    await client.execute({
      sql: "INSERT INTO wallet_ownership_proofs VALUES('alice','Solana',?)",
      args: [key],
    });
  }
  const digest = (v: unknown) =>
    createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const accounting = {
    ...(await g.run()),
    rpcCollectionRequired: false as const,
  };
  const checked = {
    packet: g.packet,
    allowances: g.limits,
    creationSimulation: g.creation.simulation,
    deployerBindingSha256: 'b'.repeat(64),
    holderBindingSha256: 'c'.repeat(64),
    allowanceSha256: digest(g.limits),
    fundingValidated: true,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
    allWalletSimulation: {
      expiresAt: g.creation.simulation.expiresAt,
      status: 'Simulated',
      packetSha256: g.packet.packetSha256,
      accounting,
      networkFeeRaw: '20000',
      programDeploymentHashes: g.creation.simulation.programDeploymentHashes,
      accountHashes: g.evidence.addresses.map((address, i) => ({
        address,
        beforeSha256: digest(g.evidence.before[i]),
        simulatedSha256: digest(g.evidence.after[i]),
      })),
    },
  } as unknown as Awaited<
    ReturnType<typeof preflightOwnedPumpHolderSimulation>
  >;
  let hook = async () => {};
  mocked.mockImplementation(async (_db, _owner, _terms, _signal, options) => {
    options?.captureInput?.(structuredClone(g.input));
    await hook();
    return JSON.parse(JSON.stringify(checked)) as typeof checked;
  });
  const db = createTursoDatabase(client),
    prepare = () => preparePumpHolderReview(db, 'alice', terms, signal(), rpc);
  return {
    g,
    client,
    db,
    document,
    terms,
    checked,
    prepare,
    setHook: (value: () => Promise<void>) => {
      hook = value;
    },
  };
}

it('persists a complete immutable review and resumes identical nested terms without rerunning RPC', async () => {
  const f = await fixture(),
    result = await f.prepare();
  expect(result).toMatchObject({
    state: 'review',
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  const parsed = await requirePumpHolderReview(result.review);
  expect(parsed.built.requiredSigners).toHaveLength(4);
  expect(parsed.review.input.holders).toHaveLength(3);
  expect(await f.prepare()).toEqual(result);
  expect(mocked).toHaveBeenCalledTimes(1);
  expect(await listPumpHolderReviews(f.db, 'alice', 'holders')).toHaveLength(1);
  expect(await listPumpHolderReviews(f.db, 'bob', 'holders')).toEqual([]);
  expect(await listPumpLaunches(f.db, 'alice', 'holders')).toEqual([]);
  await expect(
    preparePumpHolderReview(
      f.db,
      'alice',
      {
        ...f.terms,
        holderLimits: f.terms.holderLimits.map((l, i) =>
          i === 0 ? { ...l, feeAndRentLimitRaw: '10000001' } : l,
        ),
      },
      signal(),
      rpc,
    ),
  ).rejects.toThrow('Another launch review');
  expect(mocked).toHaveBeenCalledTimes(1);
});
it('refreshes the original lifetime and rejects semantic settlement changes without overwriting history', async () => {
  const f = await fixture(),
    result = await f.prepare();
  await refreshPumpHolderReview(f.db, 'alice', result.review.id, signal(), rpc);
  expect(mocked.mock.calls[1][4]?.lifetime).toEqual({
    blockhash: result.review.input.create.blockhash,
    lastValidBlockHeight: result.review.input.create.lastValidBlockHeight,
  });
  const volume = f.g.packet.buyerAccounts[0].volumeAccount;
  f.checked.allWalletSimulation.accountHashes.find(
    (a) => a.address === volume,
  )!.simulatedSha256 = 'd'.repeat(64);
  await refreshPumpHolderReview(f.db, 'alice', result.review.id, signal(), rpc);
  f.checked.allWalletSimulation.accounting.totalQuoteDebitRaw = '1';
  await expect(
    refreshPumpHolderReview(f.db, 'alice', result.review.id, signal(), rpc),
  ).rejects.toThrow('settlement or observed source changed');
  expect((await listPumpHolderReviews(f.db, 'alice', 'holders'))[0]).toEqual(
    result,
  );
});
it('reconstructs exact saved quote budgets and rejects a one-atom allocation change', async () => {
  const f = await fixture(),
    { review } = await f.prepare(),
    quote = structuredClone(review);
  quote.document.plan.mode = 'Quick';
  quote.document.plan.holdersBuyQuote = '0.003';
  quote.input.holders = quote.input.holders.map(
    (h, i): PumpHolderBuy =>
      h.kind === 'none'
        ? h
        : {
            address: h.address,
            kind: 'exact-quote-input',
            quoteAmountRaw: i === 0 ? '2000000' : '1000000',
            minimumTokenOutputRaw: '1000000',
          },
  );
  quote.allowances.holders = quote.allowances.holders.map((l) => ({
    ...l,
    maximumQuoteCostRaw: null,
    minimumTokenOutputRaw: l.feeAndRentLimitRaw === '0' ? null : '1000000',
  }));
  const built = await buildPumpCreateHolderMessage({
    ...f.g.input,
    holders: quote.input.holders,
  });
  quote.transaction = built.transaction;
  quote.sha256 = built.packetSha256;
  quote.allowanceSha256 = createHash('sha256')
    .update(JSON.stringify(quote.allowances))
    .digest('hex');
  const { contextSha256: _previous, ...context } = quote;
  quote.contextSha256 = await pumpHolderDigest(context);
  expect((await requirePumpHolderReview(quote)).built.holderSlots).toEqual(
    quote.input.holders,
  );
  quote.document.plan.holdersBuyQuote = '0.003000001';
  const { contextSha256: _old, ...changed } = quote;
  quote.contextSha256 = await pumpHolderDigest(changed);
  await expect(requirePumpHolderReview(quote)).rejects.toThrow(
    'denomination or limit',
  );
});
it('binds the full context and rejects changed project allocation even with a recomputed context hash', async () => {
  const f = await fixture(),
    { review } = await f.prepare();
  const changed = structuredClone(review);
  changed.allowances.holders[0].feeAndRentLimitRaw = '1';
  await expect(requirePumpHolderReview(changed)).rejects.toThrow(
    'context hash',
  );
  const allocation = structuredClone(review);
  allocation.document.plan.holdersBuy = 0.4;
  const { contextSha256: _old, ...context } = allocation;
  allocation.contextSha256 = await pumpHolderDigest(context);
  await expect(requirePumpHolderReview(allocation)).rejects.toThrow();
  expect(canonicalPumpHolderJson({ b: { z: 1, a: 2 }, a: 3 })).toBe(
    canonicalPumpHolderJson({ a: 3, b: { a: 2, z: 1 } }),
  );
});
it('makes holder reservations symmetric with swaps/withdrawals and releases only cancelled unsigned reviews', async () => {
  const f = await fixture(),
    result = await f.prepare(),
    active = f.terms.holderLimits[0].address,
    inactive = f.terms.holderLimits[2].address;
  const reserve = (key: string) =>
    f.client.execute({
      sql: "INSERT INTO solana_execution_reservations VALUES('alice',?,'withdrawal','other','awaiting_signature')",
      args: [key],
    });
  await expect(reserve(active)).rejects.toThrow('reserved for holder launch');
  await reserve(inactive);
  expect(
    (
      await cancelUnsignedPumpHolderReview(
        f.db,
        'alice',
        result.review.id,
        signal(),
      )
    ).state,
  ).toBe('cancelled');
  await reserve(active);
  expect((await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state).toBe(
    'cancelled',
  );
  await expect(
    f.client.execute('DELETE FROM pump_launch_reviews'),
  ).rejects.toThrow('history retained');
  await expect(f.prepare()).rejects.toThrow('reservation changed');
});
it('rejects an existing shared reservation and rolls back the entire holder review insert', async () => {
  const f = await fixture();
  await f.client.execute({
    sql: "INSERT INTO solana_execution_reservations VALUES('alice',?,'warmup','other','signed')",
    args: [f.terms.holderLimits[1].address],
  });
  await expect(f.prepare()).rejects.toThrow('reservation changed');
  expect(await listPumpHolderReviews(f.db, 'alice', 'holders')).toEqual([]);
});
it('rejects a proof revoked after preflight at the database insert boundary', async () => {
  const f = await fixture();
  f.setHook(async () => {
    await f.client.execute({
      sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
      args: [f.terms.holderLimits[1].address],
    });
  });
  await expect(f.prepare()).rejects.toThrow(
    'ownership, project or wallet reservation changed',
  );
  expect(await listPumpHolderReviews(f.db, 'alice', 'holders')).toEqual([]);
});
it('guards holder role/revision/proof changes at approval and preserves immutable review bytes', async () => {
  const f = await fixture(),
    result = await f.prepare();
  await f.client.execute({
    sql: "UPDATE workspace_wallets SET role='Funder' WHERE address=?",
    args: [f.terms.holderLimits[0].address],
  });
  await expect(
    f.client.execute("UPDATE pump_launch_reviews SET state='approved'"),
  ).rejects.toThrow('Holder wallet proof');
  await expect(
    f.client.execute("UPDATE pump_launch_reviews SET review='{}'"),
  ).rejects.toThrow('Immutable launch review');
  await expect(
    cancelUnsignedPumpHolderReview(f.db, 'bob', result.review.id, signal()),
  ).rejects.toMatchObject({ status: 404 });
});
it('checks selected holder folder membership and revision again at approval', async () => {
  const f = await fixture(),
    ref = f.document.options.wallets!.recipients[0];
  delete ref.root;
  ref.folderId = 'folder';
  ref.folderRevision = 1;
  await f.client.execute(
    "INSERT INTO wallet_folders VALUES('alice','folder','Solana',1,0)",
  );
  await f.client.execute({
    sql: `UPDATE workspace_wallets SET folder_id='folder',folder_ids='["folder"]' WHERE address=?`,
    args: [ref.address],
  });
  await f.client.execute({
    sql: 'UPDATE workspace_projects SET document=?',
    args: [JSON.stringify(f.document)],
  });
  await f.prepare();
  await f.client.execute('UPDATE wallet_folders SET revision=2');
  await expect(
    f.client.execute("UPDATE pump_launch_reviews SET state='approved'"),
  ).rejects.toThrow('Holder wallet proof');
});
it('fails closed before preflight when the holder reservation migration is missing', async () => {
  const f = await fixture();
  await f.client.execute('DROP TRIGGER pump_holder_shared_reservation');
  await expect(f.prepare()).rejects.toMatchObject({ status: 503 });
  expect(mocked).not.toHaveBeenCalled();
});
it('does not release an approved review merely because browser signatures are not registered yet', async () => {
  const f = await fixture(),
    result = await f.prepare();
  await f.client.execute("UPDATE pump_launch_reviews SET state='approved'");
  await expect(
    cancelUnsignedPumpHolderReview(f.db, 'alice', result.review.id, signal()),
  ).rejects.toThrow('lifetime/receipt recovery');
  await expect(
    f.client.execute({
      sql: "INSERT INTO solana_execution_reservations VALUES('alice',?,'warmup','other','signed')",
      args: [f.terms.holderLimits[0].address],
    }),
  ).rejects.toThrow('reserved');
});
it('prevents a legacy launch payer from reusing an active holder wallet', async () => {
  const f = await fixture(),
    first = await f.prepare(),
    payer = f.terms.holderLimits[0].address;
  const document = structuredClone(f.document);
  document.options.wallets!.deployer!.address = payer;
  await f.client.execute({
    sql: 'INSERT INTO workspace_projects VALUES(?,?,?,?,0)',
    args: ['alice', 'other', JSON.stringify(document), f.terms.updatedAt],
  });
  const insert = () =>
    f.client.execute({
      sql: `INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at)
    VALUES('legacy','alice','other',?,?,?,?, '{}','{}','review',?,?)`,
      args: [
        payer,
        f.g.input.holders[2].address,
        JSON.stringify(document),
        JSON.stringify({ updatedAt: f.terms.updatedAt, payerRevision: 1 }),
        new Date().toISOString(),
        new Date(Date.now() + 60000).toISOString(),
      ],
    });
  await expect(insert()).rejects.toThrow('already reserved');
  await cancelUnsignedPumpHolderReview(
    f.db,
    'alice',
    first.review.id,
    signal(),
  );
  await insert();
});
it('lets only one simultaneous preparation reserve a project and its wallets', async () => {
  const f = await fixture(),
    waiters: (() => void)[] = [];
  f.setHook(
    () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (waiters.length === 2) for (const done of waiters) done();
      }),
  );
  const results = await Promise.allSettled([f.prepare(), f.prepare()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await listPumpHolderReviews(f.db, 'alice', 'holders')).toHaveLength(1);
});
it('rejects a holder packet when one recipient is already a legacy launch payer', async () => {
  const f = await fixture(),
    payer = f.terms.holderLimits[0].address,
    document = structuredClone(f.document);
  document.options.wallets!.deployer!.address = payer;
  await f.client.execute({
    sql: 'INSERT INTO workspace_projects VALUES(?,?,?,?,0)',
    args: ['alice', 'legacy', JSON.stringify(document), f.terms.updatedAt],
  });
  await f.client.execute({
    sql: `INSERT INTO pump_launch_reviews(id,owner_id,project_id,payer,mint,project_document,terms,review,simulation,state,created_at,expires_at)
    VALUES('legacy','alice','legacy',?,?,?,?,'{}','{}','review',?,?)`,
    args: [
      payer,
      f.g.input.holders[2].address,
      JSON.stringify(document),
      JSON.stringify({ updatedAt: f.terms.updatedAt, payerRevision: 1 }),
      new Date().toISOString(),
      new Date(Date.now() + 60000).toISOString(),
    ],
  });
  await expect(f.prepare()).rejects.toThrow('reservation changed');
  expect(await listPumpHolderReviews(f.db, 'alice', 'holders')).toEqual([]);
});
it('refreshes explicit approval and registers all strict signatures without any provider call or broadcast', async () => {
  const f = await fixture(),
    prepared = await f.prepare(),
    consent = consentFor(prepared.review);
  expect(
    await approvePumpHolderReview(
      f.db,
      'alice',
      prepared.review.id,
      consent,
      signal(),
      rpc,
    ),
  ).toMatchObject({
    state: 'approved',
    signingAllowed: true,
    executionAllowed: false,
  });
  await approvePumpHolderReview(
    f.db,
    'alice',
    prepared.review.id,
    consent,
    signal(),
    rpc,
  );
  expect(mocked).toHaveBeenCalledTimes(3);
  const signed = await syntheticSigned(f, prepared.review),
    registered = await registerPumpHolderSignedPacket(
      f.db,
      'alice',
      prepared.review.id,
      consent,
      signed,
      signal(),
    );
  expect(registered).toMatchObject({
    state: 'signed',
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  expect(registered.signature).toBeTruthy();
  expect(mocked).toHaveBeenCalledTimes(3);
  expect(
    await registerPumpHolderSignedPacket(
      f.db,
      'alice',
      prepared.review.id,
      consent,
      signed,
      signal(),
    ),
  ).toEqual(registered);
  await expect(
    cancelUnsignedPumpHolderReview(f.db, 'alice', prepared.review.id, signal()),
  ).rejects.toThrow('lifetime/receipt recovery');
});
it('rejects wrong approval consent and foreign ownership before running a refresh', async () => {
  const f = await fixture(),
    prepared = await f.prepare(),
    consent = consentFor(prepared.review);
  for (const patch of [
    { approved: false },
    { sha256: '0'.repeat(64) },
    { contextSha256: '0'.repeat(64) },
    { reviewId: 'other' },
    { approvedScope: 'create-and-developer-buy' },
    { acknowledgeSimulationLimits: false },
  ])
    await expect(
      approvePumpHolderReview(
        f.db,
        'alice',
        prepared.review.id,
        { ...consent, ...patch } as PumpHolderConsent,
        signal(),
        rpc,
      ),
    ).rejects.toMatchObject({ status: 400 });
  await expect(
    approvePumpHolderReview(
      f.db,
      'bob',
      prepared.review.id,
      consent,
      signal(),
      rpc,
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(mocked).toHaveBeenCalledTimes(1);
  expect((await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state).toBe(
    'review',
  );
});
it('rejects unsigned or unapproved registration and preserves the approved review on invalid signatures', async () => {
  const f = await fixture(),
    prepared = await f.prepare(),
    consent = consentFor(prepared.review);
  await expect(
    registerPumpHolderSignedPacket(
      f.db,
      'alice',
      prepared.review.id,
      consent,
      prepared.review.transaction,
      signal(),
    ),
  ).rejects.toThrow('Approve');
  await approvePumpHolderReview(
    f.db,
    'alice',
    prepared.review.id,
    consent,
    signal(),
    rpc,
  );
  await expect(
    registerPumpHolderSignedPacket(
      f.db,
      'alice',
      prepared.review.id,
      consent,
      prepared.review.transaction,
      signal(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect((await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state).toBe(
    'approved',
  );
  expect(mocked).toHaveBeenCalledTimes(2);
});
it('keeps expired signed packets for recovery even if a holder proof was subsequently revoked', async () => {
  const f = await fixture(),
    prepared = await f.prepare(),
    consent = consentFor(prepared.review);
  await approvePumpHolderReview(
    f.db,
    'alice',
    prepared.review.id,
    consent,
    signal(),
    rpc,
  );
  const signed = await syntheticSigned(f, prepared.review);
  await f.client.execute({
    sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
    args: [f.terms.holderLimits[0].address],
  });
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse(prepared.review.expiresAt) + 1,
  );
  expect(
    await registerPumpHolderSignedPacket(
      f.db,
      'alice',
      prepared.review.id,
      consent,
      signed,
      signal(),
    ),
  ).toMatchObject({ state: 'signed', signingAllowed: false });
  expect(mocked).toHaveBeenCalledTimes(2);
});
it('rejects revoked ownership at the final approval write and keeps the reservation', async () => {
  const f = await fixture(),
    prepared = await f.prepare(),
    consent = consentFor(prepared.review);
  f.setHook(async () => {
    await f.client.execute({
      sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
      args: [f.terms.holderLimits[1].address],
    });
  });
  await expect(
    approvePumpHolderReview(
      f.db,
      'alice',
      prepared.review.id,
      consent,
      signal(),
      rpc,
    ),
  ).rejects.toThrow('changed before approval');
  expect((await listPumpHolderReviews(f.db, 'alice', 'holders'))[0].state).toBe(
    'review',
  );
  await expect(
    f.client.execute({
      sql: "INSERT INTO solana_execution_reservations VALUES('alice',?,'warmup','other','signed')",
      args: [f.terms.holderLimits[1].address],
    }),
  ).rejects.toThrow('reserved');
});
