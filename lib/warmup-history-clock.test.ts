import { expect, it } from 'vitest';
import {
  isWarmupHistoryClockConflict,
  WARMUP_HISTORY_CLOCK_CODE,
  WARMUP_HISTORY_CLOCK_MESSAGE,
} from './warmup-history-clock';

it('admits only the exact static409clock-conflict reply, never arbitrary provider text', () => {
  const reply = {
    code: WARMUP_HISTORY_CLOCK_CODE,
    error: WARMUP_HISTORY_CLOCK_MESSAGE,
  };
  expect(isWarmupHistoryClockConflict(409, reply)).toBe(true);
  for (const status of [200, 401, 404, 429, 503])
    expect(isWarmupHistoryClockConflict(status, reply)).toBe(false);
  for (const body of [
    null,
    [],
    'HTML error',
    {},
    { ...reply, code: 'other' },
    { ...reply, error: 'untrusted provider text' },
    { ...reply, recoveryId: 'new-request' },
    { code: reply.code },
    { error: reply.error },
  ])
    expect(isWarmupHistoryClockConflict(409, body)).toBe(false);
});
