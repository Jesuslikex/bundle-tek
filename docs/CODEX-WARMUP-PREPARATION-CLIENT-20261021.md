# Unsigned preparation client admission

## Completed Opus review and accepted follow-up

Actual `claude-opus-5-5` reviewed committed `9712191` from 05:19:51Z to 05:24:03Z. Requested, selected and used models were Opus5.5 only. Read/Glob/Grep only, zero permission denials, no edits/tests, all2648 copied files unchanged. Private review receipt: `work/release-qa/opus-preparation-client-9712191-20261021/status.json` and its sibling `review.jsonl`. The review found no authority/signing acceptance bug, but identified two medium display-admission mismatches: smaller saved-buy Sell amounts and missing repeated Buy budget checks. Codex independently confirmed both against the actual provider and immutable source document, then tightened them.

Accepted low findings: non-null native change for this provider path, the exact existing integer-floor 0.5% quote protection and at-most30-second quote lifetime, refusal of impossible paused/stopped original reviewing heads, and hash-format-only wording. Packet hash format/presence is not an independent commitment check; the current public projection has no second source to compare it against. Native change must not be labelled total SOL spent/received because wrapped-SOL changes are separate. The server-computed combined fee bound is not yet public: estimated fees and observed network fees are separate provisional values, not exact total cost proof. A later panel must preserve those labels.

A separate server correction refuses an expired quote immediately before taking the retained creation timestamp/write, using the same app clock as the source-window guard. This closes a possible app/database clock discrepancy without changing any deadline, schema or migration. A new callback-boundary regression checks zero new preparation/binding rows. Same-ID historical recovery still happens before this creation guard.

The synthetic client journal is now re-admitted through the real journal client; historical recovery keeps the original unchanged head rather than inventing a stopped state at that head. The composition test uses one controlled clock for provider/parser/storage, avoiding a fixture-only expiry mismatch. New cases cover smaller Sell, Buy overspend, long quote lifetime, missing native change, changed output and earlier quote expiry. This follow-up is independently verified by Codex; it has not been rereviewed by Opus. Final verification follows when the running checks finish.

## Initial checkpoint

21 October 2026. Continues the session provider API at `001f5e0`.

The new `lib/wallet-warmup-session-preparation-view.ts` admits only an exact, bounded public preparation projection for an original admitted reviewing journal head and consent context. It binds request ID, action, wallet/revision, cycle, plan/revision, mints, Buy amount, journal version/hash, scheduled time, original review deadline, packet availability/hash-format consistency and fee reserve. Saved-buy Sell amounts must equal the original exact amount; current lots and session-buy amounts still require server checks. Successful complete simulation and the existing wrapped-SOL nullable comparison semantics are required. All four authority flags must be false. Unknown fields, packet bytes, changed contexts and parser/provider messages refuse with fixed guidance.

Provider quote expiry may legitimately exceed the session deadline. The client preserves it and separately derives `effectiveReviewExpiresAt` as the earlier quote/source/approved-finish time. Historical records remain readable against the original review head; reading never renews a deadline or authorizes a trade. A future UI must persist that original head/request before its one POST, recover through GET, and must not substitute a newer journal head during recovery.

This is a client admission checkpoint, **not a mounted preparation panel**. No fetch, write, signing, Start button or automatic runner was added. The reviewing transition UI, request marker/recovery orchestration and rendered review panel remain next. Full multi-action activity still needs fresh per-action qualification, reservations and separately approved signing; the old 60-second source window remains unchanged.

Verification at this checkpoint: 120 tests in three files pass together (39 client cases, 29 journal admission cases and 52 actual API cases). One new case composes actual local SQL consent/journal/preparation services, real Jupiter unsigned envelope/quote parsing, actual public projections and all three client admissions. Simulation transport is synthetic; there are no live providers, funds or real DEX/signing results. The initial composition correctly refused the legacy transfer fixture's incomplete simulation; the test now uses the real provider callback with explicit synthetic complete simulation, rather than weakening admission. Two-file typed lint, formatting and diff check pass. Plain TypeScript and requested Opus review are recorded below when their actual results arrive. No new production build/browser check is claimed for this unmounted module.

Source freeze: 2712 files, digest `5e6fc9fc830d4e0c8818198855395e5180a6c352e249f6e7799be4576f18f92e`, private receipt `work/release-qa/warmup-preparation-client-freeze-20261021.json`.

No protected UI files, committed migration bytes, application/hosted SQL, provider/credential/cron settings, deployment or wallet transaction changed.

Plain whole-project TypeScript (`tsc --noEmit --incremental false`) passed on checkpoint 9712191. The frozen source stayed unchanged. The Opus review is now complete; see below.

Final accepted follow-up: 801 tests / 29 related files pass together, plain whole-project TypeScript and four-file typed lint/format pass. The unchanged 2712-file freeze has digest d3e1170e38af16c5e1da0559983c9bcdd3f059794412933f9566bb3e3d6c053f (work/release-qa/warmup-preparation-client-followup-freeze-20261021.json). No full-repository suite, new production build, browser panel or live-provider proof is claimed.
`nClient follow-up commit: c36bff0. Separate server expiry correction: 31ca76d. The initial client checkpoint was 9712191.
