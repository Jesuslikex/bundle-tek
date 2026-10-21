# Exact warmup action and packet identity

21 October 2026. Source-only follow-up to Opus 5.5's aa75dbf review.

## Finding and change

The reviewer correctly found that equal plan/cycle/wallet/amount fields do not establish which session submitted a transaction. Receipt uniqueness alone gave the first capturing journal the outcome. A preparation created before a session could also match those fields. No production caller uses the capture function.

New additive migration `0126_wallet_warmup_session_action_bindings` and an internal owner-scoped service retain an exact unsigned preparation while its action is reviewing, **before any signing intent or receipt for that preparation exists**. Its immutable row binds owner, journal, action, original begin-review version/head, exact preparation ID/document, unsigned packet SHA and creation time. Owner/preparation and owner/packet identities are unique across journals. A second preparation carrying identical unsigned packet bytes cannot be assigned to a different action.

The INSERT trigger repeats the current journal head/begin-review checks, canonical preparation time at or after begin-review, original review freshness, exact action side/wallet/mints/raw amount, live plan/source and wallet revision, and the original Buy dependency for a Sell. Existing intents are refused in every state, including cancelled/failed. UPDATE, DELETE and replacement are blocked. Lost responses and cancellation recover the same identity without another INSERT. This is an identity record, not a funds reservation or signing approval.

Settlement capture now requires this binding before provider reads. The exact preparation and document must match the selected receipt's owned preparation/intent join. The original verifier still checks the actual signature, packet, mainnet genesis and finalized balances. An additional settlement INSERT trigger repeats the binding comparison atomically beside the existing source/head guards. It does not rewrite any committed migration or loosen existing verification.

The old cross-journal test now tries the wrong journal **before** the correct journal captures, then again afterwards. Both wrong-journal attempts refuse before RPC; the correct action remains able to retain its own outcome. A cloned preparation with the same wallet, cycle, amount and packet is also refused.

Late finalized outcomes remain recordable after Stop, expiry and archival when their identity was bound beforehand. Existing historical settlement recovery is unchanged; it does not retroactively create missing action bindings, qualify old history for signing or grant authority. Generic submitted/unknown labels remain observational and cannot complete an action without the new exact binding and real verifier.

## Other review follow-ups

- Held fallback now requires a measured fee/positive-rent cost greater than the original remaining reserve. Within-reserve replay refusals remain errors. Held records still preserve actual verified facts without completing or charging the refused action.
- Added capture from unknown state, a held Sell, and a head-only Stop race at INSERT.
- The capture fixture now installs actual migrations 0042 and 0045 for preparations/intents, rather than handwritten versions. Receipt/plan/wallet fixture tables remain minimal. This does not claim that every historical table trigger has been exercised by capture tests.

## Verification

- 459 tests across 20 related files pass together, including 26 binding cases and 27 capture cases. These use disposable memory SQL, synthetic signed transfer packets and controlled provider responses, not live DEX trades.
- All 127 migrations pass the checksum-checked runner in a new disposable local database.
- Plain full-project TypeScript and five-file typed lint/format pass. The final 2685-file source snapshot is unchanged, SHA256 `75c06876b3301546a6041b1fee2253fe74e2d94f99e3555d41f63e78c3ae166e`.
- The real whole-file Wrangler command applies all 127 migrations with matching ledger and exit 0 in disposable `bundle-wrangler-migrations-kru2cF`. An earlier passing run used an older candidate of 0126 and was superseded after its recorded source hash differed; the final run uses the verified source. No full-repository suite, browser or live provider verification is implied.

## Boundaries and remaining work

### Fresh reference check

Public documentation was reopened on 21 October, separately from historical browser captures. [Generate Activity](https://docs.proxima.tools/wallets/generate-activity/) describes selected Solana wallets, fixed/ranged amounts, loop count, delay, balance/duration estimates, optional Axiom routing with extra loop cost, and per-wallet progress/transaction-count/volume. Reopening a session, cancellation without reversing completed trades, and dismissing terminal sessions are explicit acceptance checks for our eventual UI. This backend checkpoint does not complete them.

[Auto Buy / Auto Sell](https://docs.proxima.tools/live-settings/auto-buy/) describes combining Counter, DCA and market-cap limit strategies, per-strategy/session limits, wallet selection, ignored addresses, start delay and pause/edit/end controls. These remain separate rendered/runtime parity checks. Keep Bundle's price protection and consent safeguards; documentation comparison does not authorize weakening them.

REA's actual `list_browser_targets` call to the approved loopback endpoint9223 again returned `provider_unavailable`, reason `endpoint_unreachable`. No fresh authenticated runtime/network capture was obtained, and no debugging-browser launch/reconfiguration was attempted. The documentation check above is not a substitute claim of live-browser equivalence.

No new API, UI or dispatcher calls this service. Shared wallet/funds reservations, per-action preparation orchestration, fresh short authorizations, qualified execution windows, scheduler/UI recovery and rendered end-to-end tests remain before automatic Start. The existing signing and execution safeguards remain in force. The 60-second review admission, stock 32-slot bound, code scans, custody and Clock checks are unchanged.

No protected UI, application/hosted SQL, provider, credentials, cron, wallet unlock/sign/send, funded test or deployment was changed. Migrations0126/0127 are source only and must not be applied to the application database outside an approved release. After the follow-up below, the next free number is0128, subject to checking local main.

Opus aa75dbf review completed successfully with actual model metadata `claude-opus-5-5`, only Glob/Grep/Read, no tests or edits. It approved the scoped atomicity/source/budget mechanism on reading and raised the action-identity gap above. The separately completed review of374c203 and Codex's accepted follow-up are recorded below.

## Completed Opus review of374c203 and accepted follow-up

The isolated committed-source review completed successfully on actual `claude-opus-5-5` only, with Read/Glob/Grep, zero permission denials, no other model or subagent, and all2122 copied files unchanged. The reviewer ran no tests/build/migrations and edited nothing. Its final result says the prior M1 is closed **at the capture boundary**, including reversed capture order, pre-existing preparations/receipts and the saved-buy substitution. It found no high/medium defect within its stated reading scope. The scoped held-overrun narrowing and new unknown/Sell/head-race cases were accepted.

Three low findings were independently checked and addressed:

1. A write can queue after the server's expiry check. Additive source-only0127 requires the real SQL clock to remain before both the original review expiry and preparation expiry. Committed0126 is unchanged. SQL-only regression cases isolate the actual new trigger in a disposable database, showing that an earlier captured timestamp cannot admit an already expired review/preparation; no wall-time sleeps or simulated claim of an actual delayed production write.
2. A one-shot binding should not consume an expired or failed-simulation preparation. The new trigger also requires canonical usable expiry, a successful recorded simulation, Solana chain and unchanged false execution/instruction-verification flags. These are admission conditions, **not** full route/code/custody qualification or signing permission.
3. Two identical concurrent binding requests can have different observation timestamps. Recovery now independently verifies the retained row hash, then compares every identity fact except that row's admitted timestamp/hash. Both calls return the same winner; different preparation, packet, document, action, owner or review identity still refuses. A barrier test makes both callers reach INSERT with distinct clocks.

Final follow-up: **467tests/20relatedfiles pass together**, including34 binding and27 capture cases. Full plain TypeScript, three-file typed lint/format and the unchanged2686file source freeze pass (digest `b65762c2ae52627ad73a16d5e03f7abfe618ce4c966bea3ead41e9982dc5ec59`). Both the checksum runner and real whole-file Wrangler apply all128 migrations with matching ledgers and exit0 in disposable local databases; final Wrangler scratch `bundle-wrangler-migrations-vJdkZ3`. These are local synthetic checks, not a full repository suite/build, funded/live-provider proof or signed-in Bundle release QA. This follow-up is Codex-verified, not independently re-reviewed by Opus.

Reviewer scope: full diff, new binding service/26 tests,0126, capture service/27 tests, fixture, sequence/source helper, prior review and relevant journal/consent/plan/wallet/preparation/intent migrations; only the first60lines of0125, parts of preparation/history helpers and manual signing handler. Genesis/signature/receipt parser internals,0047 trigger bodies and D1 runtime behaviour were not re-reviewed. Coverage is not inferred from test names.

Before integration, create and bind the action's preparation atomically or retain the action identity when creating it; exclusivity alone does not prove where an unsigned preparation originated. The manual signing route must refuse session-bound preparations, and session intent creation must require an active bound action. Shared wallet/lot reservations and an explicit path for never-signed/expired preparations remain necessary. No API/dispatcher was mounted and signing stays off.

Later in this turn, the user authorized the existing Chrome Proxima wallet tab. A read-only open of Generate Activity and screenshot showed a genuinely present running-session view: settings summary, progress/time remaining, per-wallet Tx/Volume and Cancel. A subsequent DOM read showed the remaining-time label advancing. The screenshot shows the running-session view; the accessibility tree also contains draft-form fields that are not visibly presented there. Do not mistake those draft fields or their wallet count for the active session. No session setting, cancellation, wallet selection, key, signature or transaction was changed. Personal wallet identifiers, balances and strategy amounts are deliberately omitted here. This fresh browser UI evidence is distinct from REA, whose CDP endpoint remains unreachable; it proves neither network architecture nor on-chain outcomes.
