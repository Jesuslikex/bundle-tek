# Complete saved Auto Sell progress bridge

26 October 2026. Source base `1e7bc6f`.

Saved run recovery now offers **Original progress and remaining allowance**. An explicit saved-only GET transports the complete original run and attempt chain, declared canonical head, preparation starts and Stop. The browser independently verifies the evidence and replays exact integer accounting. It shows original start/end clocks, permanently charged reservations, remaining recorded caps, consumed trigger keys, durable DCA index/time and unresolved original references. Reserved tokens are never called sold. No saved queue or finalized sale is invented.

This bridge is required before connecting the actual runner: the old runner uses newly initialized clocks, loses Counter source lineage and treats submitted/uncertain outcomes differently from journal reservations. Its amount-only sell callback and wallet rotation cannot safely stand in for an exact owned journal attempt. The existing runner/executor remain unchanged and unconnected. Signing, execution, automatic resume and allowance release stay false throughout.

## Integrity and lifecycle

The new pure decoder admits closed descriptor-safe bounded evidence and reuses the original run/attempt hash readers and full-chain replay. No caller accounting is accepted. Declared sequence/head must equal the entire replay. Original wallet, profile, clocks, limits, occurrence claims and DCA cursor are retained; no random draw, catch-up or budget reset occurs. Starts require unique exact attempt/preparation/head/time associations and original lifetime limits. Stop remains exact and terminal. Historical unsaved queues, skipped triggers, unreserved random decisions and finalized sales are explicitly unavailable.

A complete owned storage read is bracketed around the observation clock: read1, capacity precheck, SQL clock, read2. Any run/attempt/accounting/start/Stop difference refuses without retry. The original canonical storage/API are untouched. Both reads are saved-only; nothing calls a provider. This is historical inspection, not a qualification clock or permission to execute.

The authenticated GET accepts only one projectId/runId pair, checks owned project association, and returns no-store evidence. Archive, current project or wallet revision changes do not erase historical reads. Whole evidence and HTTP wrapper must fit1MiB. Oversized valid histories return409 without truncating keys or exposing partial restored progress; existing paged attempts remain available. Query, source, hash, head, ownership and abort failures return fixed errors, not raw parser/provider text.

The client binds owner scope, project, original run hash, previously observed sequence/charge/Stop and the exact earlier head even if the chain grows. Previous complete evidence is synchronously copied before asynchronous work, then independently replayed; existing attempts remain an exact prefix and each known start/Stop remains unchanged. Known preparation starts from ordinary pages/packet reads also form a monotonic floor. A stale or changed complete response cannot replace the previous verified view.

The collapsed panel reads only on explicit buttons. Closing, owner/project/run changes, cancellation and parent operations abort pending reads; late replies cannot publish. Parent observations advance only after full validation. Complete progress promotes cached attempt/selected-attempt start markers; an old not-started packet is cleared and later regression is refused. Consumed/unresolved reference lists show at most20 explicitly labelled entries while the complete underlying evidence is still validated. Remaining allowance is labelled accounting, never spendable permission, including stopped/expired/not-yet-active runs. Current tab-only sessions are still clearly labelled unjournaled.

## Review findings and actual race proof

The first real Opus5.5 source review identified the unbracketed clock and a head floor that applied only at the same sequence. Both were fixed. Minor copy now distinguishes other references, absent DCA timing and non-spendable accounting.

The initial review lacked0153 SQL and overstated some timing failures. Inspection confirmed its actual start INSERT guards pin current head/open/source/no-Stop and original insertion-time lifetimes. A narrower real counterexample was reproduced through unchanged actual services and SQLite: Stop samples its clock before an awaited INSERT; a later reservation/start can commit first, then Stop commits with its earlier sampled timestamp. The ordinary canonical reader accepts this history. The new display decoder now checks Stop against run creation and observation without falsely imposing Stop-sampled-time ordering over later committed attempts/starts. Every actual SQL/runtime/head/lifetime guard is unchanged. All charge and identity data stay unchanged, lifecycle is stopped, and no allowance is released. Start/Stop request timestamps are explicitly not commit-order proof.

A second actual Opus5.5 source-only review included the SQL and race tests, confirmed the fixes and found no blocker. Both reviews used17/18 bounded unchanged source copies and zero permission denials; final sources equal the follow-up copies. Claude ran no tests and qualified no funded/runtime/deployment behavior. Its non-blocking note remains: latest verified totals can accompany an earlier paged attempt list until manual reload; paging cursors remain original and progress never becomes execution authority. The clock/read bracketing relies on ordinary primary SQL consistency and is not a claim about a replicated deployment.

## Verification

**1,228 tests across67 files pass**, every assertion passed and runner exit0 with at most2workers. This is scoped Auto Sell/profile/journal/progress/API/UI/engine and imported/conditional regression, not the repository-wide suite. The new coverage includes41 pure progress cases,34 client transport/context/monotonic-prefix cases,11 component cases,23 actual storage/API cases and additional composed recovery tests. Earlier1,219-test pre-review run and one test with an incorrect expected error message are retained separately and not used as final-source proof. The final run includes all fixes.

Plain `tsc --noEmit`,12-file typed lint and13-file formatting pass. The actual native/Turso/local-D1 journal, packet and fence engine regressions pass. No schema changed, so no new migration was run beyond disposable browser fixture setup. All154 committed SQL files and the journal match source base.

Existing Chrome exercised the actual modal, clients, read APIs and production Turso adapter with synthetic auth against a disposable154-migration fixture. Exactly7 GETs, including2 complete progress reads, preserve the same original clocks, consumed key and0.001 charged tokens before/after reload. A second fixture owner sees no saved runs. Password remains empty, Run disabled, no console errors,1920/375px no horizontal document/progress overflow, progress button44px. Fixture retains1run/attempt/start/packet and0signing intents. Vault, runner, execution and external-provider paths are refusing modules. Own tab/server closed and viewport reset. No real production authentication or financial behavior is claimed.

Source comparison strips only the explicit progress mount and monotonic start-memory additions and proves the original recovery implementation otherwise equivalent.38 protected application/runtime/signing/layout files,154 prior SQL, the journal, original four unstaged AGENTS additions and seven frozen warmup drafts remain preserved. Claude PR57/59/60 application paths are untouched. No schema reservation; next0156 subject to fresh claim/journal checks, Claude0147 remains reserved.

## Still unfinished

The actual journal-bound scheduling lane needs source-qualified decisions and Counter lineage, durable control/resume consent, exact wallet/occurrence reservation before preparation, complete runtime provenance and receipt-bound settlement or provably unsigned closure. Ordinary submitted outcomes cannot count as finalized settlement. The projection cannot reconstruct historical events that were never recorded, and does not authorize a replacement, rotate wallets, rearm consumed rows or release held allowance.

No deployment, production build, application/hosted SQL, provider/credential/cron change, real wallet unlock/sign/send, strategy run or funded test occurred. Git deployment remains disabled. Full legitimate parity and read-only Jito qualification remain active.
