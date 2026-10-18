import bs58 from 'bs58';
import { validateFunding, type SavedFunding } from '@/lib/funding-plan';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { ExchangeFundingReview } from '@/lib/exchange-funding-review';

export function exchangeFundingReviewFixture(now = Date.now()) {
  const funder: WorkspaceWallet = {
    chain: 'Solana',
    address: bs58.encode(new Uint8Array(32).fill(7)),
    revision: 2,
    archived: false,
    label: 'Synthetic receiving funder',
    folderId: '',
    role: 'Funder',
    updatedAt: new Date(now).toISOString(),
  };
  const plan: SavedFunding = {
    id: 'launch-funding',
    revision: 3,
    archived: false,
    updatedAt: new Date(now).toISOString(),
    document: validateFunding({
      name: 'Synthetic exchange funding',
      chain: 'Solana',
      currency: 'SOL',
      source: 'CEX',
      sourceLabel: 'Exchange',
      funderAddress: funder.address,
      startAt: new Date(now).toISOString(),
      delaySeconds: 0,
      recipients: [
        { address: bs58.encode(new Uint8Array(32).fill(8)), amount: '1' },
      ],
    }),
  };
  const review: ExchangeFundingReview = {
    format: 'exchange-funding-quote-v1',
    provider: 'ChangeNOW',
    id: '00000000-0000-4000-8000-000000000001',
    planId: plan.id,
    revision: plan.revision,
    planUpdatedAt: plan.updatedAt,
    funderRevision: funder.revision,
    funder: funder.address,
    network: 'solana-mainnet',
    currency: 'SOL',
    depositLamports: '1150000000',
    expectedPayoutLamports: '1100000000',
    providerCostLamports: '50000000',
    distributionTotalLamports: '1000000000',
    undistributedPayoutLamports: '100000000',
    quotedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    warning:
      'The exchange processes deposit and payout separately. Network fees and reserves are additional.',
    providerWarning: 'Verification may be required.',
    durableReview: true,
    orderCreationAllowed: false,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  return {
    plan,
    funder,
    review,
    status: {
      provider: 'ChangeNOW',
      quotesConfigured: true,
      orderCreationAllowed: false,
      fundingAllowed: false,
      signingAllowed: false,
      executionAllowed: false,
    },
  };
}
