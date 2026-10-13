import { UUID } from './wallet-operation';
import { marketUsdMicros } from './market-trigger';
import { walletAddress } from './wallet-workspace';
export type MonitorMatch = {
  orderId: string;
  revision: number;
  side: 'Buy' | 'Sell';
  pair: string;
  direction: 'at-or-above' | 'at-or-below';
  observedMarketCapUsd: string;
  levels: { level: number; targetUsd: string; unitsRaw: string }[];
};
export type MonitorNotice = {
  id: string;
  projectId: string;
  projectRevision: number;
  monitorRevision: number;
  observedAt: string;
  expiresAt: string;
  source: 'api.dexscreener.com';
  checkedOrders: number;
  unavailableOrders: number;
  matches: MonitorMatch[];
  executionAllowed: false;
};
export type ConditionalMonitorPage = {
  projectId: string;
  executionAllowed: false;
  workerLastSeenAt: number | null;
  monitor: {
    revision: number;
    projectRevision: number;
    enabled: boolean;
    nextCheckAt: number;
    lastCheckedAt: number | null;
    error: string | null;
  } | null;
  notices: MonitorNotice[];
};
export const monitorErrors = [
  'rate-limited',
  'provider-unavailable',
  'pool-unavailable',
  'storage-unavailable',
  'context-changed',
  'no-current-orders',
] as const;
const uint = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export function decodeMonitorNotice(
  value: unknown,
  projectId: string,
): MonitorNotice {
  const n = value as MonitorNotice;
  if (
    !n ||
    Object.keys(n).sort().join(',') !==
      'checkedOrders,executionAllowed,expiresAt,id,matches,monitorRevision,observedAt,projectId,projectRevision,source,unavailableOrders' ||
    !UUID.test(n.id) ||
    n.projectId !== projectId ||
    !UUID.test(projectId) ||
    !uint(n.projectRevision) ||
    n.projectRevision < 1 ||
    !uint(n.monitorRevision) ||
    n.monitorRevision < 1 ||
    !date(n.observedAt) ||
    !date(n.expiresAt) ||
    Date.parse(n.expiresAt) !== Date.parse(n.observedAt) + 30000 ||
    n.source !== 'api.dexscreener.com' ||
    n.executionAllowed !== false ||
    !uint(n.checkedOrders) ||
    n.checkedOrders > 100 ||
    !uint(n.unavailableOrders) ||
    n.unavailableOrders > n.checkedOrders ||
    !Array.isArray(n.matches) ||
    n.matches.length < 1 ||
    n.matches.length > n.checkedOrders
  )
    throw new Error('Conditional notice differs.');
  const seen = new Set<string>();
  for (const m of n.matches) {
    if (
      !m ||
      Object.keys(m).sort().join(',') !==
        'direction,levels,observedMarketCapUsd,orderId,pair,revision,side' ||
      !UUID.test(m.orderId) ||
      seen.has(m.orderId) ||
      !uint(m.revision) ||
      m.revision < 1 ||
      !['Buy', 'Sell'].includes(m.side) ||
      !['at-or-above', 'at-or-below'].includes(m.direction) ||
      !Array.isArray(m.levels) ||
      m.levels.length < 1 ||
      m.levels.length > 50
    )
      throw new Error('Conditional notice order differs.');
    seen.add(m.orderId);
    walletAddress(m.pair, 'Solana');
    marketUsdMicros(m.observedMarketCapUsd);
    const levels = new Set<number>();
    for (const l of m.levels) {
      if (
        !l ||
        Object.keys(l).sort().join(',') !== 'level,targetUsd,unitsRaw' ||
        !Number.isInteger(l.level) ||
        l.level < 1 ||
        l.level > 50 ||
        levels.has(l.level) ||
        typeof l.unitsRaw !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(l.unitsRaw) ||
        BigInt(l.unitsRaw) > (1n << 64n) - 1n
      )
        throw new Error('Conditional notice level differs.');
      levels.add(l.level);
      const target = marketUsdMicros(l.targetUsd),
        current = marketUsdMicros(m.observedMarketCapUsd);
      if (m.direction === 'at-or-above' ? current < target : current > target)
        throw new Error('Conditional notice condition is not met.');
    }
  }
  return n;
}
export function decodeConditionalMonitorPage(
  value: unknown,
  projectId: string,
): ConditionalMonitorPage {
  const p = value as ConditionalMonitorPage,
    m = p?.monitor;
  if (
    !p ||
    p.projectId !== projectId ||
    !UUID.test(projectId) ||
    p.executionAllowed !== false ||
    (p.workerLastSeenAt !== null && !uint(p.workerLastSeenAt)) ||
    !Array.isArray(p.notices) ||
    p.notices.length > 10 ||
    (m !== null &&
      (!m ||
        !uint(m.revision) ||
        m.revision < 1 ||
        !uint(m.projectRevision) ||
        m.projectRevision < 1 ||
        typeof m.enabled !== 'boolean' ||
        !uint(m.nextCheckAt) ||
        (m.lastCheckedAt !== null && !uint(m.lastCheckedAt)) ||
        (m.error !== null &&
          !monitorErrors.includes(m.error as (typeof monitorErrors)[number]))))
  )
    throw new Error('Conditional monitoring status differs.');
  p.notices.forEach((n) => decodeMonitorNotice(n, projectId));
  if (new Set(p.notices.map((n) => n.id)).size !== p.notices.length)
    throw new Error('Duplicate conditional notices.');
  return p;
}
