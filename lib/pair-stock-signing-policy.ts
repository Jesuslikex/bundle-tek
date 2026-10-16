/** Server-owned release gate. A request, acknowledgement or preview cannot enable signing. */
export function pairStockSigningPolicy(): {
  qualified: boolean;
  reason: string;
} {
  return {
    qualified: false,
    reason:
      'Stock signing is disabled pending complete live 32-slot runtime qualification, trusted program policy and application reservations.',
  };
}
