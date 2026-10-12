import {
  validateFunding,
  type SavedFunding,
  type FundingDocument,
} from './funding-plan';
import { chainQuoteAssets } from './quote-catalog';
import { solanaTokenAtoms } from './solana-token-amount';
import type { NativeWithdrawalReview } from './native-withdrawal';

export type FundingSelection = {
  planId: string;
  revision: number;
  item: number;
};
export type FundingCapture = FundingSelection & {
  format: 'mainnet-funding-v1';
  termsSha256: string;
  scheduledAt: string;
};
export function mainnetFundingAsset(document: FundingDocument) {
  if (document.chain !== 'Solana')
    throw new Error('Choose a Solana funding asset.');
  if (document.currency === 'SOL' && document.assetAddress === undefined)
    return { kind: 'native' as const, decimals: 9, symbol: 'SOL' };
  const asset = chainQuoteAssets('Solana').find(
    (a) =>
      a.address === document.assetAddress && a.symbol === document.currency,
  );
  if (!asset || asset.address === 'So11111111111111111111111111111111111111112')
    throw new Error(
      'Select an exact supported token mint, or native SOL without a wrapped token address.',
    );
  return {
    kind: 'token' as const,
    mint: asset.address,
    decimals: asset.decimals,
    symbol: asset.symbol,
  };
}
export type FundingTransferContext = Pick<
  NativeWithdrawalReview,
  'wallet' | 'recipient' | 'amountRaw'
> & {
  token?: Pick<
    NonNullable<NativeWithdrawalReview['token']>,
    'mint' | 'decimals'
  >;
};
export function fundingSelection(value: unknown): FundingSelection {
  const v = value as FundingSelection;
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'item,planId,revision' ||
    typeof v.planId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(v.planId) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    v.revision >= 1e9 ||
    !Number.isInteger(v.item) ||
    v.item < 1 ||
    v.item > 100
  )
    throw new Error('Choose an exact saved funding recipient.');
  return { planId: v.planId, revision: v.revision, item: v.item };
}
export function validatedFundingCapture(value: unknown): FundingCapture {
  const c = value as FundingCapture;
  if (
    !c ||
    Object.keys(c).sort().join(',') !==
      'format,item,planId,revision,scheduledAt,termsSha256' ||
    c.format !== 'mainnet-funding-v1' ||
    !/^[a-f0-9]{64}$/.test(c.termsSha256) ||
    typeof c.scheduledAt !== 'string' ||
    !Number.isFinite(Date.parse(c.scheduledAt))
  )
    throw new Error('Saved funding capture differs.');
  fundingSelection({ planId: c.planId, revision: c.revision, item: c.item });
  return c;
}
async function fingerprint(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function selectedFundingCapture(
  plan: SavedFunding,
  selection: FundingSelection,
  review: FundingTransferContext,
  now?: number,
): Promise<FundingCapture> {
  fundingSelection(selection);
  const terms = validateFunding(plan.document);
  const item = terms.items[selection.item - 1];
  const asset = mainnetFundingAsset(terms);
  if (
    plan.id !== selection.planId ||
    plan.revision !== selection.revision ||
    terms.chain !== 'Solana' ||
    terms.source !== 'Wallet' ||
    !terms.funderAddress ||
    !item ||
    (asset.kind === 'native'
      ? Boolean(review.token)
      : !review.token ||
        review.token.mint !== asset.mint ||
        review.token.decimals !== asset.decimals) ||
    review.wallet !== terms.funderAddress ||
    review.recipient !== item.address ||
    review.amountRaw !==
      solanaTokenAtoms(item.amount, asset.decimals).toString() ||
    (now !== undefined && (plan.archived || Date.parse(item.scheduledAt) > now))
  )
    throw new Error(
      'Funding draft changed, is not due or differs from this exact asset transfer.',
    );
  return {
    ...selection,
    format: 'mainnet-funding-v1',
    termsSha256: await fingerprint(terms),
    scheduledAt: item.scheduledAt,
  };
}
export async function requireSelectedFundingReview(
  review: NativeWithdrawalReview,
  plan: SavedFunding,
  item: number,
) {
  const c = validatedFundingCapture(review.funding);
  const expected = await selectedFundingCapture(
    plan,
    { planId: plan.id, revision: plan.revision, item },
    review,
  );
  if (
    Object.keys(expected).some(
      (key) =>
        c[key as keyof FundingCapture] !==
        expected[key as keyof FundingCapture],
    )
  )
    throw new Error(
      'Transfer differs from the selected saved funding recipient.',
    );
}
