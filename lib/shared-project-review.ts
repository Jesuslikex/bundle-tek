import {
  validateProjectDocument,
  projectIdValid,
  type ProjectDocument,
} from './workspace-project';
import { readBoundedPanelJson } from './read-bounded-panel-json';
import { validateLaunchPlan, type LaunchPlanInput } from './launch-plan';
import { readShareExpiry } from './project-share-expiry';
import { parsePumpCreatorFee, pumpCreatorFeeEligible } from './venue-settings';
import {
  readProjectShareScope,
  resolveProjectShareScope,
  shareAssignmentCandidates,
  type ProjectShareScope,
  type ProjectShareWallet,
} from './project-share-scope';

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
  format?: 'shared-project-scoped-v1';
  walletScope?: SharedProjectWalletScope;
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

export type SharedProjectWalletScope = {
  mode: 'none' | 'selected' | 'legacy';
  wallets: ProjectShareWallet[];
  unavailableCount: number;
};
export type ScopedSharedProjectSnapshot = SharedProjectSnapshot & {
  format: 'shared-project-scoped-v1';
  expiresAt: string | null;
  walletScope: SharedProjectWalletScope;
};
export type SharedProjectSnapshotMetadata = {
  id: string;
  shareId: string;
  archived: boolean;
  updatedAt: string;
  expiresAt?: string | null;
};

function exact(value: unknown, keys: readonly string[]) {
  const row = record(value);
  if (Object.keys(row).sort().join(',') !== [...keys].sort().join(','))
    throw unavailable();
  return row;
}
function metadata(row: Record<string, unknown>) {
  if (
    !projectIdValid(row.id) ||
    typeof row.shareId !== 'string' ||
    !uuid.test(row.shareId) ||
    row.readOnly !== true ||
    typeof row.archived !== 'boolean' ||
    typeof row.updatedAt !== 'string' ||
    row.updatedAt.length !== 24 ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    new Date(row.updatedAt).toISOString() !== row.updatedAt
  )
    throw unavailable();
  return {
    id: row.id,
    shareId: row.shareId,
    readOnly: true as const,
    archived: row.archived,
    updatedAt: row.updatedAt,
    ...(Object.hasOwn(row, 'expiresAt')
      ? { expiresAt: readShareExpiry(row.expiresAt) }
      : {}),
  };
}

/** Copies only JSON values, rejecting getters, custom prototypes and sparse arrays
 * before the existing validators can read them. */
function jsonCopy(value: unknown, depth = 0): unknown {
  if (depth > 12) throw unavailable();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 4096) throw unavailable();
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 201 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw unavailable();
    return Array.from({ length: value.length }, (_, i) => {
      const entry = Object.getOwnPropertyDescriptor(value, String(i));
      if (!entry?.enumerable || !Object.hasOwn(entry, 'value'))
        throw unavailable();
      return jsonCopy(entry.value, depth + 1);
    });
  }
  const row = record(value);
  if (Object.keys(row).length > 32) throw unavailable();
  return Object.fromEntries(
    Object.keys(row)
      .sort()
      .map((key) => [key, jsonCopy(row[key], depth + 1)]),
  );
}
function canonicalPlan(value: unknown): LaunchPlanInput {
  const detached = jsonCopy(value);
  const result = validateLaunchPlan(detached);
  if (JSON.stringify(jsonCopy(result)) !== JSON.stringify(detached))
    throw unavailable();
  return result;
}

function scopedSnapshot(value: unknown): ScopedSharedProjectSnapshot {
  const row = exact(value, [
    'format',
    'id',
    'shareId',
    'readOnly',
    'archived',
    'updatedAt',
    'expiresAt',
    'plan',
    'artworkSaved',
    'totalSupply',
    'creatorTax',
    'communityCoin',
    'buyback',
    'assignedRecipients',
    'deployerAssigned',
    'walletSelectionMatchesPlan',
    'pumpSettings',
    'walletScope',
  ]);
  if (row.format !== 'shared-project-scoped-v1') throw unavailable();
  const meta = metadata(row);
  const plan = canonicalPlan(row.plan);
  if (
    typeof row.totalSupply !== 'string' ||
    !/^[1-9]\d{0,29}$/.test(row.totalSupply) ||
    typeof row.creatorTax !== 'number' ||
    !Number.isFinite(row.creatorTax) ||
    row.creatorTax < 0 ||
    row.creatorTax > 10 ||
    !Number.isSafeInteger(row.assignedRecipients) ||
    Number(row.assignedRecipients) < 0 ||
    Number(row.assignedRecipients) > 200 ||
    [
      'artworkSaved',
      'communityCoin',
      'buyback',
      'deployerAssigned',
      'walletSelectionMatchesPlan',
    ].some((key) => typeof row[key] !== 'boolean')
  )
    throw unavailable();
  const pump = exact(row.pumpSettings, [
    'creatorFeePercent',
    'holderRewards',
    'offchainCreation',
    'feeSharing',
    'feeShareLegCount',
  ]);
  if (
    ['holderRewards', 'offchainCreation', 'feeSharing'].some(
      (key) => typeof pump[key] !== 'boolean',
    ) ||
    !Number.isSafeInteger(pump.feeShareLegCount) ||
    Number(pump.feeShareLegCount) < 0 ||
    Number(pump.feeShareLegCount) > 10 ||
    (pump.feeSharing
      ? Number(pump.feeShareLegCount) === 0
      : pump.feeShareLegCount !== 0) ||
    (pump.holderRewards && (pump.offchainCreation || pump.feeSharing)) ||
    ((plan.chain !== 'Solana' || plan.launchpad !== 'PumpFun') &&
      (pump.holderRewards || pump.offchainCreation || pump.feeSharing)) ||
    (pump.creatorFeePercent !== null &&
      (typeof pump.creatorFeePercent !== 'string' ||
        parsePumpCreatorFee(pump.creatorFeePercent) !==
          pump.creatorFeePercent ||
        !pumpCreatorFeeEligible(plan)))
  )
    throw unavailable();
  const scope = exact(row.walletScope, ['mode', 'wallets', 'unavailableCount']);
  if (
    !['none', 'selected', 'legacy'].includes(scope.mode as string) ||
    !Number.isSafeInteger(scope.unavailableCount) ||
    Number(scope.unavailableCount) < 0 ||
    Number(scope.unavailableCount) > 201
  )
    throw unavailable();
  const wallets = readProjectShareScope({
    format: 'project-share-wallet-scope-v1',
    projectRevision: meta.updatedAt,
    wallets: scope.wallets,
  }).wallets;
  const selectedCount = wallets.length + Number(scope.unavailableCount);
  if (
    wallets.some((wallet) => wallet.chain !== plan.chain) ||
    selectedCount > 201 ||
    (scope.mode === 'none' && selectedCount !== 0) ||
    (scope.mode === 'selected' && selectedCount === 0) ||
    (scope.mode === 'legacy' && scope.unavailableCount !== 0) ||
    wallets.filter((wallet) => wallet.role === 'Recipient').length >
      Number(row.assignedRecipients) ||
    wallets.filter((wallet) => wallet.role === 'Deployer').length > 1 ||
    (wallets.some((wallet) => wallet.role === 'Deployer') &&
      row.deployerAssigned !== true) ||
    (scope.mode === 'legacy' &&
      (row.walletSelectionMatchesPlan === true || wallets.length > 0) &&
      (wallets.filter((wallet) => wallet.role === 'Recipient').length !==
        row.assignedRecipients ||
        wallets.some((wallet) => wallet.role === 'Deployer') !==
          row.deployerAssigned))
  )
    throw unavailable();
  return {
    ...meta,
    format: 'shared-project-scoped-v1',
    expiresAt: readShareExpiry(row.expiresAt),
    plan,
    artworkSaved: row.artworkSaved as boolean,
    totalSupply: row.totalSupply,
    creatorTax: row.creatorTax,
    communityCoin: row.communityCoin as boolean,
    buyback: row.buyback as boolean,
    assignedRecipients: Number(row.assignedRecipients),
    deployerAssigned: row.deployerAssigned as boolean,
    walletSelectionMatchesPlan: row.walletSelectionMatchesPlan as boolean,
    pumpSettings: {
      creatorFeePercent: pump.creatorFeePercent as string | null,
      holderRewards: pump.holderRewards as boolean,
      offchainCreation: pump.offchainCreation as boolean,
      feeSharing: pump.feeSharing as boolean,
      feeShareLegCount: Number(pump.feeShareLegCount),
    },
    walletScope: {
      mode: scope.mode as SharedProjectWalletScope['mode'],
      wallets,
      unavailableCount: Number(scope.unavailableCount),
    },
  };
}

function legacySnapshot(row: Record<string, unknown>): SharedProjectSnapshot {
  if (
    ![
      'archived,id,identity,options,plan,readOnly,shareId,updatedAt',
      'archived,expiresAt,id,identity,options,plan,readOnly,shareId,updatedAt',
    ].includes(Object.keys(row).sort().join(','))
  )
    throw unavailable();
  const meta = metadata(row);
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
  return {
    ...meta,
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
}

/** Server projection: never return the raw document to a share member. Scope
 * carries display access only and never grants signing or execution authority. */
export function createScopedSharedProjectSnapshot(
  meta: SharedProjectSnapshotMetadata,
  document: ProjectDocument,
  scope: ProjectShareScope | null,
): ScopedSharedProjectSnapshot {
  try {
    const admittedMeta = exact(meta, [
      'id',
      'shareId',
      'archived',
      'updatedAt',
      ...(Object.hasOwn(meta, 'expiresAt') ? ['expiresAt'] : []),
    ]);
    const validated = validateProjectDocument(jsonCopy(document));
    const summary = legacySnapshot(
      record({ ...validated, ...admittedMeta, readOnly: true }),
    );
    const resolved =
      scope === null
        ? { wallets: shareAssignmentCandidates(validated), unavailableCount: 0 }
        : resolveProjectShareScope(scope, validated);
    return scopedSnapshot({
      ...summary,
      format: 'shared-project-scoped-v1',
      expiresAt: meta.expiresAt ?? null,
      walletScope: {
        mode:
          scope === null
            ? 'legacy'
            : scope.wallets.length === 0
              ? 'none'
              : 'selected',
        ...resolved,
      },
    });
  } catch {
    throw unavailable();
  }
}

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
      const result = Object.hasOwn(row, 'format')
        ? scopedSnapshot(row)
        : legacySnapshot(row);
      if (seen.has(result.shareId)) throw unavailable();
      seen.add(result.shareId);
      return result;
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
