import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
export type TradeSessionTerms = {
  format:
    | 'imported-trade-session-v1'
    | 'imported-trade-session-v2'
    | 'imported-trade-session-v3';
  strategy?: 'DCA';
  schedule?: TradeSessionSchedule;
  projectId: string;
  projectRevision: number;
  mint: string;
  decimals: number;
  side: 'Buy' | 'Sell';
  totalRaw: string;
  entries: {
    entry: number;
    wallet: string;
    walletRevision: number;
    unitsRaw: string;
    amount: string;
  }[];
};
export type TradeSession = {
  id: string;
  revision: number;
  state: 'active' | 'cancelled';
  terms: TradeSessionTerms;
  createdAt: string;
  updatedAt: string;
};
export type TradeSessionRequest = {
  sessionId: string;
  revision: number;
  entry: number;
};
export type TradeSessionCapture = {
  format: 'trade-session-entry-v1' | 'trade-session-entry-v2';
  notBefore?: string;
  sessionId: string;
  sessionRevision: number;
  entry: number;
  termsSha256: string;
  unitsRaw: string;
};
export type TradeSessionActivity = {
  sessionId: string;
  entry: number;
  intentId: string;
  state: string;
  signature: string | null;
  receiptId: string | null;
};
export function validatedTradeSessionActivity(
  value: unknown,
  sessions: TradeSession[],
): TradeSessionActivity[] {
  if (!Array.isArray(value) || value.length > 200)
    throw new Error('Session activity unavailable.');
  const seen = new Set<string>();
  for (const a of value as TradeSessionActivity[]) {
    if (
      !a ||
      !UUID.test(a.intentId) ||
      seen.has(a.intentId) ||
      !sessions.some(
        (s) =>
          s.id === a.sessionId &&
          s.terms.entries.some((e) => e.entry === a.entry),
      ) ||
      ![
        'awaiting_signature',
        'signed',
        'submitted',
        'failed',
        'cancelled',
        'finalized',
      ].includes(a.state) ||
      (a.state === 'awaiting_signature' || a.state === 'cancelled'
        ? a.signature !== null
        : typeof a.signature !== 'string' ||
          !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(a.signature)) ||
      (a.state === 'finalized'
        ? !a.receiptId || !UUID.test(a.receiptId)
        : a.receiptId !== null)
    )
      throw new Error('Session activity context differs.');
    seen.add(a.intentId);
  }
  return value;
}
const revision = (n: unknown) =>
  Number.isSafeInteger(n) && Number(n) > 0 && Number(n) < 1e9;
export function tradeSessionRequest(value: unknown): TradeSessionRequest {
  const v = value as TradeSessionRequest;
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'entry,revision,sessionId' ||
    !UUID.test(v.sessionId) ||
    !revision(v.revision) ||
    !Number.isInteger(v.entry) ||
    v.entry < 1 ||
    v.entry > 25
  )
    throw new Error('Choose a current trade session entry.');
  return v;
}
export function tradeSessionTerms(
  value: unknown,
  token: { chain: string; address: string; decimals: number },
): TradeSessionTerms {
  const v = value as {
    projectId: string;
    projectRevision: number;
    side: 'Buy' | 'Sell';
    entries: { wallet: string; walletRevision: number; amount: string }[];
    schedule?: unknown;
    strategy?: unknown;
  };
  if (
    !v ||
    token.chain !== 'Solana' ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255 ||
    !UUID.test(v.projectId) ||
    !revision(v.projectRevision) ||
    !['Buy', 'Sell'].includes(v.side) ||
    !Array.isArray(v.entries) ||
    v.entries.length < 1 ||
    v.entries.length > 25
  )
    throw new Error(
      'Choose 1 to 25 distinct Solana wallets and exact amounts.',
    );
  const dca = v.strategy === 'DCA';
  if (v.strategy !== undefined && !dca)
    throw new Error('Choose a supported session strategy.');
  const schedule =
    v.schedule === undefined ? undefined : tradeSessionSchedule(v.schedule);
  if (dca && (!schedule || schedule.spacingSeconds < 1 || v.entries.length < 2))
    throw new Error('DCA needs 2 to 25 cycles and a positive saved interval.');
  const seen = new Set<string>();
  const decimals = v.side === 'Buy' ? 9 : token.decimals;
  const entries = v.entries.map((e, i) => {
    const wallet = walletAddress(e.wallet, 'Solana');
    if ((!dca && seen.has(wallet)) || !revision(e.walletRevision))
      throw new Error('Distinct current wallet revisions required.');
    seen.add(wallet);
    const raw = solanaTokenAtoms(e.amount, decimals);
    return {
      entry: i + 1,
      wallet,
      walletRevision: e.walletRevision,
      unitsRaw: raw.toString(),
      amount: formatNativeBalance(raw.toString(), decimals),
    };
  });
  if (dca) {
    const first = entries[0],
      total = entries.reduce((sum, e) => sum + BigInt(e.unitsRaw), 0n);
    if (
      total > 18446744073709551615n ||
      entries.some(
        (e) =>
          e.wallet !== first.wallet ||
          e.walletRevision !== first.walletRevision ||
          BigInt(e.unitsRaw) !==
            total / BigInt(entries.length) +
              (BigInt(e.entry - 1) < total % BigInt(entries.length) ? 1n : 0n),
      )
    )
      throw new Error(
        'DCA must conserve an evenly split exact budget for one current wallet.',
      );
  }
  if (schedule) sessionEntryNotBefore({ schedule }, entries.length);
  return {
    format: dca
      ? 'imported-trade-session-v3'
      : schedule
        ? 'imported-trade-session-v2'
        : 'imported-trade-session-v1',
    ...(dca ? { strategy: 'DCA' as const } : {}),
    projectId: v.projectId,
    projectRevision: v.projectRevision,
    mint: walletAddress(token.address, 'Solana'),
    decimals: token.decimals,
    side: v.side,
    totalRaw: entries
      .reduce((sum, e) => sum + BigInt(e.unitsRaw), 0n)
      .toString(),
    entries,
    ...(schedule ? { schedule } : {}),
  };
}
export function decodeTradeSession(value: unknown): TradeSession {
  const v = value as TradeSession;
  if (
    !v ||
    !UUID.test(v.id) ||
    !['active', 'cancelled'].includes(v.state) ||
    v.revision !== (v.state === 'active' ? 1 : 2) ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    !Number.isFinite(Date.parse(v.updatedAt)) ||
    Date.parse(v.updatedAt) < Date.parse(v.createdAt) ||
    ![
      'imported-trade-session-v1',
      'imported-trade-session-v2',
      'imported-trade-session-v3',
    ].includes(v.terms?.format)
  )
    throw new Error('Trade session history differs.');
  const terms = tradeSessionTerms(v.terms, {
    chain: 'Solana',
    address: v.terms.mint,
    decimals: v.terms.decimals,
  });
  if (JSON.stringify(terms) !== JSON.stringify(v.terms))
    throw new Error('Trade session terms differ.');
  return { ...v, terms };
}
export function validatedTradeSessionCapture(
  value: unknown,
  unitsRaw: string,
): TradeSessionCapture {
  const v = value as TradeSessionCapture;
  if (
    !v ||
    Object.keys(v).sort().join(',') !==
      (v.notBefore === undefined
        ? 'entry,format,sessionId,sessionRevision,termsSha256,unitsRaw'
        : 'entry,format,notBefore,sessionId,sessionRevision,termsSha256,unitsRaw') ||
    v.format !==
      (v.notBefore === undefined
        ? 'trade-session-entry-v1'
        : 'trade-session-entry-v2') ||
    (v.notBefore !== undefined && !canonicalScheduleDate(v.notBefore)) ||
    !UUID.test(v.sessionId) ||
    !revision(v.sessionRevision) ||
    v.entry < 1 ||
    v.entry > 25 ||
    !Number.isInteger(v.entry) ||
    !/^[a-f0-9]{64}$/.test(v.termsSha256) ||
    v.unitsRaw !== unitsRaw ||
    !/^[1-9]\d{0,19}$/.test(v.unitsRaw) ||
    BigInt(v.unitsRaw) > 18446744073709551615n
  )
    throw new Error('Trade session capture differs.');
  return v;
}

export type TradeSessionSchedule = { startAt: string; spacingSeconds: number };
function canonicalScheduleDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
export function tradeSessionSchedule(value: unknown): TradeSessionSchedule {
  const v = value as TradeSessionSchedule;
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'spacingSeconds,startAt' ||
    !canonicalScheduleDate(v.startAt) ||
    !Number.isSafeInteger(v.spacingSeconds) ||
    v.spacingSeconds < 0 ||
    v.spacingSeconds > 86400
  )
    throw new Error(
      'Choose an exact UTC start and 0 to 86400 seconds between wallets.',
    );
  return { startAt: v.startAt, spacingSeconds: v.spacingSeconds };
}
export function sessionEntryNotBefore(
  terms: Pick<TradeSessionTerms, 'schedule'>,
  entry: number,
): string | undefined {
  if (!Number.isInteger(entry) || entry < 1 || entry > 25)
    throw new Error('Choose a saved session entry.');
  if (!terms.schedule) return undefined;
  const schedule = tradeSessionSchedule(terms.schedule),
    due = new Date(
      Date.parse(schedule.startAt) +
        (entry - 1) * schedule.spacingSeconds * 1000,
    ).toISOString();
  if (!canonicalScheduleDate(due))
    throw new Error('Session schedule exceeds supported dates.');
  return due;
}
export function requireSessionEntryDue(
  capture: TradeSessionCapture,
  now = Date.now(),
) {
  validatedTradeSessionCapture(capture, capture.unitsRaw);
  if (
    !Number.isFinite(now) ||
    (capture.notBefore && Date.parse(capture.notBefore) > now)
  )
    throw new Error('Trade session entry is not due yet.');
}

export type TradeSessionControl = {
  sessionId: string;
  projectId: string;
  state: 'ready' | 'paused';
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export function decodeTradeSessionControl(value: unknown): TradeSessionControl {
  const v = value as TradeSessionControl;
  if (
    !v ||
    !UUID.test(v.sessionId) ||
    !UUID.test(v.projectId) ||
    !['ready', 'paused'].includes(v.state) ||
    Number(v.revision) % 2 !== (v.state === 'ready' ? 1 : 0) ||
    !revision(v.revision) ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    !Number.isFinite(Date.parse(v.updatedAt)) ||
    Date.parse(v.updatedAt) < Date.parse(v.createdAt)
  )
    throw new Error('Trade session control differs.');
  return v;
}
export function validatedTradeSessionControls(
  value: unknown,
  sessions: TradeSession[],
): TradeSessionControl[] {
  if (
    !Array.isArray(value) ||
    value.length !== sessions.length ||
    value.length > 100
  )
    throw new Error('Trade session controls unavailable.');
  const controls = value.map(decodeTradeSessionControl);
  if (
    new Set(controls.map((c) => c.sessionId)).size !== controls.length ||
    controls.some(
      (c) =>
        !sessions.some(
          (s) => s.id === c.sessionId && s.terms.projectId === c.projectId,
        ),
    )
  )
    throw new Error('Trade session control context differs.');
  return controls;
}
