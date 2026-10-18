const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const ACCOUNT_LAUNCH_ACTIVITY_LIMIT = 8;

export type AccountLaunchActivityItem = {
  id: string;
  mint: string;
  state: string;
  createdAt: string;
  settlementState: string | null;
  settledAt: string | null;
};

export type AccountLaunchActivity = {
  observedAt: string;
  savedGroups: number;
  finalizedGroups: number;
  awaitingReview: number;
  finalizationEvidenceMissing: number;
  recent: AccountLaunchActivityItem[];
};

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function status(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
}

/** Validate the owner-scoped saved-review snapshot before rendering any totals. */
export function validatedAccountLaunchActivity(
  value: unknown,
): AccountLaunchActivity {
  const v = value as AccountLaunchActivity;
  if (
    !v ||
    !date(v.observedAt) ||
    !count(v.savedGroups) ||
    !count(v.finalizedGroups) ||
    !count(v.awaitingReview) ||
    !count(v.finalizationEvidenceMissing) ||
    !Array.isArray(v.recent) ||
    v.recent.length > ACCOUNT_LAUNCH_ACTIVITY_LIMIT ||
    v.finalizedGroups > v.savedGroups ||
    v.awaitingReview > v.savedGroups ||
    v.finalizationEvidenceMissing > v.savedGroups ||
    v.finalizedGroups + v.awaitingReview + v.finalizationEvidenceMissing >
      v.savedGroups ||
    v.recent.length !== Math.min(v.savedGroups, ACCOUNT_LAUNCH_ACTIVITY_LIMIT)
  )
    throw new Error('Launch activity is unavailable.');

  const ids = new Set<string>();
  let previous: AccountLaunchActivityItem | null = null;
  for (const item of v.recent) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !UUID.test(item.id) ||
      typeof item.mint !== 'string' ||
      !BASE58.test(item.mint) ||
      !status(item.state) ||
      !date(item.createdAt) ||
      (item.settlementState !== null && !status(item.settlementState)) ||
      (item.settledAt !== null && !date(item.settledAt)) ||
      (item.settlementState === null) !== (item.settledAt === null) ||
      (item.settledAt !== null && item.settledAt < item.createdAt) ||
      ids.has(item.id)
    )
      throw new Error('Launch activity record is invalid.');
    if (
      previous &&
      (item.createdAt > previous.createdAt ||
        (item.createdAt === previous.createdAt && item.id >= previous.id))
    )
      throw new Error('Launch activity ordering is invalid.');
    ids.add(item.id);
    previous = item;
  }
  const finalized = v.recent.filter(
    (item) =>
      item.state === 'finalized' && item.settlementState === 'finalized',
  ).length;
  const awaiting = v.recent.filter((item) => item.state === 'review').length;
  const missing = v.recent.filter(
    (item) =>
      item.state === 'finalized' && item.settlementState !== 'finalized',
  ).length;
  if (
    finalized > v.finalizedGroups ||
    awaiting > v.awaitingReview ||
    missing > v.finalizationEvidenceMissing
  )
    throw new Error('Launch activity counts do not match the recent records.');
  return v;
}
