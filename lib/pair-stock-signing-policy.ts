import { env } from './server-env';

/**
 * Server-owned release gate. Only the exact server value `true` qualifies; a
 * request, acknowledgement or preview cannot enable signing. Even when this
 * returns qualified, approval still requires the fresh runtime recheck, the
 * pinned trusted-program policy and an atomic application reservation.
 */
export function pairStockSigningPolicy(
  source: Record<string, string | undefined> = env,
): {
  qualified: boolean;
  reason: string;
} {
  let value: string | undefined;
  try {
    value = source.SOLANA_STOCK_SIGNING_ENABLED;
  } catch {
    value = undefined;
  }
  if (value === 'true')
    return {
      qualified: true,
      reason:
        'Stock signing is enabled by the server; every approval still requires fresh runtime, trusted program and reservation checks.',
    };
  return {
    qualified: false,
    reason:
      'Stock signing is disabled pending complete live 32-slot runtime qualification, trusted program policy and application reservations.',
  };
}
