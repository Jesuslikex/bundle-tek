import {
  SNIPER_GUARD_FORMAT,
  SNIPER_GUARD_MAX_SECONDS,
  evaluateSniperGuard,
  parseSniperGuardSettings,
  validCurveBuy,
  type SniperGuardCurveBuy,
  type SniperGuardSettings,
} from './sniper-guard';

/**
 * Sniper Guard for LetsBonk, Surge, StonkFun and Meteora DBC launches. These
 * venues create the coin and the creator buy in one transaction, so there are
 * no staged holder buys to stop: the guard watches the pool's quote vault and,
 * when outside buys exceed the threshold, either alerts or offers a reviewed
 * sell of the developer wallet (Nuke).
 *
 * The guard runs in the open browser tab and keeps its state in local storage
 * so a reload resumes it. Bundle never signs for the user.
 */
export const VENUE_SNIPER_FORMAT = 'venue-sniper-guard-v1';
export const VENUE_SNIPER_STORED_BUYS = 1000;
export const VENUE_SNIPER_DEFAULT_SECONDS = 300;
export type VenueSniperVenue = 'launchlab' | 'stonkfun' | 'meteora-dbc';
export const isVenueSniperVenue = (v: unknown): v is VenueSniperVenue =>
  v === 'launchlab' || v === 'stonkfun' || v === 'meteora-dbc';
export type VenueSniperResponse = 'alert' | 'nuke';
export type VenueSniperStatus = 'watching' | 'triggered' | 'ended' | 'stopped';

/** Launch identity the server derives from the owned saved launch. */
export type VenueSniperLaunch = {
  venue: VenueSniperVenue;
  id: string;
  state: string;
  mint: string;
  pool: string;
  quoteVault: string;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  developer: string;
  developerRevision: number | null;
  /** Another saved wallet, required by Cleanup's later sweep step. */
  cleanupDestination: string | null;
  signature: string | null;
};

/** One read-only poll of outside buys, already stripped of the user's own wallets. */
export type VenueSniperRead = {
  buys: SniperGuardCurveBuy[];
  excludedCount: number;
  cursor: string | null;
  complete: boolean;
  pending: boolean;
};

export type VenueSniperState = {
  format: typeof VENUE_SNIPER_FORMAT;
  venue: VenueSniperVenue;
  id: string;
  mint: string;
  developer: string;
  settings: SniperGuardSettings;
  response: VenueSniperResponse;
  armedAt: number;
  status: VenueSniperStatus;
  finishedAt: number | null;
  cursor: string | null;
  buys: SniperGuardCurveBuy[];
  excludedCount: number;
  coverage: 'complete' | 'partial';
  externalTotalRaw: string;
  triggeringSignature: string | null;
};

const fail = (message: string): never => {
  throw new Error(message);
};

export const venueSniperStorageKey = (venue: VenueSniperVenue, id: string) =>
  `bundle:venue-sniper-guard:${venue}:${id}`;

/** The shared Sniper Guard settings shape: developer-only Nuke, timed end. */
export function venueSniperSettings(input: {
  thresholdRaw: string;
  seconds: number;
  whitelist: string[];
}): SniperGuardSettings {
  return parseSniperGuardSettings({
    format: SNIPER_GUARD_FORMAT,
    thresholdRaw: input.thresholdRaw,
    response: { kind: 'nuke', scope: 'dev', completeEarly: false },
    end: { kind: 'timed', seconds: input.seconds },
    whitelist: input.whitelist,
  });
}

export function armVenueSniper(
  launch: Pick<VenueSniperLaunch, 'venue' | 'id' | 'mint' | 'developer'>,
  settings: SniperGuardSettings,
  response: VenueSniperResponse,
  nowMs: number,
): VenueSniperState {
  if (
    settings.end.kind !== 'timed' ||
    settings.response.kind !== 'nuke' ||
    settings.response.scope !== 'dev'
  )
    fail('This launch supports a timed developer-only Sniper Guard.');
  if (response !== 'alert' && response !== 'nuke')
    fail('Choose Alert only or Nuke.');
  return {
    format: VENUE_SNIPER_FORMAT,
    venue: launch.venue,
    id: launch.id,
    mint: launch.mint,
    developer: launch.developer,
    settings,
    response,
    armedAt: nowMs,
    status: 'watching',
    finishedAt: null,
    cursor: null,
    buys: [],
    excludedCount: 0,
    coverage: 'complete',
    externalTotalRaw: '0',
    triggeringSignature: null,
  };
}

/** Folds one poll into the guard and re-evaluates every outside buy since arming. */
export function applyVenueSniperRead(
  state: VenueSniperState,
  read: VenueSniperRead,
  nowMs: number,
): VenueSniperState {
  if (state.status !== 'watching') return state;
  const known = new Set(state.buys.map((b) => b.signature));
  const fresh = read.buys.map(validCurveBuy).filter((b) => {
    if (known.has(b.signature)) return false;
    known.add(b.signature);
    return true;
  });
  const buys = [...state.buys, ...fresh];
  const overCapacity = buys.length > VENUE_SNIPER_STORED_BUYS;
  const evaluation = evaluateSniperGuard({
    settings: state.settings,
    launch: { developer: state.developer, holders: [] },
    ownedWallets: [],
    buys,
    armedAtMs: state.armedAt,
    nowMs,
    launchBuysComplete: false,
  });
  const status: VenueSniperStatus = evaluation.triggered
    ? 'triggered'
    : evaluation.ended || overCapacity
      ? 'ended'
      : 'watching';
  return {
    ...state,
    status,
    finishedAt: status === 'watching' ? null : nowMs,
    cursor: read.cursor,
    buys: buys.slice(-VENUE_SNIPER_STORED_BUYS),
    excludedCount: state.excludedCount + read.excludedCount,
    coverage:
      state.coverage === 'partial' ||
      overCapacity ||
      (!read.complete && !read.pending)
        ? 'partial'
        : 'complete',
    externalTotalRaw: evaluation.externalTotalRaw,
    triggeringSignature: evaluation.triggeringSignature,
  };
}

export function stopVenueSniper(
  state: VenueSniperState,
  nowMs: number,
): VenueSniperState {
  return state.status === 'watching'
    ? { ...state, status: 'stopped', finishedAt: nowMs }
    : state;
}

/** Reads saved browser state back, refusing anything that differs from this launch. */
export function parseVenueSniperState(
  text: string | null,
  expected: Pick<VenueSniperLaunch, 'venue' | 'id' | 'mint' | 'developer'>,
): VenueSniperState | null {
  if (!text) return null;
  const raw = JSON.parse(text) as VenueSniperState;
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.format !== VENUE_SNIPER_FORMAT ||
    raw.venue !== expected.venue ||
    raw.id !== expected.id ||
    raw.mint !== expected.mint ||
    raw.developer !== expected.developer ||
    !['watching', 'triggered', 'ended', 'stopped'].includes(raw.status) ||
    (raw.response !== 'alert' && raw.response !== 'nuke') ||
    !Number.isSafeInteger(raw.armedAt) ||
    (raw.finishedAt !== null && !Number.isSafeInteger(raw.finishedAt)) ||
    (raw.cursor !== null && typeof raw.cursor !== 'string') ||
    !Array.isArray(raw.buys) ||
    raw.buys.length > VENUE_SNIPER_STORED_BUYS ||
    !Number.isSafeInteger(raw.excludedCount) ||
    (raw.coverage !== 'complete' && raw.coverage !== 'partial')
  )
    return fail('Saved Sniper Guard state differs from this launch.');
  const settings = parseSniperGuardSettings(raw.settings);
  if (
    settings.end.kind !== 'timed' ||
    settings.end.seconds > SNIPER_GUARD_MAX_SECONDS
  )
    fail('Saved Sniper Guard state differs from this launch.');
  raw.buys.forEach(validCurveBuy);
  const evaluation = evaluateSniperGuard({
    settings,
    launch: { developer: raw.developer, holders: [] },
    ownedWallets: [],
    buys: raw.buys,
    armedAtMs: raw.armedAt,
    nowMs: raw.armedAt,
    launchBuysComplete: false,
  });
  return {
    ...raw,
    settings,
    externalTotalRaw: evaluation.externalTotalRaw,
    triggeringSignature: evaluation.triggeringSignature,
  };
}
