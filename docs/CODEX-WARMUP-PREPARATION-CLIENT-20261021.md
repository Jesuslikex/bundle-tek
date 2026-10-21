# Unsigned preparation client admission

21 October 2026. Continues the session provider API at `001f5e0`.

The new `lib/wallet-warmup-session-preparation-view.ts` admits only an exact, bounded public preparation projection for an original admitted reviewing journal head and consent context. It binds request ID, action, wallet/revision, cycle, plan/revision, mints, Buy amount, journal version/hash, scheduled time, original review deadline, packet availability/hash and fee reserve. Saved-buy Sell amounts cannot exceed the original lot bound; current lots and session-buy amounts still require server checks. Successful complete simulation and the existing wrapped-SOL nullable comparison semantics are required. All four authority flags must be false. Unknown fields, packet bytes, changed contexts and parser/provider messages refuse with fixed guidance.

Provider quote expiry may legitimately exceed the session deadline. The client preserves it and separately derives `effectiveReviewExpiresAt` as the earlier quote/source/approved-finish time. Historical records remain readable against the original review head; reading never renews a deadline or authorizes a trade. A future UI must persist that original head/request before its one POST, recover through GET, and must not substitute a newer journal head during recovery.

This is a client admission checkpoint, **not a mounted preparation panel**. No fetch, write, signing, Start button or automatic runner was added. The reviewing transition UI, request marker/recovery orchestration and rendered review panel remain next. Full multi-action activity still needs fresh per-action qualification, reservations and separately approved signing; the old 60-second source window remains unchanged.

Verification at this checkpoint: 120 tests in three files pass together (39 client cases, 29 journal admission cases and 52 actual API cases). One new case composes actual local SQL consent/journal/preparation services, real Jupiter unsigned envelope/quote parsing, actual public projections and all three client admissions. Simulation transport is synthetic; there are no live providers, funds or real DEX/signing results. The initial composition correctly refused the legacy transfer fixture's incomplete simulation; the test now uses the real provider callback with explicit synthetic complete simulation, rather than weakening admission. Two-file typed lint, formatting and diff check pass. Plain TypeScript and requested Opus review are recorded below when their actual results arrive. No new production build/browser check is claimed for this unmounted module.

Source freeze: 2712 files, digest `5e6fc9fc830d4e0c8818198855395e5180a6c352e249f6e7799be4576f18f92e`, private receipt `work/release-qa/warmup-preparation-client-freeze-20261021.json`.

No protected UI files, committed migration bytes, application/hosted SQL, provider/credential/cron settings, deployment or wallet transaction changed.

Plain whole-project TypeScript (	sc --noEmit --incremental false) completed successfully. The frozen source stayed unchanged. Opus authentication is confirmed; the focused review is next, not yet complete.
