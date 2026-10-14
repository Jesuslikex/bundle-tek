import { buildSavedPumpCreateComponent } from './pump-launch-preparation';
import {
  buildPumpCreateAndBuyMessage,
  type PumpCreateAndBuyInput,
} from './pump-initial-buy-message';
import { validateProjectDocument } from './workspace-project';

/** developerBuy is a percentage of total token supply, never a quote-token budget. */
export function pumpDeveloperBuyTarget(supplyRaw: string, percent: number) {
  if (
    typeof supplyRaw !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(supplyRaw) ||
    BigInt(supplyRaw) > (1n << 64n) - 1n
  )
    throw new Error('Read the exact Pump token supply.');
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
    throw new Error(
      'Save a positive developer supply percentage, or use create-only.',
    );
  const [mantissa, exponentText = '0'] = percent.toString().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const exponent = Number(exponentText) - fraction.length;
  const coefficient = BigInt(whole + fraction);
  const numerator =
    BigInt(supplyRaw) *
    coefficient *
    (exponent > 0 ? 10n ** BigInt(exponent) : 1n);
  const denominator = 100n * (exponent < 0 ? 10n ** BigInt(-exponent) : 1n);
  if (numerator % denominator !== 0n || numerator / denominator === 0n)
    throw new Error(
      'Developer supply percentage must resolve to whole base-token units.',
    );
  return (numerator / denominator).toString();
}

type Terms = Parameters<typeof buildSavedPumpCreateComponent>[2] & {
  maximumQuoteCostRaw: string;
  transactionVersion?: 0 | 1;
  lookupTables?: PumpCreateAndBuyInput['lookupTables'];
};

/** Server-internal component. An authenticated caller still needs owned-wallet proof and independent simulation before any signing review. */
export async function buildSavedPumpInitialBuyComponent(
  db: D1Database,
  owner: string,
  supplied: Terms,
) {
  const terms = structuredClone(supplied);
  if (
    Object.keys(terms).some(
      (key) =>
        ![
          'projectId',
          'updatedAt',
          'releaseId',
          'origin',
          'context',
          'maximumQuoteCostRaw',
          'transactionVersion',
          'lookupTables',
        ].includes(key),
    )
  )
    throw new Error(
      'Initial buy terms cannot override the saved supply target.',
    );
  const read = () =>
    db
      .prepare(
        'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, terms.projectId)
      .first<{ document: string; updated_at: string; archived: number }>();
  const original = await read();
  if (!original || original.archived || original.updated_at !== terms.updatedAt)
    throw new Error('Reload the owned active launch project.');
  const document = validateProjectDocument(JSON.parse(original.document));
  if (document.plan.scheduled)
    throw new Error(
      'Scheduled launch execution needs its own approval and lifetime handling.',
    );
  const {
    maximumQuoteCostRaw,
    transactionVersion,
    lookupTables,
    ...createTerms
  } = terms;
  const created = await buildSavedPumpCreateComponent(db, owner, createTerms);
  const tokenAmountRaw = pumpDeveloperBuyTarget(
    created.quote.tokenSupplyRaw,
    created.requestedDeveloperBuy,
  );
  const built = await buildPumpCreateAndBuyMessage({
    create: {
      ...terms.context,
      name: created.name,
      symbol: created.symbol,
      uri: created.metadataUri,
      quoteMint: created.quoteMint,
    },
    tokenAmountRaw,
    maximumQuoteCostRaw,
    transactionVersion,
    lookupTables,
  });
  const after = await read();
  if (!after || JSON.stringify(after) !== JSON.stringify(original))
    throw new Error('The saved launch changed while building the initial buy.');
  return {
    ...built,
    projectId: terms.projectId,
    projectUpdatedAt: original.updated_at,
    metadataReleaseId: terms.releaseId,
    developerSupplyPercent: created.requestedDeveloperBuy,
    requestedHoldersBuy: created.requestedHoldersBuy,
    requestedHoldersBuyQuote: created.requestedHoldersBuyQuote,
    containsHolderBuys: false as const,
    completeLaunch: false as const,
  };
}
