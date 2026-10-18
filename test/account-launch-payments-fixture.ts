import type { AccountLaunchPayments } from '../lib/account-launch-payments';
import {
  recordedCostReviewId,
  recordedCostMint,
} from './pump-group-recorded-costs-fixture';
/** Synthetic response only; not a real launch, wallet balance or chain receipt. */
export const accountLaunchPaymentsFixture: AccountLaunchPayments = {
  format: 'pump-group-payments-v1',
  reviewId: recordedCostReviewId,
  mint: recordedCostMint,
  evidenceSha256: 'b'.repeat(64),
  quoteMint: 'So11111111111111111111111111111111111111112',
  quoteDecimals: 9,
  packets: [
    {
      index: 0,
      outcome: 'success',
      verified: true,
      reason: null,
      networkFeeLamports: '5000',
      wallets: [
        {
          wallet: 'So11111111111111111111111111111111111111112',
          hasBuy: true,
          acquiredRaw: '1234567',
          preTokenBalanceRecovered: false,
          purchaseQuoteRaw: '1000',
          accountFundingLamports: '3500000',
          networkFeeLamports: '5000',
        },
      ],
    },
  ],
  verifiedPacketCount: 1,
  purchaseQuoteSubtotalRaw: '1000',
  accountFundingSubtotalLamports: '3500000',
  knownNetworkFeeLamports: '5000',
  complete: true,
  rentRecoveryVerified: false,
  venueFeeSplitVerified: false,
  acquisitionBasisVerified: false,
  tipIncluded: false,
  executionAllowed: false,
};
