import { validateProjectDocument } from './workspace-project';
import { artworkIdValid } from './artwork';
import { verifyReleasedLaunchIdentity } from './released-launch-identity';
import { quoteCatalog, validateQuoteSelection } from './quote-catalog';
import {
  buildPumpCreateMessage,
  type PumpCreateInput,
} from './pump-launch-message';

type Context = Omit<PumpCreateInput, 'name' | 'symbol' | 'uri' | 'quoteMint'>;
type Terms = {
  projectId: string;
  updatedAt: string;
  releaseId: string;
  origin: string;
  context: Context;
};
type Row = {
  document: string;
  updated_at: string;
  archived: number;
  source_document: string;
  metadata: string;
  image: number[];
  mime: string;
};

// Server-internal create component. The caller must collect mainnet RPC context;
// this is not an authenticated HTTP API, a signing review or a full launch bundle.
export async function buildSavedPumpCreateComponent(
  db: D1Database,
  owner: string,
  terms: Terms,
) {
  const t = structuredClone(terms);
  const url = new URL(t.origin);
  if (
    url.origin !== t.origin ||
    url.protocol !== 'https:' ||
    !artworkIdValid(t.releaseId)
  )
    throw new Error('Review a released HTTPS metadata identity.');
  const allowed = [
    'payer',
    'mint',
    'blockhash',
    'lastValidBlockHeight',
    'global',
    'quoteMintAccount',
    'quoteControl',
  ];
  if (Object.keys(t.context).some((key) => !allowed.includes(key)))
    throw new Error(
      'Launch context cannot override saved metadata or quote identity.',
    );
  const read = () =>
    db
      .prepare(`SELECT p.document,p.updated_at,p.archived,m.source_document,m.metadata,m.image,m.mime
    FROM workspace_projects p JOIN launch_metadata_releases m ON m.owner_id=p.owner_id AND m.project_id=p.id
    WHERE p.owner_id=? AND p.id=? AND m.id=?`)
      .bind(owner, t.projectId, t.releaseId)
      .first<Row>();
  const row = await read();
  if (!row || row.archived || row.updated_at !== t.updatedAt)
    throw new Error(
      'Reload the owned active project and its released metadata.',
    );
  const current = validateProjectDocument(JSON.parse(row.document));
  const plan = current.plan;
  if (plan.chain !== 'Solana' || plan.launchpad !== 'PumpFun')
    throw new Error(
      'StonkFun and other venues require their own verified create adapter.',
    );
  const settings = current.options.settings.pumpfun;
  // Generic creatorTax/communityCoin/buyback controls belong to the Robinhood
  // pons.family/hood.fun form, not Pump's creator-fee configuration.
  if (
    settings.holderRewards ||
    settings.offchainCreation ||
    settings.feeSharing ||
    settings.feeShares.length ||
    (settings.creatorFeePercent && Number(settings.creatorFeePercent) !== 0)
  )
    throw new Error(
      'Saved launch options require additional reviewed create instructions.',
    );
  const { uri } = await verifyReleasedLaunchIdentity(
    current,
    row,
    t.origin,
    t.releaseId,
  );
  validateQuoteSelection(plan);
  const catalog = quoteCatalog(plan.chain, plan.launchpad);
  const quotes = catalog.assets.filter(
    (a) =>
      a.symbol === plan.currency &&
      (!plan.quoteAddress || a.address === plan.quoteAddress),
  );
  if (quotes.length !== 1)
    throw new Error('Choose one exact quote mint before preparing creation.');
  const result = await buildPumpCreateMessage({
    ...t.context,
    name: plan.tokenName,
    symbol: plan.ticker,
    uri,
    quoteMint: quotes[0].address,
  });
  if (
    BigInt(current.options.totalSupply) * 1000000n !==
    BigInt(result.quote.tokenSupplyRaw)
  )
    throw new Error(
      'Saved supply differs from the Pump program configuration.',
    );
  if (result.quote.decimals !== quotes[0].decimals)
    throw new Error('Quote precision changed from the saved asset profile.');
  const after = await read();
  if (
    !after ||
    after.archived ||
    after.updated_at !== row.updated_at ||
    after.document !== row.document ||
    after.metadata !== row.metadata
  )
    throw new Error(
      'The saved launch changed during preparation. Review it again.',
    );
  return {
    ...result,
    projectId: t.projectId,
    projectUpdatedAt: row.updated_at,
    metadataReleaseId: t.releaseId,
    requestedDeveloperBuy: plan.developerBuy,
    requestedHoldersBuy: plan.holdersBuy,
    requestedHoldersBuyQuote: plan.holdersBuyQuote ?? null,
    completeLaunch: false as const,
  };
}
