# Warmup session progress UI, 21 October 2026

Owned checkpoint `24f28d8` after `0164b7f`, followed by the independently verified review fixes below. This is saved history and metadata controls, not an automatic trading runner. The bounded UI/client claim is released after this follow-up.

## Behavior

- The existing owned saved session-approval panel mounts the new progress component. Mount performs an authenticated journal GET by consent ID, with no write or wallet request.
- Explicit Save history, Pause plan, Resume plan and Stop plan use the existing metadata-only API. Start automatic activity is disabled with a visible reason and no handler. No begin-review, preparation, signing or submission caller is added.
- A bounded strict client admission binds consent, terms, plan revision, exact approved action/wallet fields, original and effective finish deadlines, budgets and false authority flags. It rejects regressed progress and inconsistent phases. Requested control receipts bind the exact ID, operation, version and original predecessor hash. The server remains responsible for full authenticated event replay.
- Persist the small request marker before the only POST attempt. Lost responses, cancellation, timeout and context changes preserve recovery. Explicit GET recovery precedes a same-ID metadata retry; there is no automatic retry. Unknown outcomes stay prominent after Stop. A disappearing known journal cannot silently become a replacement history record.
- Counts show recorded actions. Wallet rows show recorded buy spending, recorded fees/rent and remaining fee budget, not live balances or invented volume. IDs remain in collapsed recovery details.
- Parent/child busy state is combined. Requests are bounded to 15 seconds and 64 KiB UTF-8 JSON. Late responses from an old approval or unmounted component are ignored. No raw provider/parser/HTML errors are displayed.

## Verification

- 669 tests across 26 related files passed together, including the real owned API/local SQL composition with synthetic providers and 58 client/component/parent tests. This is not the full repository suite or funded proof.
- Plain `tsc --noEmit --incremental false`, seven-file typed lint, eight-file formatting and `git diff --check` passed.
- Final isolated Next production build passed with base `0164b7f` plus the eight owned source overlays, without copying `.env.local` or provider credentials. Original and build-overlay hashes match. Ignored result: `work/release-qa/warmup-session-progress-build-final-20261021/result.json`. Next emitted the existing multiple-lockfile workspace warning.
- All 2705 frozen files remained unchanged through the final checks: digest `2743498ff8d28c420b33b7dd8315d165d63a6fdee0e20ae611633a4a89edf128`. This snapshot precedes this documentation-only addition.
- Actual component/CSS synthetic Chrome checks: desktop initial state, 375px and 320px no sideways overflow, 44px product controls at 375px, lost history reply recovered by GET without a second POST, Pause display, and recovery/mount through the saved-approval parent. Final 320px screenshot retained privately under `work/warmup-progress-browser-20261021/progress-320.png`.
- The attempted 1440px override did not take effect, so that width is unverified. Viewport reset returned successfully; actual restoration dimensions were not remeasured. The disposable QA tab was closed and the identity-checked QA server stopped. User tabs were preserved.

## Evidence limits and next work

The authorized existing Chrome Proxima tab is accessible again. Its UI currently reports a successful 40-minute session with two wallets and four transactions each. This is visible UI evidence only, not on-chain verification or backend/signing knowledge. Private wallet addresses and balances are not published here. REA's separate debugging endpoint has not been refreshed by this check.

No actual signed-in Bundle/provider/funded qualification is claimed for this new panel. No migration bytes changed; journal still ends at 0131. No application or hosted SQL, provider/credential/cron change, protected shell/layout/global CSS edit, deployment, real wallet unlock/sign/send or funded trade occurred.

Remaining before automatic sessions: real owned per-action preparation API/callback and client review, appropriate fresh action qualification rather than extending the old 60-second preview, shared wallet/lot reservations, short authorization, browser-only signing, one-send recovery and multi-wallet orchestration. Preserve every current freshness, custody and signing safeguard.

## Completed Opus 5.5 review and follow-up

Actual installed CLI review of committed `24f28d8bf167b350e4321b8ae2c85d98ef5fa29b` completed successfully. Requested, selected and every actual model were `claude-opus-5-5`; only Read/Glob/Grep were available. Zero permission denials, edits or test execution. All 2641 copied source files remained unchanged. Private ignored evidence: `work/release-qa/opus-progress-ui-review-24f28d8-20261021/status.json` and `review.jsonl`. The reviewer found no blockers, with two medium UX recommendations and optional low polish. It read client/API/public/replay/digest code, parts of storage/sequence and only test titles; it did not execute or independently confirm Codex's tests/browser checks.

Accepted and independently fixed:

- Unknown outcomes now have a prominent alert saying a trade may already have been sent; other pending states are named. Stop never hides the unknown outcome.
- Stop requires a separate confirmation bound to the currently displayed journal head. Keep plan cancels without a POST; refreshing clears confirmation. Confirmation uses a native fieldset, caught and corrected by typed accessibility lint.
- History markers must read back exactly before any POST. A recovered different unique root ID is identified honestly rather than crediting the missing original save.
- Waiting shows the scheduled review time. Closed windows do not claim review availability. Review deadlines show date and time; Stop/complete labels match the server's priority. Control success messages name Pause/Resume/Stop.
- The section exposes `aria-busy`, and native recovery-details disclosure markers remain visible.

Final follow-up: 61 tests across the three affected client/component/parent files pass, including three new cases for cancelled/stale Stop confirmation, failed marker read-back and waiting/closed-window guidance. Plain TypeScript and two-file typed lint pass with explicit failure checks; final formatting/diff checks pass. The earlier 669/26 run remains the broader checkpoint result, not a rerun of every file after these UI-only changes.

The follow-up isolated production build passed with unchanged source overlays (`work/release-qa/warmup-session-progress-build-reviewed-20261021/result.json`), and its 2705-file freeze matched digest `f9cf0951982e256d8a2b10f1ed940b7bf6f3effa70d42905161d57d3c7925d65`. That build precedes the final div-to-fieldset semantic correction and its test assertion; those final two edits passed the TypeScript/lint/61-test checks above, without another full build. The browser disconnected during the follow-up visual attempt; the new confirmation/alert has no fresh rendered verification. Both disposable QA tabs were closed, both identity-checked servers stopped, and user tabs preserved.

The follow-up was Codex-verified, not rereviewed by Opus. Optional conservative invalidation on unrelated storage events and equivalent consent-object replacement remains; no current caller was found to replace a saved consent object during a request. These events withhold activity and require recovery rather than granting authority. No signing, provider, SQL or deployment behavior changed.
