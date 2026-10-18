# Deterministic per-buy launch cost allocation

This continues the original Proxima parity goal. It is an internal accounting foundation, not a completed acquisition ledger, P&L feature or claim of vendor equivalence. The previous payment report remains actual-payer attribution; its public contract and UI do not silently change to shared costs.

## Implemented

`lib/pump-purchase-costs.ts` reparses exact retained primary receipts, reconstructs the reviewed group and derives the original ordered active buy intents. It consumes the existing validated terminal fees/tip projection as an internal input. The future owner service must independently replay that projection through `readOwnedPumpGroupRecordedCosts`; a syntactically valid public cost report alone does not establish provenance.

Policy `reviewed-buy-shares-v1` divides each actual packet fee among that packet's original active buy intents and divides the recorded tip and tip-transaction fee separately among all original active buy intents. Each interval is `floor(total*(i+1)/count)-floor(total*i/count)` with BigInt. A failed, missing or unqualified buy keeps its original position. Its share stays unallocated; later receipts do not rebase costs already attributed to other buys. Creation-only packet fees likewise remain unallocated. This is a declared allocation policy, not a claim that each buyer actually paid an equal network fee.

Known overlapping receipt/settlement fees and outcomes must agree. A later raw receipt may fill an older unobserved packet; an older retained settlement may preserve a fee missing from the selected raw snapshot. Neither source can erase a known contradiction. Unknown fees stay explicit. Both finalized tip debit and tip-transaction fee are required before constructing a plan; null is never zero. A failed finalized tip may have zero debit and a known transaction fee.

Each qualified buy retains exact acquired units, quote debit, separate SOL fee/tip shares and separately identified setup funding paid by that wallet. Only native quote amounts can form a native trade-cost subtotal, which explicitly excludes setup. Token quote units are never added to SOL amounts or converted through an assumed peg. Account creation funding, rent eligibility/refunds, venue fee splits and complete acquisition basis remain unqualified.

Origin identity hashes the network, actual packet-signature hash, mint and buyer. It excludes review/project/workspace identity. The tests retain the same signed transactions under a different valid review and verify identical origins. The future storage table must enforce owner/origin uniqueness and reject changed cost vectors or attempts to record an existing origin under another review; an identity hash by itself is not durable duplicate prevention. Source documents and whole plans have canonical hashes for subsequent exact review and storage.

The receipt service now has a private exact-ID source reader. It uses the original signature/receipt parsers, owner-scoped SQL, required immutable-storage guards and final source/parent rechecks with cancellation. It returns raw internal evidence and must never be serialized directly into an HTTP response. The public latest-summary reader is unchanged. A newer poorer snapshot cannot implicitly replace the requested older source.

All signing, execution, profit, acquisition-basis and reservation authority flags remain false. No new API, automatic provider call, storage write, migration or UI action is connected by this checkpoint.

## Validation

The tests use real compiled packets and Ed25519 verification with explicitly synthetic balances, instruction metadata and terminal cost projections; they do not execute BPF or establish live-chain economics. The receipt ownership tests exercise the real database service and local SQLite, with existing HTTP composition regressions retained.

- The combined five-file run passed66/66 tests, terminal0 under exec53210. It includes22 allocation cases,13 receipt/service/SQLite cases,12 payment projection cases,15 terminal cost cases and4 route-boundary cases. JSON/log: `work/release-qa/purchase-cost-allocation-final-v2-20261018.{json,log}`. It covers failed/unobserved/metadata-unqualified packets, native and token quotes, rounding up to u64 with every admitted denominator, duplicate review identities, exact-source owner isolation, cancellation and changed parent before publication.
- After that run, a final allocation-only change checks cancellation after the asynchronous plan digest, with a deterministic test aborting during that exact digest. All23 final allocation cases passed, terminal0 under exec12438, in48.71s. JSON/log: `work/release-qa/purchase-cost-allocation-cancel-20261018.{json,log}`. The receipt service and its test remain unchanged from the combined run. This is67 distinct cases across the two final runs; the new case is not retrospectively included in the66-case claim. All four owned source hashes match `work/release-qa/purchase-cost-allocation-final-source-20261018.json` after completion; the earlier source vector is retained separately.
- Actual-source standalone TypeScript passed, terminal0 under exec35306, before the final digest cancellation test. Final four-file type-aware lint, including that test, passed terminal0. No Next build or browser UI test was run for this internal checkpoint; there is no new browser interface. The previous payment UI build/browser evidence has its own scope in the preceding checkpoint.
- External Node network access was blocked with the existing offline preload, and Vitest environment-file loading was disabled. No application credentials or environment files were read. The first47-case pass, an interrupted combined attempt and a subsequent invalid test-review hash failure have separate retained logs. The fixture now reconstructs its new review context hash before verifying the same signed transactions; no production hash rule was relaxed.

The original broad-suite failure remains outside this focused validation; this does not claim a green current full suite or production economic readiness.

## Remaining work

1. Add immutable, naturally idempotent owner/origin sources and receipt-bound batches in a new append-only migration. Recheck the journal and claim the next number first; no migration is created or applied here.
2. Compose exact receipt reads with actual retained terminal broadcast proof, capture and recheck the exact parent closure, and use atomic database batches with conflict guards and lost-response recovery. Never accept caller-authored amounts or expense rows.
3. Add an explicit review/save/load flow with bounded requests, exact plan hashes, clear incomplete/overhead labels and no wallet unlock or signing.
4. Integrate global acquisition consumption across duplicate imported workspaces, real sale selection and the performance timeline. Preserve quote-asset valuation/inherited basis and account-funding/refund qualification boundaries. Snapshot overhead totals must not be summed as separate expenses across multiple receipt batches.

The broader Proxima parity goal remains incomplete. No funding, wallet unlock, real signing, transaction submission, deployment, provider/credential change, hosted database migration or Git push is part of this checkpoint. The other chat's exchange UI work is separate and preserved.
