import {
  validatedWithdrawalActivity,
  type WithdrawalActivityEvent,
} from './withdrawal-activity';
import { withdrawalFailureLabel } from './withdrawal-failure';
import type { MainnetFundingRecord } from './mainnet-funding-history';

export async function mainnetFundingHistoryRecord(
  value: WithdrawalActivityEvent,
  planId: string,
  revision: number | null,
): Promise<MainnetFundingRecord> {
  const event = await validatedWithdrawalActivity(value);
  const row = event.withdrawal,
    review = row.document,
    funding = review.funding;
  const timestamp = (value: string) => {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
      throw new Error('Funding history timestamp is not canonical.');
    return parsed;
  };
  const capturedAt = timestamp(event.createdAt);
  if (timestamp(row.createdAt) > capturedAt)
    throw new Error('Funding history predates its retained attempt.');
  let evidenceGap: string | null = null;
  for (const outcome of [row.receipt, row.failureReceipt]) {
    if (!outcome) continue;
    try {
      if (timestamp(outcome.observedAt) > capturedAt)
        evidenceGap =
          'Outcome observation follows this captured transition. The recorded state is retained, but outcome evidence is withheld.';
    } catch {
      evidenceGap =
        'Outcome observation timestamp is not canonical. The recorded state is retained, but outcome evidence is withheld.';
    }
  }
  const receipt = evidenceGap ? null : row.receipt;
  const failure = evidenceGap ? null : row.failureReceipt;
  if (
    !funding ||
    funding.planId !== planId ||
    (revision !== null && funding.revision !== revision)
  )
    throw new Error('Funding capture differs from its history context.');
  return {
    sequence: event.sequence,
    createdAt: event.createdAt,
    withdrawalId: row.id,
    wallet: row.wallet,
    walletRevision: row.walletRevision,
    recipient: review.recipient,
    amount: review.amount,
    amountRaw: review.amountRaw,
    asset: {
      kind: review.token ? 'token' : 'native',
      mint: review.token?.mint ?? null,
      decimals: review.token?.decimals ?? 9,
    },
    funding: { ...funding },
    state: row.state,
    evidenceGap,
    signature: row.signature,
    feeLimitLamports: review.feeLamports,
    maximumDebitLamports: review.maximumDebitRaw,
    reserveLamports: review.reserveLamports,
    reviewExpiresAt: review.expiresAt,
    receipt: receipt
      ? {
          slot: receipt.slot,
          observedAt: receipt.observedAt,
          deliveredRaw:
            receipt.token?.destinationChangeRaw ?? receipt.recipientChangeRaw,
          networkFeeLamports: receipt.networkFeeLamports,
          accountRentLamports: receipt.token?.accountRentLamports ?? '0',
          transferFeeRaw: receipt.token?.transferFeeRaw ?? null,
        }
      : null,
    failure: failure
      ? {
          slot: failure.slot,
          observedAt: failure.observedAt,
          networkFeeLamports: failure.networkFeeLamports,
          label: withdrawalFailureLabel(failure.error),
        }
      : null,
  };
}
