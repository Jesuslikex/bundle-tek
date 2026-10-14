import { pumpHolderSettlementFixture } from './pump-holder-settlement-fixture';
import { buildPumpCreateHolderMessage } from '../lib/pump-holder-message';
import { DEFAULT_LAUNCH_PLAN } from '../lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '../lib/workspace-project';
import { encodePumpSigningInput } from '../lib/pump-launch-signing';
import {
  pumpHolderDigest,
  requirePumpHolderReview,
  type PumpHolderReview,
} from '../lib/pump-holder-review';
import type { HolderLaunch } from '../lib/pump-holder-launch-client';

/** Controlled UI evidence: real reconstructed packet and independent economic fixture, with metadata URI changed only for local rendering. */
export async function pumpHolderClientFixture(
  origin = 'https://bundle.test',
  stock = false,
  token22 = false,
  quoteMode = false,
) {
  const g = await pumpHolderSettlementFixture(stock, token22, true, false);
  const releaseId = 'a'.repeat(64),
    updatedAt = '2026-10-14T00:00:00Z';
  const create = {
    ...g.input.create,
    uri: `${origin}/api/launch/metadata/${releaseId}`,
  };
  const economics = await g.run(),
    limits = structuredClone(g.limits),
    input = { ...g.input, create };
  const costs = g.input.holders.map(
    (h) =>
      economics.wallets.find((w) => w.address === h.address)?.quoteDebitRaw ??
      '0',
  );
  if (quoteMode) {
    input.holders = input.holders.map((h, i) =>
      h.kind === 'none'
        ? h
        : {
            address: h.address,
            kind: 'exact-quote-input' as const,
            quoteAmountRaw: costs[i],
            minimumTokenOutputRaw: '1',
          },
    );
    limits.holders = limits.holders.map((l, i) => ({
      ...l,
      maximumQuoteCostRaw: null,
      minimumTokenOutputRaw: costs[i] === '0' ? null : '1',
    }));
  }
  const built = await buildPumpCreateHolderMessage(input);
  const quoteTotal = costs
    .reduce((sum, c) => sum + BigInt(c), 0n)
    .toString()
    .padStart(built.quote.decimals + 1, '0');
  const document = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: create.name,
      ticker: create.symbol,
      developerBuy: 0.1,
      holdersBuy: 0.3,
      holderCount: 3,
      ...(stock ? { currency: 'TSLAX', quoteAddress: create.quoteMint } : {}),
      ...(quoteMode
        ? {
            mode: 'Manual',
            holdersBuy: 0,
            holdersBuyQuote:
              quoteTotal.slice(0, -built.quote.decimals) +
              '.' +
              quoteTotal.slice(-built.quote.decimals),
          }
        : {}),
      holdersDistribution: {
        kind: 'custom',
        weights: quoteMode ? costs : ['2', '1', '0'],
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
          address: create.payer,
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
  const digest = async (v: unknown) =>
    Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(v)),
      ),
    ).toString('hex');
  const context = {
    format: 'pump-create-holders-review-v1' as const,
    id: crypto.randomUUID(),
    projectId: 'holders',
    projectUpdatedAt: updatedAt,
    releaseId,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    transaction: built.transaction,
    sha256: built.packetSha256,
    input: { ...input, create: encodePumpSigningInput(create) },
    document,
    allowances: limits,
    deployerBindingSha256: 'b'.repeat(64),
    holderBindingSha256: 'c'.repeat(64),
    allowanceSha256: await digest(limits),
  };
  const review: PumpHolderReview = {
    ...context,
    contextSha256: await pumpHolderDigest(context),
  };
  await requirePumpHolderReview(review);
  const accounting = {
    ...economics,
    packetSha256: built.packetSha256,
    rpcCollectionRequired: false,
  };
  const launch = {
    format: review.format,
    review,
    state: 'review',
    signature: null,
    receipt: null,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
    simulation: {
      packet: built,
      allowances: limits,
      allWalletSimulation: {
        packetSha256: review.sha256,
        settlementValidated: true,
        sourceBankMatched: true,
        networkFeeRaw: '20000',
        accounting,
      },
    },
  } as unknown as HolderLaunch;
  const project = {
    id: review.projectId,
    updatedAt,
    payer: { address: create.payer, revision: 1 },
    document,
  };
  const observation = {
    format: 'pump-create-preflight-v1',
    signingAllowed: false,
    projectId: project.id,
    projectUpdatedAt: updatedAt,
    metadataReleaseId: releaseId,
    metadataUri: create.uri,
    mint: create.mint,
    payer: create.payer,
    quote: {
      mint: create.quoteMint,
      decimals: built.quote.decimals,
      tokenSupplyRaw: built.quote.tokenSupplyRaw,
    },
  };
  return {
    g,
    built,
    launch: JSON.parse(JSON.stringify(launch)) as HolderLaunch,
    project,
    releaseId,
    observation,
  };
}
