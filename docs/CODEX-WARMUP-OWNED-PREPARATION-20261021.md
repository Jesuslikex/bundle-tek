# Session-owned warmup preparation creation

21 October2026. Follows7d73489 and Opus374c203's integration requirements. Source only; automatic Start/signing stay off.

## Behavior

`prepareWalletWarmupSessionAction` derives the original reviewing action and exact Sell dependency from the owned, fully replayed journal. A trusted server callback receives only a cloned candidate and AbortSignal, prepares its unsigned quote/simulation summary without persisting, and returns that summary. This callback is an internal integration point, not a request-body document, network provider implementation or execution capability. The real quote/simulation pipeline must be supplied by the eventual authenticated dispatcher.

Additive migration0128 retains an immutable owner/journal/action/preparation identity. A **single INSERT** into that table trigger-creates the ordinary preparation and its original0126/0127 action binding. There is no externally visible unbound-preparation gap. Existing preparations cannot be adopted. The original plan/wallet/document/history-capacity predicate repeats at insertion; a zero-row preparation INSERT explicitly aborts the entire statement. Any binding, freshness, source/head or uniqueness refusal rolls back the wrapper and new preparation together. The original plan, wallet and receipt histories are not rewritten.

The original JavaScript history validator was extracted and reused. Its input/cycle/wallet/mint/amount and false-capability checks, and the manual writer's existing SQL, remain in place. The new trigger keeps the same4000-record history capacity and uses the database clock for expiry. This history limit is not a spending or signing permission.

The record and original session-owned preparation are immutable, including replacement paths. Exact same-ID reads recover after expiry, archival or Stop without another callback or INSERT; the record, preparation and binding must still agree. Two identical concurrent writes recover the admitted identity despite differing timestamps, while distinct IDs racing for an action return the original winner's ID. If an earlier bare binding has no action-owned preparation record, the service holds the action with explicit recovery guidance; it never offers a nonexistent owned-record GET ID. Both initial and insertion-time legacy races are tested. Cancellation after commit preserves original-ID recovery. No write retry, replacement quote or signature is made.

## Manual signing isolation

The existing warmup manual signing API now refuses review, registration and submission of session-bound preparations before provider or signature work. Existing history reads, failure recovery and cancellation branches are unchanged. Pre0126 schemas remain supported without assuming the source-only binding table is installed. An additional0128 intent trigger blocks creation of any signing intent for a bound preparation while session signing is disabled, closing the race after the API's early read. The new route returns a fixed409 message rather than exposing SQL text. Existing unbound manual flows retain their original checks.

No session intent/signing path is introduced. The actual session-owned preparation result carries execution/signing/automaticExecutionAllowed false. Its internal identity contains captured plan/preparation documents and is not an HTTP DTO.

## Verification

- Final537 tests across23 related files pass together. This includes26 new native SQLite/parser/real Request-Response cases,40 existing plan/quote/preparation/buy-to-sell cases and4 existing signing/failure/recovery cases. The four native vault/external/restored buy-to-sell cases use controlled RPC and synthetic keys; none are funded tests. Initial535-test candidate was superseded after Codex's legacy-recovery clarification.
- New cases exercise atomic creation, no adoption of an existing preparation, action-derived Buy/Sell context, history-cap zero-row rollback, Stop/plan/wallet/guard races, failed-simulation rollback, owner isolation, exact recovery, lost response/cancel, concurrent same/different IDs, immutability/replacement, direct SQL intent refusal, and actual manual review/register/submit409 responses without provider calls.
- Full plain TypeScript, scoped typed lint/format and unchanged2690file source snapshot pass. Final snapshot digest `ad7bf2d4479e8888e6e184e0a19474a86d49aea9159f96b3da5e5db0653a55aa`. Five-file lint passed on the initial candidate, and both changed service/test files were linted again with a full TypeScript rerun after the recovery clarification.
- All129 migrations apply with matching ledger/checksums in fresh disposable databases using both the native runner and real whole-file Wrangler command. Final Wrangler scratch: `bundle-wrangler-migrations-ZaoXP1`. No historical migration was edited.
- No full repository suite, build, mounted-session-preparation API/UI, rendered Bundle flow or live-provider qualification is claimed. This checkpoint has not yet received its own completed Opus review.

## Remaining full-flow work

Wire the existing real quote/simulation pipeline into this internal callback with authenticated owner, strict bounded request shape, scoped pacing/cancellation and a public DTO. Add shared wallet/lot/funds reservations and qualified session intent authorization before any signing capability. Provide an explicit never-signed/expired-preparation recovery path, runtime execution window, scheduler and rendered/reload progress controls. Keep the eventual multi-wallet activity experience in scope; the current single-pending sequence is not a claim of complete Proxima session parity.

Stock32-slot/code/custody/Clock/minimum protections, protected layouts and all existing consent safeguards are unchanged. No application/hosted SQL, provider/credential/cron change, real wallet unlock/sign/send, funded test or deployment. Next free migration0129, subject to checking local main.

Opus request: review only this committed checkpoint and relevant0126/0127/0128 guards. Focus on one-statement rollback including zero-row creation, exact identity/origin binding, owned recovery/concurrency, immutable replacement paths, original manual-history validator/SQL preservation and manual review/register/submit isolation without disturbing recover/cancel. Use actual `claude-opus-5-5` with only Read/Glob/Grep, no shell/tests/edits/network/deployment/wallet tools, and state exact scope and limits. Do not imply completion before an actual final result/model record.
