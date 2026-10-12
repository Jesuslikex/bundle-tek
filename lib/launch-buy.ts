// Captured MainSettingsInputs (4497422) uses the selected quote token for native buys.
// A quote amount never establishes funded wallets or executable launch sizing.
import type { LaunchPlanInput } from './launch-plan';
import { quoteAsset, quoteCatalog } from './quote-catalog';

export function holdersBuyUnit(
  plan: Pick<LaunchPlanInput, 'mode' | 'scheduled' | 'launchpad'>,
): 'supply' | 'quote' {
  return !plan.scheduled &&
    (plan.mode === 'Block-0' ||
      plan.mode === 'Organic' ||
      (plan.launchpad === 'Stoxes' && plan.mode !== 'Manual'))
    ? 'supply'
    : 'quote';
}

export function parseHoldersQuoteAmount(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,29})(\.\d{1,18})?$/.test(value)
  )
    throw new Error(
      'Holders quote amount must be a non-negative decimal with at most 30 whole digits and 18 decimal places.',
    );
  const [whole, fraction] = value.split('.');
  const trimmed = fraction?.replace(/0+$/, '');
  return whole + (trimmed ? '.' + trimmed : '');
}

export function holdersQuoteDecimals(
  plan: Pick<
    LaunchPlanInput,
    'chain' | 'launchpad' | 'currency' | 'quoteAddress'
  >,
): number | null {
  const matches = quoteCatalog(plan.chain, plan.launchpad).assets.filter(
    (a) => a.symbol === plan.currency,
  );
  const selected = plan.quoteAddress
    ? quoteAsset(plan.chain, plan.launchpad, plan.quoteAddress)
    : matches.length === 1
      ? matches[0]
      : undefined;
  return selected?.symbol === plan.currency ? selected.decimals : null;
}

export function validateHoldersQuoteAmount(plan: LaunchPlanInput) {
  const amount = parseHoldersQuoteAmount(plan.holdersBuyQuote);
  if (amount === undefined) return;
  const decimals = holdersQuoteDecimals(plan);
  if (decimals === null)
    throw new Error(
      'Select a captured quote token before entering its buy amount.',
    );
  if ((amount.split('.')[1]?.length ?? 0) > decimals)
    throw new Error(
      `${plan.currency} holders amount allows at most ${decimals} decimal places.`,
    );
}

export function holdersQuoteAfterPlanChange(
  current: LaunchPlanInput,
  change: Partial<LaunchPlanInput>,
) {
  const denominationChanged =
    (change.chain !== undefined && change.chain !== current.chain) ||
    (change.launchpad !== undefined &&
      change.launchpad !== current.launchpad) ||
    (change.currency !== undefined && change.currency !== current.currency) ||
    ('quoteAddress' in change && change.quoteAddress !== current.quoteAddress);
  // An explicit fresh entry belongs to the new quote. Otherwise never carry an
  // amount into a different token denomination or infer it from a percentage.
  if ('holdersBuyQuote' in change) return change.holdersBuyQuote;
  return denominationChanged ? undefined : current.holdersBuyQuote;
}
