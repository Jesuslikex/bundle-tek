import { pumpHolderSourceHash } from '../lib/pump-holder-source';
import type { PumpRpcAccount } from '../lib/pump-launch-simulation';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import type { MockedFunction } from 'vitest';
import { createTursoDatabase } from '../db/turso';
import { pumpHolderSettlementFixture } from './pump-holder-settlement-fixture';
import { DEFAULT_LAUNCH_PLAN } from '../lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '../lib/workspace-project';
import type { preflightOwnedPumpHolderSimulation } from '../lib/pump-holder-preparation';
import { preparePumpHolderReview } from '../lib/pump-holder-review-service';
import type { PumpHolderReview } from '../lib/pump-holder-review';
import type { PumpHolderConsent } from '../lib/pump-holder-signing';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  address,
  type SignatureBytes,
} from '@solana/kit-v1';
export const holderTestRpc: PumpLaunchRpc = async () => {
  throw new Error('Unexpected provider read outside the mocked preflight');
};
export const holderTestSignal = () => new AbortController().signal;

const rpc = holderTestRpc,
  signal = holderTestSignal;
export const holderConsent = (review: PumpHolderReview): PumpHolderConsent => ({
  approved: true,
  reviewId: review.id,
  sha256: review.sha256,
  contextSha256: review.contextSha256,
  approvedScope: 'create-developer-and-holder-buys',
  acknowledgeSimulationLimits: true,
});
export async function signSyntheticPumpHolder(
  f: Awaited<ReturnType<typeof pumpHolderReviewServiceFixture>>,
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
export async function pumpHolderReviewServiceFixture(
  mocked: MockedFunction<typeof preflightOwnedPumpHolderSimulation>,
  clients: Client[],
) {
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
      minimumSlot: 100,
      maximumSlot: 100,
      packetSha256: g.packet.packetSha256,
      accounting,
      networkFeeRaw: '20000',
      programDeploymentHashes: g.creation.simulation.programDeploymentHashes,
      accountHashes: await Promise.all(
        g.evidence.addresses.map(async (address, i) => ({
          address,
          beforeSha256: digest(g.evidence.before[i]),
          simulatedSha256: digest(g.evidence.after[i]),
          sourceIdentitySha256: await pumpHolderSourceHash(
            g.packet,
            address,
            g.evidence.before[i] as PumpRpcAccount,
          ),
          simulatedIdentitySha256: await pumpHolderSourceHash(
            g.packet,
            address,
            g.evidence.after[i] as PumpRpcAccount,
          ),
        })),
      ),
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
    rpc,
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
