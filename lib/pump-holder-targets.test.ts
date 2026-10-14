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
        recipients: addresses
          .slice(1)
          .map((address) => ({
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
