import { createClient, type Client } from '@libsql/client';
import { address } from '@solana/kit';
import type { MockedFunction } from 'vitest';
import { createTursoDatabase } from '../db/turso';
import { pumpLaunchGroupSimulationFixture } from './pump-launch-group-simulation-fixture';
import { DEFAULT_LAUNCH_PLAN } from '../lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '../lib/workspace-project';
import type { preflightOwnedPumpCreate } from '../lib/owned-pump-preflight';
import { preflightOwnedPumpLaunchGroup } from '../lib/pump-launch-group-preparation';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';
export async function pumpOwnedGroupFixture(
  mocked: MockedFunction<typeof preflightOwnedPumpCreate>,
  clients: Client[],
) {
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
