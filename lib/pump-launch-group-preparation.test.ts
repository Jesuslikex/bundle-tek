import { afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { address } from '@solana/kit';
import { createTursoDatabase } from '../db/turso';
import { pumpLaunchGroupSimulationFixture } from '../test/pump-launch-group-simulation-fixture';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from './workspace-project';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import { preflightOwnedPumpLaunchGroup } from './pump-launch-group-preparation';
import { prepareOwnedPumpHolderPacket } from './pump-holder-preparation';
import type { PumpLaunchRpc } from './pump-launch-simulation';
vi.mock('./owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('./owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
const clients: Client[] = [],
  mocked = vi.mocked(preflightOwnedPumpCreate);
afterEach(() => {
  mocked.mockReset();
  for (const client of clients.splice(0)) client.close();
});
async function fixture() {
  const f = await pumpLaunchGroupSimulationFixture(false, false, false, false),
    client = createClient({ url: 'file::memory:' });
  clients.push(client);
  for (const sql of [
    'CREATE TABLE workspace_projects(owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,role TEXT,revision INTEGER,archived INTEGER,folder_id TEXT,folder_ids TEXT)',
    'CREATE TABLE wallet_folders(owner_id TEXT,id TEXT,chain TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE launch_metadata_releases(owner_id TEXT,project_id TEXT,id TEXT)',
  ])
    await client.execute(sql);
  const document = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: f.input.create.name,
      ticker: f.input.create.symbol,
      developerBuy: 0.1,
      holdersBuy: 0.3000015,
      holderCount: 18,
      holdersDistribution: {
        kind: 'custom',
        weights: f.input.holders.map((h) =>
          h.kind === 'exact-base-output' ? h.tokenAmountRaw : '0',
        ),
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
          address: f.input.create.payer,
          revision: 1,
          folderRevision: 0,
          root: true,
        },
        recipients: f.input.holders.map((h) => ({
          address: h.address,
          revision: 1,
          folderRevision: 0,
          root: true,
        })),
      },
    },
  });
  const terms = {
    projectId: 'group',
    updatedAt: new Date().toISOString(),
    origin: 'https://bundle.example',
    releaseId: 'a'.repeat(64),
    payer: f.input.create.payer,
    payerRevision: 1,
    mint: f.input.create.mint,
    feeAndRentLimitRaw: f.limits.deployerFeeAndRentLimitRaw,
    developerMaximumQuoteCostRaw: f.input.developer!.maximumQuoteCostRaw,
    holderLimits: f.input.holders.map((h, i) => ({
      address: h.address,
      feeAndRentLimitRaw: f.limits.holders[i].feeAndRentLimitRaw,
      ...(h.kind === 'exact-base-output'
        ? { maximumQuoteCostRaw: h.maximumQuoteCostRaw }
        : {}),
    })),
  };
  await client.execute({
    sql: 'INSERT INTO workspace_projects VALUES(?,?,?,?,0)',
    args: ['alice', 'group', JSON.stringify(document), terms.updatedAt],
  });
  await client.execute({
    sql: 'INSERT INTO launch_metadata_releases VALUES(?,?,?)',
    args: ['alice', 'group', terms.releaseId],
  });
  for (const [address, role] of [
    [terms.payer, 'Deployer'],
    ...f.input.holders.map((h) => [h.address, 'Recipient']),
  ]) {
    await client.execute({
      sql: "INSERT INTO workspace_wallets VALUES('alice','Solana',?,?,1,0,'',NULL)",
      args: [address, role],
    });
    await client.execute({
      sql: "INSERT INTO wallet_ownership_proofs VALUES('alice','Solana',?)",
      args: [address],
    });
  }
  // Only the create preflight is controlled here. Owned reads, group builders/funding/replay/economics are real code.
  mocked.mockImplementation(async (_db, _owner, _terms, _signal, options) => {
    options?.captureInput?.(structuredClone(f.input.create));
    return {
      format: 'pump-create-preflight-v1' as const,
      executionAllowed: false as const,
      signingAllowed: false as const,
      completeLaunch: false as const,
      containsInitialBuy: false as const,
      network: 'mainnet' as const,
      projectId: terms.projectId,
      projectUpdatedAt: terms.updatedAt,
      payer: terms.payer,
      payerRevision: terms.payerRevision,
      mint: terms.mint,
      metadataReleaseId: terms.releaseId,
      requestedDeveloperBuy: document.plan.developerBuy,
      requestedHoldersBuy: document.plan.holdersBuy,
      requestedHoldersBuyQuote: document.plan.holdersBuyQuote ?? null,
      quote: { ...f.group.quote, mint: address(f.input.create.quoteMint) },
      metadataUri: f.input.create.uri,
      simulation: f.creationPreflight.simulation,
      packet: {
        transaction: f.creationPreflight.preparation.transaction,
        sha256: f.creationPreflight.preparation.packetSha256,
        bytes: f.creationPreflight.preparation.packetBytes,
        lastValidBlockHeight: f.input.create.lastValidBlockHeight.toString(),
      },
    };
  });
  const db = createTursoDatabase(client);
  const run = (
    provider: PumpLaunchRpc = f.rpc,
    owner = 'alice',
    supplied = terms,
  ) =>
    preflightOwnedPumpLaunchGroup(
      db,
      owner,
      supplied,
      new AbortController().signal,
      { rpc: provider },
    );
  return { ...f, client, db, terms, document, run };
}
it('derives complete saved targets and collects an owned multi-packet group without signing permission', async () => {
  const f = await fixture(),
    result = await f.run();
  expect(result.group.manifestSha256).toBe(f.group.manifestSha256);
  expect(result.targets.items).toHaveLength(18);
  expect(result.targets.items[2].participates).toBe(false);
  expect(result).toMatchObject({
    fundingValidated: true,
    settlementValidated: true,
    durableReviewRequired: true,
    reservationRequired: true,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  expect(
    f.calls.filter((call) => call.method === 'simulateBundle'),
  ).toHaveLength(1);
}, 15000);
it('rejects another owner and per-slot overrides before provider reads', async () => {
  const f = await fixture();
  await expect(f.run(f.rpc, 'bob')).rejects.toThrow('Owned project');
  await expect(
    f.run(f.rpc, 'alice', {
      ...f.terms,
      holderLimits: [...f.terms.holderLimits].reverse(),
    }),
  ).rejects.toThrow('slot in order');
  expect(f.calls).toHaveLength(0);
}, 15000);
it('rejects a holder revision changed during funding before replay', async () => {
  const f = await fixture();
  let changed = false;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    if (!changed && method === 'getFeeForMessage') {
      changed = true;
      await f.client.execute({
        sql: 'UPDATE workspace_wallets SET revision=2 WHERE address=?',
        args: [f.input.holders[0].address],
      });
    }
    return f.rpc(method, params, signal);
  };
  await expect(f.run(rpc)).rejects.toThrow('owned wallet revision');
  expect(
    f.calls.filter((call) => call.method === 'simulateBundle'),
  ).toHaveLength(0);
}, 15000);
it('rejects a revoked ownership proof during economic collection', async () => {
  const f = await fixture();
  let changed = false;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    if (!changed && method === 'getMinimumBalanceForRentExemption') {
      changed = true;
      await f.client.execute({
        sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
        args: [f.input.holders[0].address],
      });
    }
    return f.rpc(method, params, signal);
  };
  await expect(f.run(rpc)).rejects.toThrow('owned wallet revision');
}, 15000);
it('rejects same-revision project content changes during funding', async () => {
  const f = await fixture();
  let changed = false;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    if (!changed && method === 'getFeeForMessage') {
      changed = true;
      await f.client.execute({
        sql: 'UPDATE workspace_projects SET document=? WHERE id=?',
        args: [
          JSON.stringify({
            ...f.document,
            identity: { ...f.document.identity, description: 'changed' },
          }),
          'group',
        ],
      });
    }
    return f.rpc(method, params, signal);
  };
  await expect(f.run(rpc)).rejects.toThrow('context changed');
}, 15000);
it('preserves the original one-packet owned preparation contract after context extraction', async () => {
  const f = await fixture();
  const document = {
    ...f.document,
    plan: {
      ...f.document.plan,
      holderCount: 3,
      holdersBuy: 0.3,
      holdersDistribution: {
        ...f.document.plan.holdersDistribution!,
        weights: ['2', '1', '0'],
      },
    },
    options: {
      ...f.document.options,
      wallets: {
        ...f.document.options.wallets!,
        recipients: f.document.options.wallets!.recipients.slice(0, 3),
      },
    },
  };
  await f.client.execute({
    sql: 'UPDATE workspace_projects SET document=? WHERE id=?',
    args: [JSON.stringify(document), 'group'],
  });
  const capture = vi.fn();
  const result = await prepareOwnedPumpHolderPacket(
    f.db,
    'alice',
    { ...f.terms, holderLimits: f.terms.holderLimits.slice(0, 3) },
    new AbortController().signal,
    { rpc: f.rpc, captureInput: capture },
  );
  expect(result).toMatchObject({
    format: 'pump-owned-holder-packet-v1',
    fundingValidated: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(result.packet.requiredSigners).toHaveLength(4);
  expect(result).not.toHaveProperty('input');
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0][0].holders).toHaveLength(3);
  expect(f.calls).toHaveLength(0);
}, 15000);
