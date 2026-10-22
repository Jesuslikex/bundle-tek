/** Static metadata only. Clock disagreement never renews an authorization. */
export const WARMUP_HISTORY_CLOCK_CODE = 'WARMUP_HISTORY_CLOCK_AHEAD';
export const WARMUP_HISTORY_CLOCK_MESSAGE =
  'Saved history is ahead of this server clock. Recover the same ID shortly.';
export const WARMUP_HISTORY_CLOCK_RECOVERY =
  'Saved history is ahead of this server clock and has not been fully verified. No deadline is renewed and no retry starts automatically.';

export function isWarmupHistoryClockConflict(status: number, value: unknown) {
  if (
    status !== 409 ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).sort().join(',') === 'code,error' &&
    body.code === WARMUP_HISTORY_CLOCK_CODE &&
    body.error === WARMUP_HISTORY_CLOCK_MESSAGE
  );
}
