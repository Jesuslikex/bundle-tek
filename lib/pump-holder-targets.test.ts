import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { releaseLaunchMetadata } from './launch-metadata-release';
import {
  prepareOwnedPumpHolderPacket,
  preflightOwnedPumpHolderFunding,
  preflightOwnedPumpHolderSimulation,
} from './pump-holder-preparation';
import { pumpHolderSettlementFixture } from '../test/pump-holder-settlement-fixture';
import { PUMP_TOKEN_2022 } from './pump-launch-config';
import { buildPumpCreateHolderMessage } from './pump-holder-message';
import {
  preparePumpHolderReview,
  refreshPumpHolderReview,
  cancelUnsignedPumpHolderReview,
  approvePumpHolderReview,
  registerPumpHolderSignedPacket,
} from './pump-holder-review-service';
import type { PumpHolderConsent } from './pump-holder-signing';
import {
  submitPumpHolderReview,
  recoverPumpHolderReview,
} from './pump-holder-execution';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  address,
  type SignatureBytes,
} from '@solana/kit-v1';
import { raw, SYSTEM } from '../test/pump-launch-simulation-fixture';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { pumpInitialBuySimulationFixture } from '../test/pump-initial-buy-simulation-fixture';
import { afterEach, expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '../db/turso';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from './workspace-project';
import {
  buildPumpHolderTargets,
  type PumpHolderObservation,
} from './pump-holder-targets';
import { readOwnedPumpHolderSelection } from './pump-holder-selection';
const clients: Client[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
const observed: PumpHolderObservation = {
  tokenSupplyRaw: '1000000000000000',
  initialRealTokenReservesRaw: '793100000000000',
  quoteMint: 'So11111111111111111111111111111111111111112',
  quoteDecimals: 9,
};
async function fixture() {
  const addresses = await Promise.all(
    Array.from(
      { length: 4 },
      async () => (await generateKeyPairSigner()).address,
    ),
  );
  const document = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      holderCount: 3,
      holdersBuy: 20,
      holdersDistribution: {
        kind: 'custom',
        weights: ['1', '2', '3'],
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
          address: addresses[0],
          revision: 1,
          folderRevision: 0,
          root: true,
        },
        recipients: addresses.slice(1).map((address) => ({
          address,
          revision: 1,
          folderRevision: 0,
          root: true,
        })),
      },
    },
  });
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  for (const sql of [
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,role TEXT,revision INTEGER,archived INTEGER,folder_id TEXT,folder_ids TEXT)',
    'CREATE TABLE wallet_folders(owner_id TEXT,id TEXT,chain TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
  ])
    await client.execute(sql);
  const terms = {
    projectId: 'holders',
    updatedAt: '2026-10-14T00:00:00Z',
    observation: observed,
  };
  await client.execute({
    sql: 'INSERT INTO workspace_projects VALUES(?,?,?,?,0)',
    args: ['alice', terms.projectId, JSON.stringify(document), terms.updatedAt],
  });
  for (const address of addresses.slice(1)) {
    await client.execute({
      sql: "INSERT INTO workspace_wallets VALUES('alice','Solana',?,'Recipient',1,0,'',NULL)",
      args: [address],
    });
    await client.execute({
      sql: "INSERT INTO wallet_ownership_proofs VALUES('alice','Solana',?)",
      args: [address],
    });
  }
  return {
    document,
    addresses,
    client,
    db: createTursoDatabase(client),
    terms,
  };
}
it('apportions actual token base units exactly in saved wallet order, not rounded percentages', async () => {
  const f = await fixture(),
    result = buildPumpHolderTargets(f.document, observed);
  expect(result).toMatchObject({
    kind: 'exact-base-output',
    totalRaw: '200000000000000',
    holderCount: 3,
    executionAllowed: false,
    signingAllowed: false,
  });
  expect(result.items.map((i) => i.tokenAmountRaw)).toEqual([
    '33333333333333',
    '66666666666667',
    '100000000000000',
  ]);
  expect(result.items.map((i) => i.wallet.address)).toEqual(
    f.addresses.slice(1),
  );
  expect(
    result.items.every(
      (i) => i.maximumQuoteCostRaw === null && i.feeAndRentLimitRaw === null,
    ),
  ).toBe(true);
});
it('retains zero holder slots rather than inventing buys or dropping addresses', async () => {
  const f = await fixture();
  f.document.plan.holdersDistribution = {
    kind: 'single',
    seed: 'a'.repeat(32),
    deviationPercent: 0,
  };
  const result = buildPumpHolderTargets(f.document, observed);
  expect(result.items).toHaveLength(3);
  expect(result.items.filter((i) => i.participates)).toHaveLength(1);
  expect(result.items.reduce((s, i) => s + BigInt(i.tokenAmountRaw!), 0n)).toBe(
    BigInt(result.totalRaw),
  );
});
it('keeps quote budgets distinct from supply targets, including stock precision', async () => {
  const f = await fixture();
  f.document.plan.mode = 'Quick';
  f.document.plan.currency = 'TSLAX';
  f.document.plan.quoteAddress = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
  f.document.plan.holdersBuyQuote = '1.00000001';
  const result = buildPumpHolderTargets(f.document, {
    ...observed,
    quoteMint: f.document.plan.quoteAddress,
    quoteDecimals: 8,
  });
  expect(result).toMatchObject({
    kind: 'exact-quote-input',
    totalRaw: '100000001',
  });
  expect(
    result.items.every(
      (i) => i.tokenAmountRaw === null && i.minimumTokenOutputRaw === null,
    ),
  ).toBe(true);
  expect(result.items.reduce((s, i) => s + BigInt(i.quoteAmountRaw!), 0n)).toBe(
    100000001n,
  );
  delete f.document.plan.holdersBuyQuote;
  expect(() =>
    buildPumpHolderTargets(f.document, {
      ...observed,
      quoteMint: f.document.plan.quoteAddress!,
      quoteDecimals: 8,
    }),
  ).toThrow('quote budget');
});
it('rejects missing distribution/wallets, changed precision, scheduling and curve exhaustion', async () => {
  const f = await fixture();
  expect(() =>
    buildPumpHolderTargets(f.document, { ...observed, quoteDecimals: 8 }),
  ).toThrow('precision');
  expect(() =>
    buildPumpHolderTargets(f.document, {
      ...observed,
      initialRealTokenReservesRaw: '250000000000000',
    }),
  ).toThrow('leave tokens');
  const noDistribution = structuredClone(f.document);
  delete noDistribution.plan.holdersDistribution;
  expect(() => buildPumpHolderTargets(noDistribution, observed)).toThrow(
    'explicit distribution',
  );
  const missing = structuredClone(f.document);
  missing.options.wallets!.recipients.pop();
  expect(() => buildPumpHolderTargets(missing, observed)).toThrow(
    'every planned slot',
  );
  const scheduled = structuredClone(f.document);
  scheduled.plan.scheduled = true;
  expect(() => buildPumpHolderTargets(scheduled, observed)).toThrow(
    'unscheduled',
  );
});
it('loads owner-scoped immutable selection bindings with real libSQL and requires every payer proof', async () => {
  const f = await fixture();
  const result = await readOwnedPumpHolderSelection(f.db, 'alice', f.terms);
  expect(result.bindingSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await readOwnedPumpHolderSelection(f.db, 'alice', f.terms)).toEqual(
    result,
  );
  await expect(
    readOwnedPumpHolderSelection(f.db, 'bob', f.terms),
  ).rejects.toThrow('owned holder');
  await f.client.execute({
    sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
    args: [f.addresses[2]],
  });
  await expect(
    readOwnedPumpHolderSelection(f.db, 'alice', f.terms),
  ).rejects.toThrow('Every saved holder');
});
it('rejects stale wallet revisions, wrong roles and moved/archived selected folders', async () => {
  const f = await fixture();
  await f.client.execute('UPDATE workspace_wallets SET revision=2');
  await expect(
    readOwnedPumpHolderSelection(f.db, 'alice', f.terms),
  ).rejects.toThrow('revision');
  await f.client.execute(
    "UPDATE workspace_wallets SET revision=1,role='Funder'",
  );
  await expect(
    readOwnedPumpHolderSelection(f.db, 'alice', f.terms),
  ).rejects.toThrow('revision');
  await f.client.execute(
    "UPDATE workspace_wallets SET role='Recipient',folder_id='folder',folder_ids='[\"folder\"]'",
  );
  for (const ref of f.document.options.wallets!.recipients) {
    delete ref.root;
    ref.folderId = 'folder';
    ref.folderRevision = 1;
  }
  await f.client.execute({
    sql: 'UPDATE workspace_projects SET document=?',
    args: [JSON.stringify(f.document)],
  });
  await f.client.execute(
    "INSERT INTO wallet_folders VALUES('alice','folder','Solana',1,0)",
  );
  expect(
    (await readOwnedPumpHolderSelection(f.db, 'alice', f.terms)).targets.items,
  ).toHaveLength(3);
  await f.client.execute('UPDATE wallet_folders SET archived=1');
  await expect(
    readOwnedPumpHolderSelection(f.db, 'alice', f.terms),
  ).rejects.toThrow('folder changed');
});

async function preparationFixture(
  stock = false,
  quoteMode = false,
  token22 = false,
) {
  const f = await fixture(),
    rpc = await pumpInitialBuySimulationFixture(stock, token22);
  const image = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const imageId = createHash('sha256').update(image).digest('hex');
  f.document.plan.tokenName = rpc.intent.name;
  f.document.plan.ticker = rpc.intent.symbol;
  f.document.plan.quoteAddress = rpc.intent.quoteMint;
  f.document.plan.currency = stock ? 'TSLAX' : 'SOL';
  if (quoteMode) {
    f.document.plan.mode = 'Quick';
    f.document.plan.holdersBuyQuote = '1';
  }
  f.document.options.wallets!.deployer = {
    address: rpc.intent.payer,
    revision: 1,
    folderRevision: 0,
    root: true,
  };
  f.document.identity.artworkUrl = '/api/artwork/' + imageId;
  await f.client.execute({
    sql: 'UPDATE workspace_projects SET document=?',
    args: [JSON.stringify(f.document)],
  });
  await f.client.execute(
    'CREATE TABLE project_artwork(owner_id TEXT,id TEXT,data BLOB,mime TEXT,archived INTEGER DEFAULT 0)',
  );
  for (const sql of readFileSync('drizzle/0078_lush_rictor.sql', 'utf8').split(
    '--> statement-breakpoint',
  ))
    if (sql.trim()) await f.client.execute(sql);
  await f.client.execute({
    sql: 'INSERT INTO project_artwork VALUES(?,?,?,?,0)',
    args: ['alice', imageId, image, 'image/png'],
  });
  await f.client.execute({
    sql: "INSERT INTO workspace_wallets VALUES('alice','Solana',?,'Deployer',1,0,'',NULL)",
    args: [rpc.intent.payer],
  });
  await f.client.execute({
    sql: "INSERT INTO wallet_ownership_proofs VALUES('alice','Solana',?)",
    args: [rpc.intent.payer],
  });
  const released = await releaseLaunchMetadata(
    f.db,
    'alice',
    f.terms.projectId,
    f.terms.updatedAt,
    'https://bundle.test',
  );
  rpc.intent.uri = released.uri;
  rpc.setMetadataUri(released.uri);
  const terms = {
    projectId: f.terms.projectId,
    updatedAt: f.terms.updatedAt,
    origin: 'https://bundle.test',
    releaseId: released.id,
    payer: rpc.intent.payer,
    payerRevision: 1,
    mint: rpc.intent.mint,
    feeAndRentLimitRaw: '10000000',
    developerMaximumQuoteCostRaw: '1000000000',
    holderLimits: f.document.options.wallets!.recipients.map((r) => ({
      address: r.address,
      feeAndRentLimitRaw: '10000000',
      ...(quoteMode
        ? { minimumTokenOutputRaw: '1000000' }
        : { maximumQuoteCostRaw: '1000000000' }),
    })),
  };
  return { ...f, rpc, terms };
}
for (const revoke of [false, true])
  it(`runs the complete owned unsigned holder preflight and rechecks proof after simulation (revoke=${revoke})`, async () => {
    const f = await preparationFixture(),
      g = await pumpHolderSettlementFixture(false, false, true, false);
    const recipients = g.input.holders.map((h) => ({
      address: h.address,
      revision: 1,
      folderRevision: 0,
      root: true as const,
    }));
    f.document.options.wallets!.deployer = {
      address: g.input.create.payer,
      revision: 1,
      folderRevision: 0,
      root: true,
    };
    f.document.options.wallets!.recipients = recipients;
    f.document.plan.developerBuy = 0.1;
    f.document.plan.holdersBuy = 0.3;
    f.document.plan.holdersDistribution = {
      kind: 'custom',
      weights: ['2', '1', '0'],
      deviationPercent: 0,
      seed: 'a'.repeat(32),
    };
    f.document.plan.tokenName = g.input.create.name;
    f.document.plan.ticker = g.input.create.symbol;
    const updatedAt = '2026-10-14T01:00:00Z';
    await f.client.execute({
      sql: 'UPDATE workspace_projects SET document=?,updated_at=?',
      args: [JSON.stringify(f.document), updatedAt],
    });
    for (const [address, role] of [
      [g.input.create.payer, 'Deployer'],
      ...recipients.map((r) => [r.address, 'Recipient']),
    ]) {
      await f.client.execute({
        sql: "INSERT INTO workspace_wallets VALUES('alice','Solana',?,?,1,0,'',NULL)",
        args: [address, role],
      });
      await f.client.execute({
        sql: "INSERT INTO wallet_ownership_proofs VALUES('alice','Solana',?)",
        args: [address],
      });
    }
    const release = await releaseLaunchMetadata(
      f.db,
      'alice',
      f.terms.projectId,
      updatedAt,
      'https://bundle.test',
    );
    g.f.setMetadataUri(release.uri);
    g.input.create.uri = release.uri;
    g.evidence.after[g.evidence.addresses.indexOf(g.input.create.mint)] = raw(
      PUMP_TOKEN_2022,
      g.f.metadataMint(),
    );
    const terms = {
      ...f.terms,
      updatedAt,
      releaseId: release.id,
      payer: g.input.create.payer,
      mint: g.input.create.mint,
      developerMaximumQuoteCostRaw: '100000000',
      holderLimits: g.input.holders.map((h) => ({
        address: h.address,
        feeAndRentLimitRaw: h.kind === 'none' ? '0' : '10000000',
        ...(h.kind === 'exact-base-output'
          ? { maximumQuoteCostRaw: h.maximumQuoteCostRaw }
          : {}),
      })),
    };
    let holderMode = false,
      simulations = 0;
    let sentPacket: string | null = null,
      sends = 0;
    const rpc: PumpLaunchRpc = async (method, params, signal) => {
      if (method === 'sendTransaction') {
        sends++;
        sentPacket = params[0] as string;
        return (
          await f.db
            .prepare('SELECT signature FROM pump_launch_reviews WHERE signed=?')
            .bind(sentPacket)
            .first<{ signature: string }>()
        )?.signature;
      }
      if (method === 'getTransaction')
        return sentPacket
          ? {
              slot: '2000',
              transaction: [sentPacket, 'base64'],
              meta: { err: null, fee: '20000' },
            }
          : null;
      if (method === 'getLatestBlockhash')
        return {
          context: { slot: '100' },
          value: {
            blockhash: '11111111111111111111111111111111',
            lastValidBlockHeight: '2000',
          },
        };
      if (
        method === 'getFeeForMessage' &&
        getCompiledTransactionMessageDecoder().decode(
          Buffer.from(params[0] as string, 'base64'),
        ).version === 1
      ) {
        holderMode = true;
        return { context: { slot: '100' }, value: '20000' };
      }
      if (holderMode && method === 'getMultipleAccounts')
        return {
          context: { slot: '100' },
          value: (params[0] as string[]).map((k) =>
            structuredClone(
              g.evidence.before[g.evidence.addresses.indexOf(k)] ?? null,
            ),
          ),
        };
      if (
        method === 'simulateTransaction' &&
        getCompiledTransactionMessageDecoder().decode(
          getTransactionDecoder().decode(
            Buffer.from(params[0] as string, 'base64'),
          ).messageBytes,
        ).version === 1
      ) {
        simulations++;
        if (revoke)
          await f.client.execute({
            sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
            args: [recipients[1].address],
          });
        return {
          context: { slot: '100' },
          value: {
            err: null,
            accounts: structuredClone(g.evidence.after),
            fee: '20000',
            unitsConsumed: '600000',
            loadedAccountsDataSize: '1048576',
            replacementBlockhash: null,
          },
        };
      }
      return g.f.rpc(method, params, signal);
    };
    const result = preflightOwnedPumpHolderSimulation(
      f.db,
      'alice',
      terms,
      new AbortController().signal,
      {
        rpc,
        lifetime: {
          blockhash: g.input.create.blockhash,
          lastValidBlockHeight: g.input.create.lastValidBlockHeight.toString(),
        },
      },
    );
    if (revoke) await expect(result).rejects.toThrow('Every saved holder');
    else {
      const checked = await result;
      expect(checked.packet.packetSha256).toBe(
        (await buildPumpCreateHolderMessage(g.input)).packetSha256,
      );
      expect(checked).toMatchObject({
        fundingValidated: true,
        signingAllowed: false,
        executionAllowed: false,
        completeLaunch: false,
        allWalletSimulation: {
          status: 'Simulated',
          settlementValidated: true,
          accounting: { accountingValidated: true, wallets: expect.any(Array) },
        },
      });
      await f.client.execute(
        'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
      );
      for (const file of ['0079_real_justice', '0081_pump_holder_reservations'])
        for (const sql of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
          '--> statement-breakpoint',
        ))
          if (sql.trim()) await f.client.execute(sql);
      holderMode = false;
      const stored = await preparePumpHolderReview(
        f.db,
        'alice',
        terms,
        new AbortController().signal,
        rpc,
      );
      expect(stored).toMatchObject({
        state: 'review',
        signingAllowed: false,
        executionAllowed: false,
      });
      expect(stored.review.input.create.blockhash).toBe(
        '11111111111111111111111111111111',
      );
      holderMode = false;
      const refreshed = await refreshPumpHolderReview(
        f.db,
        'alice',
        stored.review.id,
        new AbortController().signal,
        rpc,
      );
      expect(refreshed.packet.packetSha256).toBe(stored.review.sha256);
      expect(
        (
          await cancelUnsignedPumpHolderReview(
            f.db,
            'alice',
            stored.review.id,
            new AbortController().signal,
          )
        ).state,
      ).toBe('cancelled');
      holderMode = false;
      const next = await preparePumpHolderReview(
        f.db,
        'alice',
        terms,
        new AbortController().signal,
        rpc,
      );
      const consent: PumpHolderConsent = {
        approved: true,
        reviewId: next.review.id,
        sha256: next.review.sha256,
        contextSha256: next.review.contextSha256,
        approvedScope: 'create-developer-and-holder-buys',
        acknowledgeSimulationLimits: true,
      };
      holderMode = false;
      expect(
        await approvePumpHolderReview(
          f.db,
          'alice',
          next.review.id,
          consent,
          new AbortController().signal,
          rpc,
        ),
      ).toMatchObject({
        state: 'approved',
        signingAllowed: true,
        executionAllowed: false,
      });
      const tx = getTransactionDecoder().decode(
          Buffer.from(next.review.transaction, 'base64'),
        ),
        signatures = { ...tx.signatures };
      for (const signer of [
        g.f.f.payerSigner,
        g.f.f.mintSigner,
        ...g.holderSigners,
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
      const signed = getBase64Decoder().decode(
        getTransactionEncoder().encode({ ...tx, signatures }),
      );
      expect(
        await registerPumpHolderSignedPacket(
          f.db,
          'alice',
          next.review.id,
          consent,
          signed,
          new AbortController().signal,
        ),
      ).toMatchObject({
        state: 'signed',
        signingAllowed: false,
        executionAllowed: false,
        completeLaunch: false,
      });
      holderMode = false;
      expect(
        await submitPumpHolderReview(
          f.db,
          'alice',
          next.review.id,
          { consent, submitApproved: true },
          new AbortController().signal,
          rpc,
        ),
      ).toMatchObject({ state: 'submitted', completeLaunch: false });
      expect(
        await recoverPumpHolderReview(
          f.db,
          'alice',
          next.review.id,
          new AbortController().signal,
          rpc,
        ),
      ).toMatchObject({
        state: 'finalized',
        completeLaunch: true,
        receipt: {
          containsHolderBuys: true,
          activeHolderCount: 2,
          succeeded: true,
        },
      });
    }
    expect(simulations).toBe(revoke ? 1 : 6);
    expect(sends).toBe(revoke ? 0 : 1);
  });
for (const revoke of [false, true])
  it(`checks owned all-wallet funding and revalidates ownership after RPC (revoke=${revoke})`, async () => {
    const f = await preparationFixture();
    f.terms.developerMaximumQuoteCostRaw = '100000000';
    for (const limit of f.terms.holderLimits)
      if ('maximumQuoteCostRaw' in limit)
        limit.maximumQuoteCostRaw = '100000000';
    for (const key of f.addresses)
      f.rpc.before.set(key, raw(SYSTEM, new Uint8Array(), '1000000000'));
    let funding = false,
      snapshots = 0;
    const rpc: PumpLaunchRpc = async (method, params, signal) => {
      if (method === 'getFeeForMessage') {
        const message = getCompiledTransactionMessageDecoder().decode(
          Buffer.from(params[0] as string, 'base64'),
        );
        if (message.version === 1) {
          funding = true;
          return { context: { slot: '100' }, value: '25000' };
        }
      }
      if (funding && method === 'getMultipleAccounts') {
        if (++snapshots === 2 && revoke)
          await f.client.execute({
            sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
            args: [f.addresses[2]],
          });
        return {
          context: { slot: '100' },
          value: (params[0] as string[]).map((key) =>
            structuredClone(f.rpc.before.get(key) ?? null),
          ),
        };
      }
      return f.rpc.rpc(method, params, signal);
    };
    const result = preflightOwnedPumpHolderFunding(
      f.db,
      'alice',
      f.terms,
      new AbortController().signal,
      { rpc },
    );
    if (revoke) await expect(result).rejects.toThrow('Every saved holder');
    else {
      const checked = await result;
      expect(checked).toMatchObject({
        fundingValidated: true,
        allWalletSimulation: null,
        signingAllowed: false,
        funding: {
          fundingValidated: true,
          settlementValidated: false,
          networkFeeRaw: '25000',
        },
      });
      expect(checked.funding.wallets).toHaveLength(4);
      expect(checked.funding.packetSha256).toBe(checked.packet.packetSha256);
      expect(checked.funding.allowanceSha256).toBe(checked.allowanceSha256);
      const packet = getTransactionDecoder().decode(
        Buffer.from(checked.packet.transaction, 'base64'),
      );
      expect(Object.values(packet.signatures).every((s) => s === null)).toBe(
        true,
      );
    }
    expect(snapshots).toBe(2);
  });
for (const [stock, quoteMode, token22] of [
  [false, false, false],
  [true, false, false],
  [true, true, false],
  [true, true, true],
])
  it(`binds the owned release, independently observed supply and all wallet limits into a disabled packet (${stock ? 'stock' : 'SOL'}, quote=${quoteMode}, token22=${token22})`, async () => {
    const f = await preparationFixture(stock, quoteMode, token22);
    const result = await prepareOwnedPumpHolderPacket(
      f.db,
      'alice',
      f.terms,
      new AbortController().signal,
      { rpc: f.rpc.rpc },
    );
    expect(result).toMatchObject({
      format: 'pump-owned-holder-packet-v1',
      fundingValidated: false,
      allWalletSimulation: null,
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
      metadataUri: f.rpc.intent.uri,
      packet: {
        activeHolderCount: 3,
        containsHolderBuys: true,
        requiredSigners: expect.arrayContaining([f.terms.payer, f.terms.mint]),
      },
    });
    expect(result.allowances.holders.map((h) => h.address)).toEqual(
      f.document.options.wallets!.recipients.map((r) => r.address),
    );
    expect(result.allowanceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      f.rpc.calls.filter((c) => c.method === 'simulateTransaction'),
    ).toHaveLength(1);
    expect(
      f.rpc.calls.some((c) =>
        ['sendTransaction', 'sendBundle'].includes(c.method),
      ),
    ).toBe(false);
  });
it('rejects moved limit slots and a watch-only holder before provider reads', async () => {
  const f = await preparationFixture();
  await expect(
    prepareOwnedPumpHolderPacket(
      f.db,
      'alice',
      { ...f.terms, holderLimits: [...f.terms.holderLimits].reverse() },
      new AbortController().signal,
      { rpc: f.rpc.rpc },
    ),
  ).rejects.toThrow('in order');
  expect(f.rpc.calls).toEqual([]);
  await f.client.execute({
    sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
    args: [f.addresses[2]],
  });
  await expect(
    prepareOwnedPumpHolderPacket(
      f.db,
      'alice',
      f.terms,
      new AbortController().signal,
      { rpc: f.rpc.rpc },
    ),
  ).rejects.toThrow('Every saved holder');
  expect(f.rpc.calls).toEqual([]);
});
it('rejects target overrides, wrong limit denominations and revocation during collection', async () => {
  const f = await preparationFixture();
  await expect(
    prepareOwnedPumpHolderPacket(
      f.db,
      'alice',
      { ...f.terms, tokenAmountRaw: '1' } as typeof f.terms,
      new AbortController().signal,
      { rpc: f.rpc.rpc },
    ),
  ).rejects.toThrow('targets cannot');
  const wrong = {
    ...f.terms,
    holderLimits: f.terms.holderLimits.map((l) => ({
      address: l.address,
      feeAndRentLimitRaw: l.feeAndRentLimitRaw,
      minimumTokenOutputRaw: '1',
    })),
  };
  await expect(
    prepareOwnedPumpHolderPacket(
      f.db,
      'alice',
      wrong,
      new AbortController().signal,
      { rpc: f.rpc.rpc },
    ),
  ).rejects.toThrow('own quote cap');
  const rpc: typeof f.rpc.rpc = async (method, params, signal) => {
    const result = await f.rpc.rpc(method, params, signal);
    if (method === 'simulateTransaction')
      await f.client.execute({
        sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
        args: [f.addresses[1]],
      });
    return result;
  };
  await expect(
    prepareOwnedPumpHolderPacket(
      f.db,
      'alice',
      f.terms,
      new AbortController().signal,
      { rpc },
    ),
  ).rejects.toThrow('Every saved holder');
});

it('retains inactive holder slots with zero allowances and no generated signer', async () => {
  const f = await preparationFixture();
  f.document.plan.holdersDistribution = {
    kind: 'single',
    seed: 'a'.repeat(32),
    deviationPercent: 0,
  };
  await f.client.execute({
    sql: 'UPDATE workspace_projects SET document=?',
    args: [JSON.stringify(f.document)],
  });
  const targets = buildPumpHolderTargets(f.document, observed);
  const terms = {
    ...f.terms,
    holderLimits: targets.items.map((i) =>
      i.participates
        ? {
            address: i.wallet.address,
            feeAndRentLimitRaw: '10000000',
            maximumQuoteCostRaw: '1000000000',
          }
        : { address: i.wallet.address, feeAndRentLimitRaw: '0' },
    ),
  };
  const result = await prepareOwnedPumpHolderPacket(
    f.db,
    'alice',
    terms,
    new AbortController().signal,
    { rpc: f.rpc.rpc },
  );
  expect(result.packet.activeHolderCount).toBe(1);
  expect(result.packet.holderSlots).toHaveLength(3);
  expect(result.packet.requiredSigners).toHaveLength(3);
  expect(
    result.allowances.holders.filter((h) => h.feeAndRentLimitRaw === '0'),
  ).toHaveLength(2);
});
