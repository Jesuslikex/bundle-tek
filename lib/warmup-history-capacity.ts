export const WARMUP_MAX_WALLETS = 20;
export const WARMUP_MAX_CYCLES = 20;
export const WARMUP_MAX_PLAN_ACTIONS =
  WARMUP_MAX_WALLETS * WARMUP_MAX_CYCLES * 2;
// Retain five maximum-size buy/sell passes across revisions. Repreparations
// and partial sells use the same allowance; archiving never discards history.
export const WARMUP_HISTORY_LIMIT = WARMUP_MAX_PLAN_ACTIONS * 5;
