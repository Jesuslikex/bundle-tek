import { walletAddress } from './wallet-workspace';

/**
 * Sniper Guard settings and evaluation, modelled on Proxima's documented
 * behaviour (docs.proxima.tools/create-launch/funding/sniper-guard): external
 * buys are summed and the guard triggers only when the total is strictly
 * greater than the threshold.
 *
 * Bundle never signs for the user. A triggered guard only reports which
 * wallets to sell (Nuke) and whether remaining launch buys must stop
 * (Complete Early). Every sell still needs explicit review and local signing.
 */
export const SNIPER_GUARD_FORMAT = 'sniper-guard-settings-v1';
export const SNIPER_GUARD_WHITELIST_LIMIT = 50;
export const SNIPER_GUARD_MAX_SECONDS = 86_400;
export const SNIPER_GUARD_COUNTED_LIMIT = 200;
const U64_MAX = (1n << 64n) - 1n;

export type SniperGuardNukeScope = 'all' | 'holders' | 'dev';
export type SniperGuardResponse =
  | { kind: 'nuke'; scope: 'all' | 'holders' }
  | { kind: 'nuke'; scope: 'dev'; completeEarly: boolean }
  | { kind: 'complete-early' };
export type SniperGuardEnd =
  | { kind: 'until-complete' }
  | { kind: 'timed'; seconds: number };
export type SniperGuardSettings = {
  format: typeof SNIPER_GUARD_FORMAT;
  thresholdRaw: string;
  response: SniperGuardResponse;
  end: SniperGuardEnd;
  whitelist: string[];
};
export type SniperGuardLaunch = {
  mint: string;
  bondingCurve: string;
  quoteMint: string;
  quoteDecimals: number;
  quoteTokenProgram: string | null;
  developer: string;
  holders: string[];
};
/** One transaction that increased the bonding curve's quote reserve. */
export type SniperGuardCurveBuy = {
  signature: string;
  slot: number;
  blockTime: number | null;
  signers: string[];
  quoteInRaw: string;
};
export type SniperGuardActions = {
  sellWallets: string[];
  keepWallets: string[];
  stopRemainingBuys: boolean;
};
export type SniperGuardEvaluation = {
  externalTotalRaw: string;
  thresholdRaw: string;
  counted: SniperGuardCurveBuy[];
  countedOverflow: number;
  excludedCount: number;
  triggered: boolean;
  triggeringSignature: string | null;
  ended: boolean;
  endReason: 'launch-complete' | 'timed' | null;
  actions: SniperGuardActions | null;
};

const exact = (value: object, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const fail = (message: string): never => {
  throw new Error(message);
};

export function sniperGuardRaw(value: unknown, positive = true) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > U64_MAX ||
    (positive && BigInt(value) === 0n)
  )
    fail(
      positive
        ? 'Enter a Sniper Guard threshold greater than zero.'
        : 'Sniper Guard amount differs.',
    );
  return value as string;
}

/** Converts a decimal amount typed by the user into exact raw quote units. */
export function sniperGuardThresholdRaw(text: string, decimals: number) {
  const value = text.trim();
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^\d{1,20}(?:\.\d+)?$/.test(value)
  )
    fail('Enter the threshold as a plain number.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    fail(`Use at most ${decimals} decimal places for this currency.`);
  const raw = BigInt(whole + fraction.padEnd(decimals, '0')).toString();
  return sniperGuardRaw(raw);
}

export function sniperGuardDisplay(raw: string, decimals: number) {
  const digits = raw.padStart(decimals + 1, '0');
  if (!decimals) return digits;
  const whole = digits.slice(0, -decimals),
    fraction = digits.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function parseSniperGuardSettings(value: unknown): SniperGuardSettings {
  const raw = value as SniperGuardSettings;
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !exact(raw, ['format', 'thresholdRaw', 'response', 'end', 'whitelist']) ||
    raw.format !== SNIPER_GUARD_FORMAT
  )
    fail('Sniper Guard settings differ.');
  const thresholdRaw = sniperGuardRaw(raw.thresholdRaw);
  const response = raw.response as Record<string, unknown>;
  let parsedResponse: SniperGuardResponse;
  if (!response || typeof response !== 'object' || Array.isArray(response))
    return fail('Choose a Sniper Guard response.');
  if (response.kind === 'complete-early' && exact(response, ['kind']))
    parsedResponse = { kind: 'complete-early' };
  else if (
    response.kind === 'nuke' &&
    (response.scope === 'all' || response.scope === 'holders') &&
    exact(response, ['kind', 'scope'])
  )
    parsedResponse = { kind: 'nuke', scope: response.scope };
  else if (
    response.kind === 'nuke' &&
    response.scope === 'dev' &&
    typeof response.completeEarly === 'boolean' &&
    exact(response, ['kind', 'scope', 'completeEarly'])
  )
    parsedResponse = {
      kind: 'nuke',
      scope: 'dev',
      completeEarly: response.completeEarly,
    };
  else return fail('Choose a Sniper Guard response.');
  const end = raw.end as Record<string, unknown>;
  let parsedEnd: SniperGuardEnd;
  if (end?.kind === 'until-complete' && exact(end, ['kind']))
    parsedEnd = { kind: 'until-complete' };
  else if (
    end?.kind === 'timed' &&
    exact(end, ['kind', 'seconds']) &&
    Number.isSafeInteger(end.seconds) &&
    (end.seconds as number) >= 1 &&
    (end.seconds as number) <= SNIPER_GUARD_MAX_SECONDS
  )
    parsedEnd = { kind: 'timed', seconds: end.seconds as number };
  else
    return fail(
      `Choose Until complete or a timed end from 1 to ${SNIPER_GUARD_MAX_SECONDS} seconds.`,
    );
  if (
    !Array.isArray(raw.whitelist) ||
    raw.whitelist.length > SNIPER_GUARD_WHITELIST_LIMIT
  )
    fail(
      `A Sniper Guard whitelist holds up to ${SNIPER_GUARD_WHITELIST_LIMIT} addresses.`,
    );
  const whitelist = raw.whitelist.map((address) =>
    walletAddress(address, 'Solana'),
  );
  if (new Set(whitelist).size !== whitelist.length)
    fail('Remove duplicate whitelist addresses.');
  return {
    format: SNIPER_GUARD_FORMAT,
    thresholdRaw,
    response: parsedResponse,
    end: parsedEnd,
    whitelist,
  };
}

/** Which wallets a triggered guard asks the user to sell, and whether launch buys stop. */
export function sniperGuardActions(
  settings: SniperGuardSettings,
  launch: Pick<SniperGuardLaunch, 'developer' | 'holders'>,
): SniperGuardActions {
  const holders = launch.holders.filter((h) => h !== launch.developer);
  const everyone = [launch.developer, ...holders];
  const response = settings.response;
  if (response.kind === 'complete-early')
    return { sellWallets: [], keepWallets: everyone, stopRemainingBuys: true };
  if (response.scope === 'all')
    return { sellWallets: everyone, keepWallets: [], stopRemainingBuys: true };
  if (response.scope === 'holders')
    return {
      sellWallets: holders,
      keepWallets: [launch.developer],
      stopRemainingBuys: true,
    };
  return {
    sellWallets: [launch.developer],
    keepWallets: holders,
    stopRemainingBuys: response.scope === 'dev' && response.completeEarly,
  };
}

export function validCurveBuy(value: SniperGuardCurveBuy) {
  if (
    !value ||
    typeof value.signature !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.signature) ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < 0 ||
    (value.blockTime !== null &&
      (!Number.isSafeInteger(value.blockTime) || value.blockTime < 0)) ||
    !Array.isArray(value.signers) ||
    value.signers.length < 1 ||
    value.signers.length > 12
  )
    fail('Observed curve buy differs.');
  value.signers.forEach((s) => walletAddress(s, 'Solana'));
  sniperGuardRaw(value.quoteInRaw);
  return value;
}

/**
 * Pure evaluation over every curve buy observed since the guard was armed.
 * A buy is external unless one of its signers is a launch wallet, another
 * wallet the user owns, or a whitelisted address.
 */
export function evaluateSniperGuard(input: {
  settings: SniperGuardSettings;
  launch: Pick<SniperGuardLaunch, 'developer' | 'holders'>;
  ownedWallets: string[];
  buys: SniperGuardCurveBuy[];
  armedAtMs: number;
  nowMs: number;
  launchBuysComplete: boolean;
}): SniperGuardEvaluation {
  const { settings } = input;
  const excluded = new Set([
    input.launch.developer,
    ...input.launch.holders,
    ...input.ownedWallets,
    ...settings.whitelist,
  ]);
  const seen = new Set<string>();
  const ordered = input.buys
    .map(validCurveBuy)
    .filter((buy) => {
      if (seen.has(buy.signature)) return false;
      seen.add(buy.signature);
      return true;
    })
    .sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
  const threshold = BigInt(settings.thresholdRaw);
  let total = 0n,
    excludedCount = 0,
    triggeringSignature: string | null = null;
  const counted: SniperGuardCurveBuy[] = [];
  for (const buy of ordered) {
    if (buy.signers.some((s) => excluded.has(s))) {
      excludedCount++;
      continue;
    }
    counted.push(buy);
    total += BigInt(buy.quoteInRaw);
    if (!triggeringSignature && total > threshold)
      triggeringSignature = buy.signature;
  }
  const triggered = triggeringSignature !== null;
  let endReason: SniperGuardEvaluation['endReason'] = null;
  if (!triggered) {
    if (
      settings.end.kind === 'timed' &&
      input.nowMs >= input.armedAtMs + settings.end.seconds * 1000
    )
      endReason = 'timed';
    else if (settings.end.kind === 'until-complete' && input.launchBuysComplete)
      endReason = 'launch-complete';
  }
  return {
    externalTotalRaw: total.toString(),
    thresholdRaw: settings.thresholdRaw,
    counted: counted.slice(-SNIPER_GUARD_COUNTED_LIMIT),
    countedOverflow: Math.max(0, counted.length - SNIPER_GUARD_COUNTED_LIMIT),
    excludedCount,
    triggered,
    triggeringSignature,
    ended: endReason !== null,
    endReason,
    actions: triggered ? sniperGuardActions(settings, input.launch) : null,
  };
}
