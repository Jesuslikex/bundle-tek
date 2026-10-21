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

No new API, UI or dispatcher calls this service. Shared wallet/funds reservations, per-action preparation orchestration, fresh short authorizations, qualified execution windows, scheduler/UI recovery and rendered end-to-end tests remain before automatic Start. The existing signing and execution safeguards remain in force. The 60-second review admission, stock 32-slot bound, code scans, custody and Clock checks are unchanged.

No protected UI, application/hosted SQL, provider, credentials, cron, wallet unlock/sign/send, funded test or deployment was changed. Migration 0126 is committed source only and must not be applied to the application database outside an approved release. Next free number is 0127, subject to checking local main.

Opus aa75dbf review completed successfully with actual model metadata `claude-opus-5-5`, only Glob/Grep/Read, no tests or edits. It approved the scoped atomicity/source/budget mechanism on reading and raised the action-identity gap above. A fresh focused review of this committed follow-up is separate and must not be described as completed until its actual final result exists.
