# Inspected wallet activity totals

The wallet-alert transaction evidence panel now summarizes the loaded interval as decoded buys, decoded sells, transfers in, transfers out and unknown net token movements. It compares their deduplicated net with the saved alert's exact before/after balance difference.

This develops the bought/sold activity visible in the captured Proxima holder workspace without inventing complete history or accounting. The captured reference remains client evidence; this feature does not establish parity with its indexing, P&L or backend.

## Implementation

- `lib/supply-movement-summary.ts` validates wallet/mint/observation/interval/precision context, canonical 64-byte signatures, exact u64 before/after balances and classification compatibility. It accepts at most the existing 20 pages with five decoded transactions each.
- Signatures observed through wallet and token-account indexes count once. Duplicate records must agree on slot, integer balances and material classification evidence. Conflicts withhold totals rather than choosing a convenient record.
- BigInt turnover sums can exceed u64 while individual balance evidence remains u64-bounded. Legacy records without classification count as unknown. Unknown activity is reported as a signed net with a separate transaction count.
- `components/supply-movement-summary.tsx` displays token totals, counts, saved balance change, decoded net and unexplained difference. Net agreement is explicitly not proof of completeness because missing offsetting transactions can exist. The summary remains marked partial.
- `components/supply-movement-evidence.tsx` mounts the summary using the selected saved alert and its wallet-specific observation slot. Existing inspection, paging, chart targeting and individual evidence remain available.

The summary uses loaded evidence only. No new provider read, storage write, background task, signing or execution action is introduced. Unavailable transactions, omitted failed signatures and missing closed/reassigned accounts are not reconstructed. Tokens are not converted to USD and no realized/unrealized P&L or complete-wallet turnover is claimed.

## Verification

Eighteen tests across the new helper/rendering suites and existing movement-evidence suite passed. Cases include cross-index deduplication, distinct buy/sell/transfer/unknown totals, missing evidence reconciliation, legacy classification, conflicting duplicate facts, mixed/foreign intervals, precision and invalid integer rejection, and turnover larger than u64. TypeScript and scoped lint passed.

React review: totals are derived without additional effect/state or fetch, maps/tables use stable keys, headings/regions and table header scopes expose the summary, and long numeric values wrap. Browser visual verification remains outstanding because the earlier localhost reconnection was rejected by browser security policy. No alternative browser or lower-level workaround was used.

Claude's holder/watch-wallet files and test-reliability changes were untouched. No credential read, live RPC call, signature, submission, migration or deployment occurred. Complete holder/history coverage, live supported classification, final visual verification, funded execution and full Proxima parity remain incomplete.

Final production build passed all five stages. The existing large client chunk warning remains.

## Later inspection classifications, 12 October 2026

Immutable saved pages can contain an earlier unresolved decode and a later supported classification for the same signature. The summary now accepts this update only with identical on-chain balance/slot facts and strictly ordered, canonical inspection times with valid anchor/provider provenance. It selects the latest interpretation in any page order. A later unresolved inspection removes an earlier trusted label.

Every retained known interpretation is checked even if a newer unresolved version supersedes it. Conflicting buy/transfer labels, protocols, quote details or settlement accounts still withhold totals. Equal-time classification differences and invalid provenance also withhold totals. Reasons and counterparty array order are presentation differences.

The original behavior failed both new promotion/downgrade regression tests. The corrected helper, summary rendering and movement evidence rendering suites pass 19 tests. TypeScript, focused lint and all five production-build stages passed. This is a loaded-evidence summary repair; it does not enlarge index coverage or introduce signing/provider operations.
