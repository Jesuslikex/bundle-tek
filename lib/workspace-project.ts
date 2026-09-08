import { validateLaunchPlan, type LaunchPlanInput } from './launch-plan';

export type TokenIdentity = {
  artworkUrl: string;
  website: string;
  twitter: string;
  telegram: string;
};
export type VenueOptions = {
  totalSupply: string;
  creatorTax: number;
  communityCoin: boolean;
  buyback: boolean;
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
};

export function validateProjectDocument(value: unknown): ProjectDocument {
  if (!value || typeof value !== 'object')
    throw new Error('Project must be an object.');
  const body = value as Record<string, unknown>;
  const plan = validateLaunchPlan(body.plan);
  const rawIdentity = body.identity as Record<string, unknown> | undefined;
  const identity = { ...EMPTY_IDENTITY };
  for (const key of Object.keys(identity) as (keyof TokenIdentity)[]) {
    const value = rawIdentity?.[key] ?? '';
    if (typeof value !== 'string' || value.length > 2048)
      throw new Error(`${key} must be a URL under 2048 characters.`);
    if (value) {
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
    },
  };
}

export function projectIdValid(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id);
}
