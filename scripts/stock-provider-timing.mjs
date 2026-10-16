// Observation only. No network access, quote mutation or acceptance policy.
const phases = ['initial-quote', 'wallet-bound-order', 'fresh-quote'];
export async function measureStockProvider(
  events,
  phase,
  run,
  now = () => performance.now(),
) {
  if (!Array.isArray(events) || phases[events.length] !== phase)
    throw Error('Unexpected stock provider timing sequence.');
  const event = { phase, startMs: now(), endMs: null, outcome: 'pending' };
  events.push(event);
  try {
    const result = await run();
    event.outcome = 'returned';
    return result;
  } catch (error) {
    event.outcome = 'refused';
    throw error;
  } finally {
    event.endMs = now();
  }
}

export function stockQuoteGaps(events) {
  if (events === undefined)
    return {
      measured: false,
      reason: 'Historical receipt has no full-response timing.',
    };
  if (!Array.isArray(events) || events.length > 3)
    throw Error('Invalid stock provider timing evidence.');
  for (const [i, event] of events.entries()) {
    if (
      event.phase !== phases[i] ||
      !Number.isFinite(event.startMs) ||
      event.startMs < 0 ||
      !Number.isFinite(event.endMs) ||
      event.endMs < event.startMs ||
      !['returned', 'refused'].includes(event.outcome) ||
      (i > 0 &&
        (events[i - 1].outcome !== 'returned' ||
          event.startMs < events[i - 1].endMs))
    )
      throw Error(
        'Incomplete, reordered or invalid stock provider timing evidence.',
      );
  }
  const [initial, order, fresh] = events;
  return {
    measured: true,
    reached: events.length,
    initialQuoteDurationMs: initial ? initial.endMs - initial.startMs : null,
    initialQuoteToOrderDispatchMs: order ? order.startMs - initial.endMs : null,
    initialQuoteToOrderCompletionMs: order ? order.endMs - initial.endMs : null,
    orderDurationMs: order ? order.endMs - order.startMs : null,
    orderToFreshQuoteDispatchMs: fresh ? fresh.startMs - order.endMs : null,
    freshQuoteDurationMs: fresh ? fresh.endMs - fresh.startMs : null,
    orderToFreshQuoteCompletionMs: fresh ? fresh.endMs - order.endMs : null,
  };
}
