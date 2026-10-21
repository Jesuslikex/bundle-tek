# Warmup runtime observations

This is a source-only server integration on base `70074cf`. It connects the raw runtime collector to an authenticated, explicitly requested warmup attempt and retains its evidence. It does not make Generate Activity an executing session. Browser controls for choosing this mode, approving it and recovering its results are the next connected step.

## What changed

- Additive migration `0135_wallet_warmup_session_v2_runtime_observations` records an immutable preview/runtime purpose before the attempt lease. Both inserts use one write transaction with a deferred foreign key. Existing pre-migration attempts remain previews permanently. New previews and runtime observations share the original attempt count, cooldown, original finish and source guards.
- A runtime provider uses the existing v2 provider and original preparation core around the raw collector. One wallet-bound order, one raw simulation, both full serial code scans, exact ordinary account Clocks and the 32-slot span remain mandatory. Original source, lot, fee reserve, cancellation and expiry checks still run. There is no stock profile or changed program pin.
- A prepared runtime result retains a private sidecar before its existing immutable outcome in one transaction. Deferred foreign keys and insert guards prevent orphan records and mode retrofits. The document binds the original request, full context, review, native settlement observations and both complete identity vectors. Hashes preserve integrity; they do not attest code safety or grant authority.
- The new `session-v2-runtime-attempts` API requires an authenticated owner, same-origin bounded JSON, the original four identifiers and literal `runtimeRequested: true`. Recovery is owner-scoped and saved-only. Responses expose a whitelist, never the packet or private context/review documents. The earlier effective expiry is explicit.
- A result committed between the outcome and sidecar reads causes one saved-read retry, never a provider retry. Persistent inconsistency refuses. Malformed stored schemas, date fields or JSON are storage errors. Installation checks require all twelve new schema objects and enabled foreign-key enforcement.
- Raw runtime observations omit legacy route/binding assessment labels because those legacy assessments did not run. Actual checks are retained in the separate runtime evidence. All signing, execution, automatic execution, trusted-program and independent-price authority remains false.

## Review

Actual `claude-opus-5-5`, high effort, reviewed detached copies with Read/Glob/Grep only. Both reviews completed before the first commit of migration 0135. The initial review found no required SQL changes and identified the saved-read race, stored-error mapping, labels, foreign-key check and effective-expiry issues corrected above. The follow-up confirmed those fixes and found no SQL blocker. Both copies were unchanged, with zero permission denials. Opus did not run tests; Codex ran the verification below.

## Verification

Final counts and terminal results are in `CODEX-WARMUP-RUNTIME-MODE-EVIDENCE-20261021.json`.

- Native libsql tests use the production Turso batch adapter and declared synthetic chain data through the real provider, storage and HTTP route. They cover atomic rollback, lost acknowledgements, Stop, mode/owner isolation, concurrent same-ID requests, rate limits, corruption and bounded saved-read recovery.
- A real SQL-clock test waits beyond runtime expiry and confirms recovery neither renews the observation nor reruns providers.
- All 136 migrations apply through both the checksum runner and whole-file Wrangler CLI in disposable local databases. The local ledger matches every checksum, integrity is `ok`, and there are no foreign-key violations. All 135 older physical SQL files, their journal prefix and 778 older schema definitions remain unchanged.
- The first broad two-worker regression run was incomplete: a worker exited while running journal-storage tests. Its report incorrectly marked that partial file passed despite 26 pending assertions. It is retained as failed evidence, not a pass. The final serial run is recorded separately.
- The final serial run passes all 93 related files: 1,809 tests pass, one opt-in clock test is skipped, zero failures or unhandled errors, and all 2,782 frozen source hashes remain unchanged. The skipped real-clock case is run separately.
- A real Wrangler local D1 `PRAGMA foreign_keys` read returns the expected `{ foreign_keys: 1 }` shape. The corresponding local migration database contains all 136 migrations. This is compatibility evidence for local D1, not the hosted database.
- Plain TypeScript, scoped typed lint/format, source-freeze checks and the isolated production build are recorded separately. No rendered runtime-mode UI or live provider qualification is claimed by this server checkpoint.

## Release and remaining work

Never edit migration 0135 after this first commit. Next unclaimed number is 0136, subject to the current journal and claims. No application or hosted database was migrated here.

For a later authorized release, deploy compatible purpose-writing code before applying 0135: its new lease trigger intentionally refuses old lease inserts without a purpose. Verify foreign-key enforcement and the deployed runner's real transaction/deferred-constraint behavior before applying it. Source-only local tests are not production verification.

After applying 0135, a code rollback must retain purpose support. Its child foreign keys also need to be considered in any future table-rebuild migration. Do not remove guards to work around either constraint.

Remaining connected work includes mode-aware UI admission, separate initially unchecked consent, recovery reminders/discovery and expiry display; native saved-buy Sell runtime composition coverage; independently reviewed program policy; financial reservations, short browser authorization, finalized settlement and actual action/budget advancement; durable session orchestration and qualified routing. The self-referenced order minimum is explicitly not an independent price check. This is not a completed automatic warmup or full Proxima parity.

Before adding the UI, distinguish runtime IDs in legacy preview discovery and use `runtime.effectiveExpiresAt`, not the embedded preview's later quote expiry. Current provider-core source calls its quote and simulation callbacks exactly once; the integration tests verify one order and one raw simulation. A defensive adapter callback-use guard remains a useful later hardening step. The request retains the complete inventory; only its intentionally smaller summary projection is compared field by field.

Protected Claude shell/layout/global CSS, existing signing paths, group defaults and old SQL are untouched. No provider, credential or cron setting changed. No real wallet was unlocked, signed or submitted, and no funded test or deployment occurred. A normal origin push only shares source with Claude; Git deployments remain disabled.
