import {
  validateProjectDocument,
  type ProjectDocument,
} from './workspace-project';
import { holdersBuyUnit, parseHoldersQuoteAmount } from './launch-buy';
import { allocateHolderBaseUnits } from './launch-distribution';
import { pumpDeveloperBuyTarget } from './pump-initial-buy-preparation';
import { quoteCatalog } from './quote-catalog';

export type PumpHolderObservation = {
  tokenSupplyRaw: string;
  initialRealTokenReservesRaw: string;
  quoteMint: string;
  quoteDecimals: number;
};
const uint = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Read positive canonical Pump supply and reserve values.');
  return BigInt(value);
};
/** Server-internal sizing. Observations must come from independent chain collection; this does not authorize buys. */
export function buildPumpHolderTargets(
  supplied: ProjectDocument,
  suppliedObservation: PumpHolderObservation,
) {
  const document = validateProjectDocument(structuredClone(supplied)),
    observation = structuredClone(suppliedObservation);
  const { plan } = document,
    selection = document.options.wallets;
  if (plan.chain !== 'Solana' || plan.launchpad !== 'PumpFun' || plan.scheduled)
    throw new Error(
      'Choose an unscheduled PumpFun launch for initial holder buys.',
    );
  if (
    !selection ||
    selection.chain !== 'Solana' ||
    !selection.deployer ||
    selection.recipients.length !== plan.holderCount
  )
    throw new Error(
      'Save one distinct holder wallet for every planned slot and an exact deployer.',
    );
  const matches = quoteCatalog('Solana', 'PumpFun').assets.filter(
    (q) =>
      q.symbol === plan.currency &&
      (!plan.quoteAddress || q.address === plan.quoteAddress),
  );
  if (
    matches.length !== 1 ||
    matches[0].address !== observation.quoteMint ||
    matches[0].decimals !== observation.quoteDecimals
  )
    throw new Error(
      'Observed holder quote identity or precision differs from the saved selection.',
    );
  const supply = uint(observation.tokenSupplyRaw),
    reserve = uint(observation.initialRealTokenReservesRaw);
  if (reserve > supply)
    throw new Error('Pump reserve exceeds its observed total supply.');
  const unit = holdersBuyUnit(plan);
  let total: bigint;
  if (unit === 'supply') {
    total = BigInt(pumpDeveloperBuyTarget(supply.toString(), plan.holdersBuy));
    const developer =
      plan.developerBuy === 0
        ? 0n
        : BigInt(pumpDeveloperBuyTarget(supply.toString(), plan.developerBuy));
    if (total + developer >= reserve)
      throw new Error(
        'Initial buys must leave tokens on the curve; migration needs another reviewed path.',
      );
  } else {
    const amount = parseHoldersQuoteAmount(plan.holdersBuyQuote);
    if (amount === undefined)
      throw new Error(
        'Save the exact holder quote budget. A percentage cannot become quote spending.',
      );
    const [whole, fraction = ''] = amount.split('.');
    if (fraction.length > observation.quoteDecimals)
      throw new Error('Holder quote budget exceeds the observed precision.');
    total =
      BigInt(whole) * 10n ** BigInt(observation.quoteDecimals) +
      BigInt(fraction.padEnd(observation.quoteDecimals, '0'));
    if (total <= 0n || total > (1n << 64n) - 1n)
      throw new Error('Holder quote budget must be a positive u64 amount.');
  }
  const amounts = allocateHolderBaseUnits(plan, total);
  return {
    format: 'pump-holder-targets-v1' as const,
    executionAllowed: false as const,
    signingAllowed: false as const,
    simulationRequired: true as const,
    kind:
      unit === 'supply'
        ? ('exact-base-output' as const)
        : ('exact-quote-input' as const),
    quoteMint: observation.quoteMint,
    quoteDecimals: observation.quoteDecimals,
    totalRaw: total.toString(),
    holderCount: plan.holderCount,
    distribution: plan.holdersDistribution!,
    items: selection.recipients.map((wallet, index) => ({
      index,
      wallet,
      participates: amounts[index] > 0n,
      tokenAmountRaw: unit === 'supply' ? amounts[index].toString() : null,
      quoteAmountRaw: unit === 'quote' ? amounts[index].toString() : null,
      maximumQuoteCostRaw: unit === 'quote' ? amounts[index].toString() : null,
      minimumTokenOutputRaw: null,
      feeAndRentLimitRaw: null,
    })),
  };
}
