/** Sharing expiry changes read access only. It grants no wallet authority. */
export const SHARE_EXPIRY_OPTIONS = [
  { seconds: 3600, label: '1 hour' },
  { seconds: 86400, label: '24 hours' },
  { seconds: 604800, label: '7 days' },
] as const;

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('Invalid share timestamp.');
  return value;
}

/** Null denotes a legacy share whose access has no automatic expiry. */
export function readShareExpiry(value: unknown): string | null {
  return value === null ? null : canonicalTimestamp(value);
}

/** Only named durations may create a new share; omission defaults to 24 hours. */
export function shareExpiresAt(seconds: unknown, now: string): string {
  const duration =
    seconds === undefined ? SHARE_EXPIRY_OPTIONS[1].seconds : seconds;
  const selected = SHARE_EXPIRY_OPTIONS.find(
    (option) => option.seconds === duration,
  );
  if (!selected) throw new Error('Choose a supported sharing duration.');
  const current = Date.parse(canonicalTimestamp(now));
  const expires = current + selected.seconds * 1000;
  if (!Number.isSafeInteger(expires))
    throw new Error('Invalid share timestamp.');
  const date = new Date(expires);
  if (!Number.isFinite(date.getTime()))
    throw new Error('Invalid share timestamp.');
  return canonicalTimestamp(date.toISOString());
}
