'use client';

import { durationText } from '@/lib/bubble-map-estimate';

// Captured volume-run progress card: a started timestamp, a countdown, a
// progress bar, and — once the scheduled end passes — the exact overrun line
// "Taking longer than usual...". The reference drives it from loop_amount and a
// per-transaction delay; here the caller supplies the planned window instead.
export function VolumeRunProgress({
  startedAt,
  endsAt,
  now,
}: {
  startedAt: number;
  /** Planned finish, or null when the run has no planned end. */
  endsAt: number | null;
  now: number;
}) {
  const total = endsAt === null ? 0 : Math.max(0, endsAt - startedAt);
  const elapsed = Math.max(0, now - startedAt);
  const overrun = endsAt !== null && elapsed > total;
  const percent = total > 0 ? Math.min((elapsed / total) * 100, 100) : 0;

  return (
    <div className="volume-run-progress">
      <div className="volume-run-head">
        <p>Started: {new Date(startedAt).toLocaleTimeString()}</p>
        {endsAt === null ? null : overrun ? (
          <p>Taking longer than usual...</p>
        ) : (
          <p>Time Left: {durationText(Math.max(0, total - elapsed))}</p>
        )}
      </div>
      <progress
        className="volume-run-bar"
        aria-label="Volume run progress"
        max={100}
        value={Math.round(percent)}
      />
    </div>
  );
}
