import type {
  MainnetFundingRecord,
  MainnetFundingHistory,
} from '../lib/mainnet-funding-history';
export function fundingLegRecord(
  item = 1,
  leg: number | undefined = 1,
  sequence = (item - 1) * 4 + (leg ?? 1),
): MainnetFundingRecord {
  return {
    sequence,
    withdrawalId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    createdAt: '2026-10-21T00:00:00.000Z',
    wallet: 'public-source',
    walletRevision: 1,
    recipient: 'public-destination',
    amount: '0.01',
    amountRaw: '10000000',
    asset: { kind: 'native', mint: null, decimals: 9 },
    funding: {
      format: 'mainnet-funding-v1',
      planId: 'saved-funding',
      revision: 1,
      item,
      ...(leg === undefined ? {} : { leg }),
      termsSha256: 'a'.repeat(64),
      scheduledAt: '2026-10-20T00:00:00.000Z',
    },
    state: 'awaiting_signature',
    evidenceGap: null,
    signature: null,
    feeLimitLamports: '5000',
    maximumDebitLamports: '10005000',
    reserveLamports: '890880',
    reviewExpiresAt: '2026-10-21T00:00:30.000Z',
    receipt: null,
    failure: null,
  };
}
export function fundingLegPage(
  records: MainnetFundingRecord[],
): MainnetFundingHistory {
  return {
    id: 'saved-funding',
    name: 'Synthetic routed funding',
    currentRevision: 1,
    archived: false,
    revision: 1,
    executionAllowed: false,
    events: [],
    progress: { revision: 1, records },
    nextCursor: null,
  };
}
