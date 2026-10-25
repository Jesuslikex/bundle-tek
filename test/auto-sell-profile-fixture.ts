import { newAutoSellStrategy } from '@/lib/auto-sell';
import {
  autoSellProfileSha256,
  autoSellProfileTermsJson,
  type AutoSellProfileTerms,
  type SavedAutoSellProfile,
} from '@/lib/auto-sell-profile';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
export const profileProject: ImportedTokenProject = {
  id: '00000000-0000-4000-8000-000000000001',
  revision: 1,
  archived: false,
  updatedAt: '2026-10-25T00:00:00.000Z',
  document: {
    format: 'imported-token-project-v1',
    executionAllowed: false,
    token: {
      chain: 'Solana',
      address: 'So11111111111111111111111111111111111111112',
      name: 'Fixture token',
      symbol: 'FIX',
      decimals: 9,
      totalSupplyRaw: '1000000000',
      observedAt: '2026-10-25T00:00:00.000Z',
      source: 'fixture.invalid',
    },
  },
};
export const profileWallet: WorkspaceWallet = {
  chain: 'Solana',
  address: '11111111111111111111111111111111',
  folderId: 'fixture',
  label: 'Fixture wallet',
  role: 'Recipient',
  archived: false,
  revision: 1,
  updatedAt: '2026-10-25T00:00:00.000Z',
};
export function profileTerms(): AutoSellProfileTerms {
  return {
    name: 'Fixture Auto Sell',
    projectId: profileProject.id,
    projectRevision: 1,
    token: {
      chain: 'Solana',
      mint: profileProject.document.token.address,
      decimals: 9,
      totalSupplyRaw: '1000000000',
    },
    wallets: [{ address: profileWallet.address, revision: 1 }],
    configuration: {
      strategies: [
        {
          ...newAutoSellStrategy(0),
          id: 'fixture-strategy',
          replicationPercent: '100',
        },
      ],
      session: {
        startDelaySeconds: 0,
        endDurationSeconds: 60,
        endMaxSupplyPercent: '10',
        maxSlippageBps: 50,
      },
    },
  };
}
export async function savedProfile(
  overrides: Partial<SavedAutoSellProfile> = {},
): Promise<SavedAutoSellProfile> {
  const terms = overrides.terms ?? profileTerms();
  return {
    format: 'auto-sell-profile-v1',
    id: '10000000-0000-4000-8000-000000000001',
    profileId: '20000000-0000-4000-8000-000000000001',
    version: 1,
    createdAt: '2026-10-25T00:00:00.000Z',
    sha256: await autoSellProfileSha256(autoSellProfileTermsJson(terms)),
    terms,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
    ...overrides,
  };
}
export function profileSummary(p: SavedAutoSellProfile) {
  return {
    id: p.id,
    profileId: p.profileId,
    version: p.version,
    name: p.terms.name,
    projectRevision: p.terms.projectRevision,
    createdAt: p.createdAt,
    sha256: p.sha256,
    token: p.terms.token,
    walletCount: p.terms.wallets.length,
    strategyCount: p.terms.configuration.strategies.length,
  };
}
export const profileAuthority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
