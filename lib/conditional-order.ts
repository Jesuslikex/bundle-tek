import {
  conditionalSellTerms,
  decodeConditionalSellOrder,
  type ConditionalSellOrder,
  type ConditionalSellTerms,
} from './conditional-sell-order';
import { formatNativeBalance } from './wallet-balance-format';
export const CONDITIONAL_BUY_INPUT_MINT =
  'So11111111111111111111111111111111111111112';
export type ConditionalBuyTerms = Omit<ConditionalSellTerms, 'format'> & {
  format: 'conditional-buy-v1';
  side: 'Buy';
  inputMint: typeof CONDITIONAL_BUY_INPUT_MINT;
  inputDecimals: 9;
};
export type ConditionalOrder = Omit<ConditionalSellOrder, 'terms'> & {
  terms: ConditionalSellTerms | ConditionalBuyTerms;
};
export function conditionalOrderSide(order: ConditionalOrder): 'Buy' | 'Sell' {
  return order.terms.format === 'conditional-buy-v1' ? 'Buy' : 'Sell';
}
export function conditionalOrderInputDecimals(order: ConditionalOrder) {
  return conditionalOrderSide(order) === 'Buy' ? 9 : order.terms.decimals;
}
export function conditionalOrderTerms(
  input: Record<string, unknown>,
  token: { chain: string; address: string; decimals: number },
): ConditionalOrder['terms'] {
  if (input.side === undefined || input.side === 'Sell')
    return conditionalSellTerms(input, token);
  if (
    input.side !== 'Buy' ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255 ||
    token.address === CONDITIONAL_BUY_INPUT_MINT ||
    (input.kind === 'grid' && input.direction !== 'at-or-below')
  )
    throw new Error(
      'Choose an exact SOL-input Buy condition and distinct target mint.',
    );
  const terms = conditionalSellTerms(
    {
      ...input,
      direction: input.kind === 'grid' ? 'at-or-above' : input.direction,
    },
    { ...token, decimals: 9 },
  );
  return {
    ...terms,
    format: 'conditional-buy-v1',
    side: 'Buy',
    inputMint: CONDITIONAL_BUY_INPUT_MINT,
    inputDecimals: 9,
    decimals: token.decimals,
    direction: input.direction as ConditionalSellTerms['direction'],
  };
}
export function decodeConditionalOrder(value: unknown): ConditionalOrder {
  const row = value as ConditionalOrder;
  if (row?.terms?.format === 'conditional-sell-v1')
    return decodeConditionalSellOrder(value);
  if (
    !row ||
    row.terms?.format !== 'conditional-buy-v1' ||
    row.terms.side !== 'Buy' ||
    row.terms.inputMint !== CONDITIONAL_BUY_INPUT_MINT ||
    row.terms.inputDecimals !== 9 ||
    !['draft', 'cancelled'].includes(row.state) ||
    row.revision !== (row.state === 'draft' ? 1 : 2) ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    Date.parse(row.updatedAt) < Date.parse(row.createdAt) ||
    typeof row.terms.totalRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(row.terms.totalRaw) ||
    BigInt(row.terms.totalRaw) > 18446744073709551615n ||
    !Array.isArray(row.terms.levels) ||
    row.terms.levels.length < 1 ||
    row.terms.levels.length > 50
  )
    throw new Error('Invalid saved conditional Buy order.');
  // Reuse the legacy identity/lifecycle validator with explicitly converted SOL input precision.
  const identity = decodeConditionalSellOrder({
    ...row,
    terms: {
      ...row.terms,
      format: 'conditional-sell-v1',
      decimals: 9,
      direction:
        row.terms.kind === 'grid' ? 'at-or-above' : row.terms.direction,
    },
  });
  const terms = conditionalOrderTerms(
    {
      projectId: row.terms.projectId,
      projectRevision: row.terms.projectRevision,
      wallet: row.terms.wallet,
      walletRevision: row.terms.walletRevision,
      pair: row.terms.pair,
      kind: row.terms.kind,
      side: 'Buy',
      direction: row.terms.direction,
      amount: formatNativeBalance(row.terms.totalRaw, 9),
      targetUsd: row.terms.levels[0].targetUsd,
      minimumUsd: row.terms.levels[0].targetUsd,
      maximumUsd: row.terms.levels.at(-1)!.targetUsd,
      lines: row.terms.levels.length,
    },
    { chain: 'Solana', address: row.terms.mint, decimals: row.terms.decimals },
  );
  const savedTerms = row.terms;
  if (
    Object.keys(terms).some((key) =>
      key === 'levels'
        ? terms.levels.length !== savedTerms.levels.length ||
          terms.levels.some((level, index) =>
            Object.keys(level).some(
              (field) =>
                level[field as keyof typeof level] !==
                savedTerms.levels[index][field as keyof typeof level],
            ),
          )
        : terms[key as keyof typeof terms] !==
          savedTerms[key as keyof typeof savedTerms],
    )
  )
    throw new Error(
      'Saved conditional Buy denomination or exact levels differ.',
    );
  return { ...identity, terms };
}
