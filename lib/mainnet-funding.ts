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
  // Classic proxy routes only: 1 is funder to first proxy, the last leg reaches the recipient.
  leg?: number;
};
// Each earlier leg carries this much extra SOL so the next proxy can pay its own fee.
export const PROXY_LEG_FEE_ALLOWANCE_LAMPORTS = 100_000n;
export type FundingLeg = { wallet: string; recipient: string; amountRaw: string };
export function fundingLegs(
  document: FundingDocument,
  item: number,
): FundingLeg[] {
  const entry = document.items[item - 1];
  if (!entry) throw new Error('Choose an exact saved funding recipient.');
  const asset = mainnetFundingAsset(document);
  const amount = solanaTokenAtoms(entry.amount, asset.decimals);
  const route = [document.funderAddress, ...(entry.proxies ?? []), entry.address];
  return route.slice(0, -1).map((wallet, n) => ({
    wallet,
    recipient: route[n + 1],
    amountRaw: (
      amount +
      BigInt(route.length - 2 - n) * PROXY_LEG_FEE_ALLOWANCE_LAMPORTS
    ).toString(),
  }));
}
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
    !['item,planId,revision', 'item,leg,planId,revision'].includes(
      Object.keys(v).sort().join(','),
    ) ||
    (v.leg !== undefined &&
      (!Number.isInteger(v.leg) || v.leg < 1 || v.leg > 4)) ||
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
  return {
    planId: v.planId,
    revision: v.revision,
    item: v.item,
    ...(v.leg === undefined ? {} : { leg: v.leg }),
  };
}
export function validatedFundingCapture(value: unknown): FundingCapture {
  const c = value as FundingCapture;
  if (
    !c ||
    ![
      'format,item,planId,revision,scheduledAt,termsSha256',
      'format,item,leg,planId,revision,scheduledAt,termsSha256',
    ].includes(Object.keys(c).sort().join(',')) ||
    c.format !== 'mainnet-funding-v1' ||
    !/^[a-f0-9]{64}$/.test(c.termsSha256) ||
    typeof c.scheduledAt !== 'string' ||
    !Number.isFinite(Date.parse(c.scheduledAt))
  )
    throw new Error('Saved funding capture differs.');
  fundingSelection(captureSelection(c));
  return c;
}
export function captureSelection(c: FundingCapture): FundingSelection {
  return {
    planId: c.planId,
    revision: c.revision,
    item: c.item,
    ...(c.leg === undefined ? {} : { leg: c.leg }),
  };
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
  const legs = item ? fundingLegs(terms, selection.item) : [];
  // Direct recipients have no leg; proxied recipients must name one.
  const leg =
    item && (item.proxies ? selection.leg !== undefined : selection.leg === undefined)
      ? legs[(selection.leg ?? 1) - 1]
      : undefined;
  if (
    plan.id !== selection.planId ||
    plan.revision !== selection.revision ||
    terms.chain !== 'Solana' ||
    terms.source !== 'Wallet' ||
    !terms.funderAddress ||
    !item ||
    !leg ||
    (asset.kind === 'native'
      ? Boolean(review.token)
      : !review.token ||
        review.token.mint !== asset.mint ||
        review.token.decimals !== asset.decimals) ||
    review.wallet !== leg.wallet ||
    review.recipient !== leg.recipient ||
    review.amountRaw !== leg.amountRaw ||
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
  leg?: number,
) {
  const c = validatedFundingCapture(review.funding);
  const expected = await selectedFundingCapture(
    plan,
    {
      planId: plan.id,
      revision: plan.revision,
      item,
      ...(leg === undefined ? {} : { leg }),
    },
    review,
  );
  if (
    Object.keys(c).length !== Object.keys(expected).length ||
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
