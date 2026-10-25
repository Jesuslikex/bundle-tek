import type { LaunchChain } from './launch-plan';
import type { ProjectDocument } from './workspace-project';
import {
  assignmentEntries,
  parseLaunchWalletAssignments,
} from './launch-wallets';
import { walletAddress, walletChain, walletRevision } from './wallet-workspace';

export const PROJECT_SHARE_SCOPE_MAX_WALLETS = 201;

/** Disclosure of a saved assignment reference only, never wallet authority. */
export type ProjectShareWallet = {
  chain: LaunchChain;
  address: string;
  revision: number;
  role: 'Deployer' | 'Recipient';
};
export type ProjectShareScope = {
  format: 'project-share-wallet-scope-v1';
  projectRevision: string;
  wallets: ProjectShareWallet[];
};

const invalid = () => Error('Project share scope is invalid.');

function record(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !property?.enumerable ||
      !Object.hasOwn(property, 'value')
    )
      throw invalid();
  }
  return value as Record<string, unknown>;
}

function list(value: unknown) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > PROJECT_SHARE_SCOPE_MAX_WALLETS ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw invalid();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property?.enumerable || !Object.hasOwn(property, 'value'))
      throw invalid();
    result.push(property.value);
  }
  return result;
}

function readWallet(value: unknown): ProjectShareWallet {
  const row = record(value, ['chain', 'address', 'revision', 'role']);
  const chain = walletChain(row.chain);
  const address = walletAddress(row.address, chain);
  if (
    address !== row.address ||
    (row.role !== 'Deployer' && row.role !== 'Recipient')
  )
    throw invalid();
  return {
    chain,
    address,
    revision: walletRevision(row.revision),
    role: row.role as ProjectShareWallet['role'],
  };
}

function walletKey(wallet: ProjectShareWallet) {
  return `${wallet.chain}:${wallet.address}`;
}

/** A detached, closed representation. NULL legacy scopes belong to the caller. */
export function readProjectShareScope(value: unknown): ProjectShareScope {
  try {
    const row = record(value, ['format', 'projectRevision', 'wallets']);
    if (
      row.format !== 'project-share-wallet-scope-v1' ||
      typeof row.projectRevision !== 'string' ||
      row.projectRevision.length !== 24 ||
      !Number.isFinite(Date.parse(row.projectRevision)) ||
      new Date(row.projectRevision).toISOString() !== row.projectRevision
    )
      throw invalid();
    const wallets = list(row.wallets).map(readWallet);
    if (new Set(wallets.map(walletKey)).size !== wallets.length)
      throw invalid();
    return {
      format: 'project-share-wallet-scope-v1',
      projectRevision: row.projectRevision,
      wallets,
    };
  } catch {
    throw invalid();
  }
}

/** Current saved assignment candidates, excluding every folder/private field. */
export function shareAssignmentCandidates(
  document: ProjectDocument,
): ProjectShareWallet[] {
  try {
    const selection = parseLaunchWalletAssignments(document.options.wallets);
    if (!selection) return [];
    const entries = assignmentEntries(selection);
    if (entries.length === 0) return [];
    // A saved project may retain old-chain assignments while its plan changes.
    // They are unavailable for this plan, not a reason to block revocation.
    if (selection.chain !== document.plan.chain) return [];
    return entries.map((entry) =>
      readWallet({
        chain: selection.chain,
        address: entry.address,
        revision: entry.revision,
        role: entry.role,
      }),
    );
  } catch {
    throw invalid();
  }
}

/** No future assignments or changed revisions/roles can enter an existing scope. */
export function resolveProjectShareScope(
  scope: ProjectShareScope,
  document: ProjectDocument,
) {
  const admitted = readProjectShareScope(scope);
  const current = new Map(
    shareAssignmentCandidates(document).map((wallet) => [
      walletKey(wallet),
      wallet,
    ]),
  );
  const wallets = admitted.wallets.filter((wallet) => {
    const candidate = current.get(walletKey(wallet));
    return (
      candidate?.revision === wallet.revision && candidate.role === wallet.role
    );
  });
  return {
    wallets,
    unavailableCount: admitted.wallets.length - wallets.length,
  };
}
