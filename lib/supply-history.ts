import type { SupplyPartition } from './supply-partition';
import { supplyPartitionScope, type SupplyScope } from './supply-scope';
import { formatNativeBalance } from './wallet-balance-format';
import { percentOfSupply } from './supply-analysis';
export type SupplyAlert = {
  address: string;
  group: SupplyScope['wallets'][number]['group'];
  direction: 'increase' | 'decrease';
  raw: string;
  amount: string;
  previousRaw: string;
  currentRaw: string;
};
export type SupplyCapture = {
  format: 'supply-history-v1';
  projectRevision: number;
  snapshot: SupplyPartition;
  previousSequence: number | null;
  previousObservedAt: string | null;
  alerts: SupplyAlert[];
  supplyChangeRaw: string;
};
export type SupplyHistoryRow = {
  sequence: number;
  id: string;
  scopeId: string;
  document: SupplyCapture;
};
export function requireSupplyHistoryRow(
  input: unknown,
  scope: SupplyScope,
  scopeId: string,
): SupplyHistoryRow {
  const row = input as SupplyHistoryRow,
    d = row?.document;
  if (
    !row ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    typeof row.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(row.id) ||
    row.scopeId !== scopeId ||
    d?.format !== 'supply-history-v1' ||
    !Number.isSafeInteger(d.projectRevision) ||
    d.projectRevision < 1 ||
    !Array.isArray(d.alerts) ||
    d.alerts.length > scope.wallets.length
  )
    throw new Error('Invalid supply history capture.');
  const snapshot = requireSupplySnapshot(d.snapshot, scope);
  if (d.previousSequence === null) {
    if (
      d.previousObservedAt !== null ||
      d.alerts.length ||
      d.supplyChangeRaw !== '0'
    )
      throw new Error('Invalid supply baseline.');
  } else if (
    !Number.isSafeInteger(d.previousSequence) ||
    d.previousSequence < 1 ||
    d.previousSequence >= row.sequence ||
    typeof d.previousObservedAt !== 'string' ||
    !Number.isFinite(Date.parse(d.previousObservedAt)) ||
    Date.parse(d.previousObservedAt) >= Date.parse(snapshot.observedAt)
  )
    throw new Error('Invalid supply comparison interval.');
  if (
    typeof d.supplyChangeRaw !== 'string' ||
    !/^(-?[1-9]\d{0,19}|0)$/.test(d.supplyChangeRaw)
  )
    throw new Error('Invalid supply change.');
  const seen = new Set<string>();
  for (const alert of d.alerts) {
    const wallet = snapshot.wallets.find((w) => w.address === alert.address);
    if (
      !wallet ||
      seen.has(alert.address) ||
      wallet.group !== alert.group ||
      wallet.raw !== alert.currentRaw ||
      !['increase', 'decrease'].includes(alert.direction)
    )
      throw new Error('Alert wallet scope differs.');
    seen.add(alert.address);
    const diff = raw(alert.currentRaw) - raw(alert.previousRaw),
      amount = raw(alert.raw);
    if (
      amount === 0n ||
      (alert.direction === 'increase' ? diff : -diff) !== amount ||
      alert.amount !== formatNativeBalance(amount.toString(), snapshot.decimals)
    )
      throw new Error('Alert units differ.');
  }
  return row;
}
export function canonicalSupplyScope(input: unknown) {
  const scope = supplyPartitionScope(input);
  return {
    ...scope,
    wallets: scope.wallets.toSorted((a, b) =>
      a.address.localeCompare(b.address),
    ),
  };
}
export async function supplyScopeId(scope: SupplyScope) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonicalSupplyScope(scope))),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
function raw(v: unknown) {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new Error('Invalid saved supply units.');
  return BigInt(v);
}
export function requireSupplySnapshot(
  value: unknown,
  scope: SupplyScope,
): SupplyPartition {
  const s = value as SupplyPartition;
  if (
    !s ||
    s.mint !== scope.mint ||
    !Number.isInteger(s.decimals) ||
    s.decimals < 0 ||
    s.decimals > 255 ||
    s.commitment !== 'confirmed' ||
    !Number.isSafeInteger(s.minSlot) ||
    s.minSlot < 0 ||
    !Number.isSafeInteger(s.maxSlot) ||
    s.maxSlot < s.minSlot ||
    s.maxSlot - s.minSlot > 32 ||
    !Number.isFinite(Date.parse(s.observedAt)) ||
    typeof s.source !== 'string' ||
    !/^[a-zA-Z0-9.-]{1,253}$/.test(s.source) ||
    !Array.isArray(s.wallets) ||
    s.wallets.length !== scope.wallets.length
  )
    throw new Error('Supply snapshot context differs.');
  const total = raw(s.totalSupplyRaw),
    totals = { team: 0n, external: 0n, pool: 0n };
  if (
    !total ||
    s.totalSupply !== formatNativeBalance(total.toString(), s.decimals)
  )
    throw new Error('Invalid saved supply total.');
  s.wallets.forEach((w, i) => {
    const expected = scope.wallets[i];
    if (
      w.address !== expected.address ||
      w.group !== expected.group ||
      !Number.isSafeInteger(w.slot) ||
      w.slot < s.minSlot ||
      w.slot > s.maxSlot
    )
      throw new Error('Supply wallet scope differs.');
    const units = raw(w.raw);
    if (
      w.amount !== formatNativeBalance(w.raw, s.decimals) ||
      w.supplyPercent !== percentOfSupply(units, total)
    )
      throw new Error('Supply wallet amount differs.');
    totals[w.group] += units;
  });
  const remaining = total - totals.team - totals.external - totals.pool;
  if (remaining < 0n) throw new Error('Supply partition exceeds total.');
  for (const [group, units] of Object.entries({
    ...totals,
    unclassified: remaining,
    outsideTeam: total - totals.team,
  })) {
    const part = s.parts?.[group as keyof typeof s.parts];
    if (
      !part ||
      part.raw !== units.toString() ||
      part.amount !== formatNativeBalance(units.toString(), s.decimals) ||
      part.supplyPercent !== percentOfSupply(units, total)
    )
      throw new Error('Saved supply partition differs.');
  }
  return s;
}
export function captureSupply(
  snapshot: SupplyPartition,
  scope: SupplyScope,
  revision: number,
  previous: SupplyHistoryRow | null,
): SupplyCapture {
  requireSupplySnapshot(snapshot, scope);
  const before = previous
    ? requireSupplySnapshot(previous.document.snapshot, scope)
    : null;
  if (
    before &&
    (before.decimals !== snapshot.decimals ||
      snapshot.minSlot <= before.maxSlot ||
      Date.parse(snapshot.observedAt) <= Date.parse(before.observedAt))
  )
    throw new Error('Supply observations overlap or are out of order.');
  const alerts: SupplyAlert[] = before
    ? snapshot.wallets.flatMap((w, i) => {
        const old = before.wallets[i],
          delta = BigInt(w.raw) - BigInt(old.raw);
        if (!delta) return [];
        const units = (delta < 0n ? -delta : delta).toString();
        return [
          {
            address: w.address,
            group: w.group,
            direction:
              delta < 0n ? ('decrease' as const) : ('increase' as const),
            raw: units,
            amount: formatNativeBalance(units, snapshot.decimals),
            previousRaw: old.raw,
            currentRaw: w.raw,
          },
        ];
      })
    : [];
  return {
    format: 'supply-history-v1',
    projectRevision: revision,
    snapshot,
    previousSequence: previous?.sequence ?? null,
    previousObservedAt: before?.observedAt ?? null,
    alerts,
    supplyChangeRaw: before
      ? (
          BigInt(snapshot.totalSupplyRaw) - BigInt(before.totalSupplyRaw)
        ).toString()
      : '0',
  };
}
