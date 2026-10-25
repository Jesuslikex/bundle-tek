import bs58 from 'bs58';
import {
  reviewedAutoSellConfiguration,
  type AutoSellConfiguration,
} from './auto-sell-edit';
import type { AutoSellStrategy, AutoSellTrigger } from './auto-sell';
import type { AutoSellSessionRules } from './auto-sell-session';

export const AUTO_SELL_PROFILE_MAX_BYTES = 262144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const U64_MAX = (1n << 64n) - 1n;
const invalid = () => Error('Auto Sell profile is invalid.');

export type AutoSellProfileTerms = {
  name: string;
  projectId: string;
  projectRevision: number;
  token: {
    chain: 'Solana';
    mint: string;
    decimals: number;
    totalSupplyRaw: string;
  };
  wallets: { address: string; revision: number }[];
  configuration: AutoSellConfiguration;
};

export type SavedAutoSellProfile = {
  format: 'auto-sell-profile-v1';
  id: string;
  profileId: string;
  version: number;
  createdAt: string;
  sha256: string;
  terms: AutoSellProfileTerms;
  signingAllowed: false;
  executionAllowed: false;
  automaticResumeAllowed: false;
};

/** Lean saved index metadata, not verified configuration or execution evidence. */
export type AutoSellProfileSummary = {
  id: string;
  profileId: string;
  version: number;
  name: string;
  projectRevision: number;
  createdAt: string;
  sha256: string;
  token: AutoSellProfileTerms['token'];
  walletCount: number;
  strategyCount: number;
};

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > required.length + optional.length ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      (!required.includes(key) && !optional.includes(key)) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    )
      throw invalid();
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, minimum: number, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw invalid();
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw invalid();
    copy.push(descriptor.value);
  }
  return copy;
}

function text(value: unknown, maximum: number, nonempty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (nonempty && (!value || value !== value.trim()))
  )
    throw invalid();
  return value;
}
function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}
export function autoSellProfileId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
}
function address(value: unknown): string {
  const result = text(value, 44, true);
  try {
    const bytes = bs58.decode(result);
    if (bytes.length === 32 && bs58.encode(bytes) === result) return result;
  } catch {
    /* Refuse invalid public addresses. */
  }
  throw invalid();
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}

function tokenIdentity(value: unknown): AutoSellProfileTerms['token'] {
  const token = record(value, ['chain', 'mint', 'decimals', 'totalSupplyRaw']);
  if (
    token.chain !== 'Solana' ||
    typeof token.totalSupplyRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(token.totalSupplyRaw) ||
    BigInt(token.totalSupplyRaw) > U64_MAX
  )
    throw invalid();
  return {
    chain: 'Solana',
    mint: address(token.mint),
    decimals: integer(token.decimals, 0, 255),
    totalSupplyRaw: token.totalSupplyRaw,
  };
}

export function requireAutoSellProfileSummary(
  value: unknown,
): AutoSellProfileSummary {
  const input = record(value, [
    'id',
    'profileId',
    'version',
    'name',
    'projectRevision',
    'createdAt',
    'sha256',
    'token',
    'walletCount',
    'strategyCount',
  ]);
  if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256))
    throw invalid();
  return {
    id: autoSellProfileId(input.id),
    profileId: autoSellProfileId(input.profileId),
    version: integer(input.version, 1),
    name: text(input.name, 80, true),
    projectRevision: integer(input.projectRevision, 1),
    createdAt: timestamp(input.createdAt),
    sha256: input.sha256,
    token: tokenIdentity(input.token),
    walletCount: integer(input.walletCount, 1, 500),
    strategyCount: integer(input.strategyCount, 1, 5),
  };
}

function trigger(value: unknown): AutoSellTrigger {
  // Read the discriminant only after checking every descriptor.
  const input = record(value, ['kind'], ['percent', 'amount']);
  if (input.kind === 'rate') {
    record(input, ['kind', 'percent']);
    return { kind: 'rate', percent: text(input.percent, 80) };
  }
  if (input.kind === 'min-sol' || input.kind === 'min-token') {
    record(input, ['kind', 'amount']);
    return { kind: input.kind, amount: text(input.amount, 80) };
  }
  throw invalid();
}

function strategy(value: unknown): AutoSellStrategy {
  const input = record(
    value,
    [
      'id',
      'name',
      'mode',
      'replicationPercent',
      'trigger',
      'minSupplyPercentPerSell',
      'marketCapMinUsd',
      'marketCapMaxUsd',
      'endMaxSupplyPercent',
      'endDurationSeconds',
      'whitelist',
      'amountUnit',
      'dcaRandomized',
      'dcaAmount',
      'dcaMinAmount',
      'dcaMaxAmount',
      'dcaIntervalSeconds',
      'limitOrders',
    ],
    ['endMaxTokenAmount'],
  );
  if (
    !['counter', 'dca', 'limit'].includes(input.mode as string) ||
    !['supply', 'tokens'].includes(input.amountUnit as string)
  )
    throw invalid();
  const whitelist = list(input.whitelist, 0, 1024).map(address);
  return {
    id: text(input.id, 128, true),
    name: text(input.name, 80),
    mode: input.mode as AutoSellStrategy['mode'],
    replicationPercent: text(input.replicationPercent, 80),
    trigger: trigger(input.trigger),
    minSupplyPercentPerSell: text(input.minSupplyPercentPerSell, 80),
    marketCapMinUsd: text(input.marketCapMinUsd, 80),
    marketCapMaxUsd: text(input.marketCapMaxUsd, 80),
    endMaxSupplyPercent: text(input.endMaxSupplyPercent, 80),
    ...(input.endMaxTokenAmount !== undefined
      ? { endMaxTokenAmount: text(input.endMaxTokenAmount, 80) }
      : {}),
    endDurationSeconds: integer(input.endDurationSeconds, 0, 30 * 86400),
    whitelist,
    amountUnit: input.amountUnit as AutoSellStrategy['amountUnit'],
    dcaRandomized: boolean(input.dcaRandomized),
    dcaAmount: text(input.dcaAmount, 80),
    dcaMinAmount: text(input.dcaMinAmount, 80),
    dcaMaxAmount: text(input.dcaMaxAmount, 80),
    dcaIntervalSeconds: integer(input.dcaIntervalSeconds, 0, 86400),
    limitOrders: list(input.limitOrders, 0, 10).map((value) => {
      const row = record(value, ['id', 'amount', 'marketCapUsd']);
      return {
        id: text(row.id, 128),
        amount: text(row.amount, 80),
        marketCapUsd: text(row.marketCapUsd, 80),
      };
    }),
  };
}
function session(value: unknown): AutoSellSessionRules {
  const input = record(
    value,
    ['startDelaySeconds', 'endDurationSeconds', 'endMaxSupplyPercent'],
    ['endMaxTokenAmount', 'maxSlippageBps'],
  );
  return {
    startDelaySeconds: integer(input.startDelaySeconds, 0, 86400),
    endDurationSeconds: integer(input.endDurationSeconds, 0, 86400),
    endMaxSupplyPercent: text(input.endMaxSupplyPercent, 80),
    ...(input.endMaxTokenAmount !== undefined
      ? { endMaxTokenAmount: text(input.endMaxTokenAmount, 80) }
      : {}),
    ...(input.maxSlippageBps !== undefined
      ? { maxSlippageBps: integer(input.maxSlippageBps, 1, 50) }
      : {}),
  };
}

/** An owned data-only projection, never a running session or approval. */
export function requireAutoSellProfileTerms(
  value: unknown,
): AutoSellProfileTerms {
  const input = record(value, [
    'name',
    'projectId',
    'projectRevision',
    'token',
    'wallets',
    'configuration',
  ]);
  const token = tokenIdentity(input.token);
  const configuration = record(input.configuration, ['strategies', 'session']);
  const wallets = list(input.wallets, 1, 500).map((value) => {
    const wallet = record(value, ['address', 'revision']);
    return {
      address: address(wallet.address),
      revision: integer(wallet.revision, 1),
    };
  });
  if (new Set(wallets.map((wallet) => wallet.address)).size !== wallets.length)
    throw invalid();
  const result: AutoSellProfileTerms = {
    name: text(input.name, 80, true),
    projectId: autoSellProfileId(input.projectId),
    projectRevision: integer(input.projectRevision, 1),
    token,
    wallets,
    configuration: reviewedAutoSellConfiguration({
      strategies: list(configuration.strategies, 1, 5).map(strategy),
      session: session(configuration.session),
    }),
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    AUTO_SELL_PROFILE_MAX_BYTES
  )
    throw Error('Auto Sell profile exceeds the 262144-byte capacity.');
  return result;
}
export function autoSellProfileTermsJson(value: unknown): string {
  return JSON.stringify(requireAutoSellProfileTerms(value));
}
export async function autoSellProfileSha256(text: string): Promise<string> {
  if (typeof text !== 'string') throw invalid();
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function readSavedAutoSellProfile(
  value: unknown,
): Promise<SavedAutoSellProfile> {
  const input = record(value, [
    'format',
    'id',
    'profileId',
    'version',
    'createdAt',
    'sha256',
    'terms',
    'signingAllowed',
    'executionAllowed',
    'automaticResumeAllowed',
  ]);
  if (
    input.format !== 'auto-sell-profile-v1' ||
    input.signingAllowed !== false ||
    input.executionAllowed !== false ||
    input.automaticResumeAllowed !== false ||
    typeof input.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  )
    throw invalid();
  const result: SavedAutoSellProfile = {
    format: 'auto-sell-profile-v1',
    id: autoSellProfileId(input.id),
    profileId: autoSellProfileId(input.profileId),
    version: integer(input.version, 1),
    createdAt: timestamp(input.createdAt),
    sha256: input.sha256,
    terms: requireAutoSellProfileTerms(input.terms),
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  };
  if (
    (await autoSellProfileSha256(JSON.stringify(result.terms))) !==
    result.sha256
  )
    throw Error('Auto Sell profile hash differs.');
  return result;
}
