import { validateLaunchPlan, type LaunchPlanInput } from './launch-plan';
import { validateTokenSource, type TokenSource } from './token-source';
import { isUploadedArtwork } from './artwork';
import {
  validateCloneMetadataProof,
  type CloneMetadataProof,
} from './token-linked-metadata';
import {
  parseLaunchWalletAssignments,
  type LaunchWalletAssignments,
} from './launch-wallets';
import {
  DEFAULT_VENUE_SETTINGS,
  validateVenueSettings,
  type VenueSettings,
} from './venue-settings';

export type TokenIdentity = {
  artworkUrl: string;
  website: string;
  twitter: string;
  telegram: string;
  clonedFrom?: TokenSource;
  clonedMetadata?: CloneMetadataProof;
};
export type VenueOptions = {
  totalSupply: string;
  creatorTax: number;
  communityCoin: boolean;
  buyback: boolean;
  settings: VenueSettings;
  wallets?: LaunchWalletAssignments;
};
export type ProjectDocument = {
  plan: LaunchPlanInput;
  identity: TokenIdentity;
  options: VenueOptions;
};
export type WorkspaceProject = ProjectDocument & {
  id: string;
  archived: boolean;
  updatedAt: string;
};
export type ProjectEvent = {
  id: number;
  projectId: string;
  name: string;
  chain: string;
  launchpad: string;
  type: string;
  changes: string[];
  revision: string;
  createdAt: string;
};
export function projectChanges(
  before: ProjectDocument | null,
  after: ProjectDocument,
) {
  if (!before) return [];
  const changes: string[] = [];
  for (const field of [
    'tokenName',
    'ticker',
    'description',
    'chain',
    'launchpad',
    'currency',
    'quoteAddress',
  ] as const)
    if (before.plan[field] !== after.plan[field])
      changes.push(
        {
          tokenName: 'name',
          ticker: 'symbol',
          description: 'description',
          chain: 'network',
          launchpad: 'launchpad',
          currency: 'quote currency',
          quoteAddress: 'quote token',
        }[field],
      );
  if (before.identity.artworkUrl !== after.identity.artworkUrl)
    changes.push('artwork');
  if (
    ['website', 'twitter', 'telegram'].some(
      (field) =>
        before.identity[field as 'website'] !==
        after.identity[field as 'website'],
    )
  )
    changes.push('social links');
  if (
    JSON.stringify(before.identity.clonedFrom) !==
    JSON.stringify(after.identity.clonedFrom)
  )
    changes.push('clone reference');
  if (
    JSON.stringify(before.identity.clonedMetadata) !==
    JSON.stringify(after.identity.clonedMetadata)
  )
    changes.push('cloned metadata source');
  if (JSON.stringify(before.options) !== JSON.stringify(after.options))
    changes.push('venue options');
  const {
    tokenName: _name,
    ticker: _ticker,
    description: _desc,
    chain: _chain,
    launchpad: _venue,
    currency: _currency,
    quoteAddress: _quote,
    ...beforeSettings
  } = before.plan;
  const {
    tokenName: _name2,
    ticker: _ticker2,
    description: _desc2,
    chain: _chain2,
    launchpad: _venue2,
    currency: _currency2,
    quoteAddress: _quote2,
    ...afterSettings
  } = after.plan;
  if (JSON.stringify(beforeSettings) !== JSON.stringify(afterSettings))
    changes.push('launch settings');
  return changes;
}
export const EMPTY_IDENTITY: TokenIdentity = {
  artworkUrl: '',
  website: '',
  twitter: '',
  telegram: '',
};
export const DEFAULT_VENUE_OPTIONS: VenueOptions = {
  totalSupply: '1000000000',
  creatorTax: 1,
  communityCoin: false,
  buyback: false,
  settings: DEFAULT_VENUE_SETTINGS,
};

export function validateProjectDocument(value: unknown): ProjectDocument {
  if (!value || typeof value !== 'object')
    throw new Error('Project must be an object.');
  const body = value as Record<string, unknown>;
  const plan = validateLaunchPlan(body.plan);
  const rawIdentity = body.identity as Record<string, unknown> | undefined;
  const identity = { ...EMPTY_IDENTITY };
  for (const key of ['artworkUrl', 'website', 'twitter', 'telegram'] as const) {
    const value = rawIdentity?.[key] ?? '';
    if (typeof value !== 'string' || value.length > 2048)
      throw new Error(`${key} must be a URL under 2048 characters.`);
    if (value) {
      if (key === 'artworkUrl' && isUploadedArtwork(value)) {
        identity[key] = value;
        continue;
      }
      const url = new URL(value);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(`${key} must be a public HTTP or HTTPS URL.`);
    }
    identity[key] = value;
  }
  if (rawIdentity?.clonedFrom !== undefined)
    identity.clonedFrom = validateTokenSource(rawIdentity.clonedFrom);
  if (rawIdentity?.clonedMetadata !== undefined) {
    if (identity.clonedFrom?.chain !== 'Solana')
      throw new Error('Linked metadata requires a Solana clone source.');
    identity.clonedMetadata = validateCloneMetadataProof(
      rawIdentity.clonedMetadata,
    );
  }
  const raw = body.options as Record<string, unknown> | undefined;
  const options = { ...DEFAULT_VENUE_OPTIONS, ...raw };
  if (
    typeof options.totalSupply !== 'string' ||
    !/^[1-9][0-9]{0,29}$/.test(options.totalSupply)
  )
    throw new Error(
      'Supply must be a positive whole number of at most 30 digits.',
    );
  if (
    typeof options.creatorTax !== 'number' ||
    !Number.isFinite(options.creatorTax) ||
    options.creatorTax < 0 ||
    options.creatorTax > 10
  )
    throw new Error('Creator tax must be 0–10%.');
  if (
    typeof options.communityCoin !== 'boolean' ||
    typeof options.buyback !== 'boolean'
  )
    throw new Error('Invalid venue options.');
  return {
    plan,
    identity,
    options: {
      totalSupply: options.totalSupply,
      creatorTax: options.creatorTax,
      communityCoin: options.communityCoin,
      buyback: options.buyback,
      settings: validateVenueSettings(
        raw?.settings,
        plan.chain,
        plan.launchpad,
        plan.quoteAddress,
      ),
      ...(raw?.wallets !== undefined
        ? { wallets: parseLaunchWalletAssignments(raw.wallets) }
        : {}),
    },
  };
}

export function projectIdValid(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id);
}
