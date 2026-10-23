/** Browser-local courtesy gate. Existing server rate limits remain authoritative. */
let notBefore = 0;
export function fundingHistoryNotBefore() {
  return notBefore;
}
export function noteFundingHistoryRead() {
  notBefore = performance.now() + 17000;
  return notBefore;
}
