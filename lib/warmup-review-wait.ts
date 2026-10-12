// This only schedules the review button. The authenticated server read gate
// remains authoritative, including when another tab makes a wallet read.
export function warmupReviewDeadline(waitMs: unknown, now = Date.now()) {
  if (
    typeof waitMs !== 'number' ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 15000 ||
    !Number.isSafeInteger(now)
  )
    throw new Error('Approval review timing unavailable. Prepare again.');
  return now + waitMs;
}
