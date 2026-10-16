export type PairDiagnosticComparison = {
  field: string;
  before: string;
  after: string;
};
export type PairDiagnosticDetails = Record<
  string,
  number | boolean | string | string[] | PairDiagnosticComparison[]
>;
/** Exact public evidence values only; never credentials, private keys or provider messages. */
export function pairDiagnosticComparisons(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PairDiagnosticComparison[] {
  const encode = (v: unknown) =>
    typeof v === 'bigint'
      ? v.toString()
      : typeof v === 'string'
        ? v
        : (JSON.stringify(v) ?? '<unavailable>');
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].map(
    (field) => ({
      field,
      before: encode(before[field]),
      after: encode(after[field]),
    }),
  );
}
/** Internal and non-enumerable. Explicit diagnostic tools may read it; APIs do not serialize it. */
export function pairReviewDiagnostic<T extends Error>(
  error: T,
  check: string,
  details: PairDiagnosticDetails = {},
): T {
  Object.defineProperty(error, 'pairDiagnostic', {
    value: Object.freeze({ check, ...details }),
  });
  return error;
}
