import { validateProjectDocument, projectIdValid } from './workspace-project';
import { readBoundedPanelJson } from './read-bounded-panel-json';
import type { LaunchPlanInput } from './launch-plan';
import { readShareExpiry } from './project-share-expiry';

const unavailable = () =>
  Error('Shared projects unavailable. Try again later.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw unavailable();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw unavailable();
  }
  return value as Record<string, unknown>;
}
export type SharedProjectSnapshot = {
  id: string;
  shareId: string;
  readOnly: true;
  archived: boolean;
  updatedAt: string;
  expiresAt?: string | null;
  plan: LaunchPlanInput;
  artworkSaved: boolean;
  totalSupply: string;
  creatorTax: number;
  communityCoin: boolean;
  buyback: boolean;
  assignedRecipients: number;
  deployerAssigned: boolean;
  walletSelectionMatchesPlan: boolean;
  pumpSettings: {
    creatorFeePercent: string | null;
    holderRewards: boolean;
    offchainCreation: boolean;
    feeSharing: boolean;
    feeShareLegCount: number;
  };
};

/** Display-only snapshots. Private wallet references and external artwork URLs
 * are deliberately not retained in this client projection. No permissions,
 * funded balances, launch receipts or execution authority are inferred. */
export function decodeSharedProjectSnapshots(
  value: unknown,
): SharedProjectSnapshot[] {
  try {
    const page = record(value);
    if (
      Object.keys(page).join(',') !== 'projects' ||
      !Array.isArray(page.projects) ||
      page.projects.length > 100
    )
      throw unavailable();
    const seen = new Set<string>();
    return page.projects.map((input: unknown) => {
      const row = record(input);
      if (
        ![
          'archived,id,identity,options,plan,readOnly,shareId,updatedAt',
          'archived,expiresAt,id,identity,options,plan,readOnly,shareId,updatedAt',
        ].includes(Object.keys(row).sort().join(',')) ||
        !projectIdValid(row.id) ||
        typeof row.shareId !== 'string' ||
        !uuid.test(row.shareId) ||
        seen.has(row.shareId) ||
        row.readOnly !== true ||
        typeof row.archived !== 'boolean' ||
        typeof row.updatedAt !== 'string' ||
        row.updatedAt.length !== 24 ||
        !Number.isFinite(Date.parse(row.updatedAt)) ||
        new Date(row.updatedAt).toISOString() !== row.updatedAt
      )
        throw unavailable();
      const planInput = record(row.plan);
      for (const key of [
        'developerBuy',
        'holdersBuy',
        'holderCount',
        'routingEmphasis',
      ])
        if (typeof planInput[key] !== 'number') throw unavailable();
      record(row.identity);
      record(row.options);
      const document = validateProjectDocument(row);
      seen.add(row.shareId);
      return {
        id: row.id,
        shareId: row.shareId,
        readOnly: true,
        archived: row.archived,
        updatedAt: row.updatedAt,
        ...(Object.hasOwn(row, 'expiresAt')
          ? { expiresAt: readShareExpiry(row.expiresAt) }
          : {}),
        plan: document.plan,
        artworkSaved: document.identity.artworkUrl !== '',
        totalSupply: document.options.totalSupply,
        creatorTax: document.options.creatorTax,
        communityCoin: document.options.communityCoin,
        buyback: document.options.buyback,
        assignedRecipients: document.options.wallets?.recipients.length ?? 0,
        deployerAssigned: document.options.wallets?.deployer !== undefined,
        walletSelectionMatchesPlan:
          !document.options.wallets ||
          (document.options.wallets.chain === document.plan.chain &&
            document.options.wallets.recipients.length <=
              document.plan.holderCount),
        pumpSettings: {
          creatorFeePercent:
            document.options.settings.pumpfun.creatorFeePercent ?? null,
          holderRewards: document.options.settings.pumpfun.holderRewards,
          offchainCreation: document.options.settings.pumpfun.offchainCreation,
          feeSharing: document.options.settings.pumpfun.feeSharing,
          feeShareLegCount: document.options.settings.pumpfun.feeShares.length,
        },
      };
    });
  } catch {
    throw unavailable();
  }
}
export async function readSharedProjectSnapshots(
  response: Response,
  signal = AbortSignal.timeout(15000),
): Promise<SharedProjectSnapshot[]> {
  if (!response.ok)
    throw Error(
      response.status === 401
        ? 'Sign in to open shared projects.'
        : unavailable().message,
    );
  try {
    return decodeSharedProjectSnapshots(
      await readBoundedPanelJson(response, signal),
    );
  } catch {
    throw unavailable();
  }
}
