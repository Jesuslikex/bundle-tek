/** Internal, non-enumerable diagnostics. Never include addresses, bytes, URLs or provider messages. */
export function pairReviewDiagnostic<T extends Error>(
  error: T,
  check: string,
  details: Record<string, number | boolean | string[]> = {},
): T {
  Object.defineProperty(error, 'pairDiagnostic', {
    value: Object.freeze({ check, ...details }),
  });
  return error;
}
