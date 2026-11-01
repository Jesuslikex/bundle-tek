import type { ProjectDocument } from './workspace-project';
import { allocateHolderBaseUnits } from './launch-distribution';
import { holdersBuyUnit } from './launch-buy';
import { projectPumpHolderSequence } from './pump-holder-pricing';
import { quoteCatalog } from './quote-catalog';

/**
 * Manual mode (Proxima "Launch Modes"): the deploy runs only the configured
 * Dev Buy; holder buys wait. Snipe starts the holder buys saved in the plan.
 *
 * This turns the saved plan (holder wallets, total holder quote budget and
 * distribution) into exact token targets against the live curve, in wallet
 * order. It plans only: every buy still goes through the existing organic
 * batch review, explicit approval, browser-local signing and separate send
 * approval. Nothing here signs or sends.
 */
export type SnipeCurve = {
  virtualTokensRaw: string;
  virtualQuoteRaw: string;
  realTokensRaw: string;
};

/** True when a saved plan defers its holder buys to Snipe. */
export function snipeDeferred(plan: Pick<ProjectDocument['plan'], 'mode'>) {
  return plan.mode === 'Manual';
}

/** Holder buys a Manual plan still has to start, in quote units. */
export function plannedSnipeQuote(plan: ProjectDocument['plan']) {
  const amount = plan.holdersBuyQuote ?? '';
  return /^\d{1,20}(\.\d{1,18})?$/.test(amount) && Number(amount) > 0
    ? amount
    : null;
}

function quoteRaw(value: string, decimals: number) {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error('Holder buy amount exceeds the quote asset precision.');
  const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (raw <= 0n || raw > (1n << 64n) - 1n)
    throw new Error('Save a positive holder buy amount.');
  return raw;
}

export function planSnipeBuys(input: {
  document: ProjectDocument;
  deployer: string;
  quoteMint: string;
  curve: SnipeCurve;
  feeConfig: Record<string, unknown>;
}) {
  const { document, deployer, quoteMint } = input;
  const plan = document.plan;
  if (plan.chain !== 'Solana' || plan.launchpad !== 'PumpFun')
    throw new Error('Snipe currently starts Pump.fun holder buys only.');
  if (!snipeDeferred(plan))
    throw new Error(
      'Snipe starts holder buys for Manual mode launches. This plan already ran its holder buys at launch.',
    );
  if (holdersBuyUnit(plan) !== 'quote')
    throw new Error('Manual holder buys are saved as a quote amount.');
  const amount = plannedSnipeQuote(plan);
  if (!amount)
    throw new Error(
      'This plan has no holder buy amount saved. Nothing to snipe.',
    );
  const quote = quoteCatalog('Solana', 'PumpFun').assets.find(
    (q) => q.address === quoteMint,
  );
  if (!quote || (plan.quoteAddress && plan.quoteAddress !== quoteMint))
    throw new Error('The launch quote asset differs from the saved plan.');
  const recipients = document.options.wallets?.recipients ?? [];
  if (
    document.options.wallets?.chain !== 'Solana' ||
    recipients.length !== plan.holderCount
  )
    throw new Error(
      'Save one holder wallet for every holder slot before sniping.',
    );
  const addresses = recipients.map((r) => r.address);
  if (new Set(addresses).size !== addresses.length)
    throw new Error('Each holder wallet may appear once.');
  if (addresses.includes(deployer))
    throw new Error('The deployer cannot also be a holder.');
  const budgets = allocateHolderBaseUnits(
    plan,
    quoteRaw(amount, quote.decimals),
  );
  // A distribution can leave slots empty (for example "single"); those
  // wallets simply do not buy. Every other slot keeps its exact share.
  const active = addresses
    .map((address, i) => ({ address, budget: budgets[i] }))
    .filter((slot) => slot.budget > 0n);
  if (!active.length)
    throw new Error(
      'No holder slot receives a quote amount. Nothing to snipe.',
    );
  // Sequential projection: each buy sees the curve after the previous ones,
  // matching the order the buys are sent in.
  const projection = projectPumpHolderSequence({
    quoteMint,
    curve: input.curve,
    feeConfig: input.feeConfig,
    trades: active.map((slot) => ({
      address: slot.address,
      kind: 'exact-quote-input' as const,
      quoteAmountRaw: slot.budget.toString(),
      minimumTokenOutputRaw: '1',
    })),
  });
  return {
    quoteSymbol: quote.symbol,
    quoteDecimals: quote.decimals,
    totalQuoteRaw: budgets.reduce((s, b) => s + b, 0n).toString(),
    buys: projection.rows.map((row, i) => ({
      address: row.address,
      tokenAmountRaw: row.tokenAmountRaw,
      quoteBudgetRaw: active[i].budget.toString(),
    })),
  };
}
