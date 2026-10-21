# Warmup session progress UI, 21 October 2026

Owned checkpoint after `0164b7f`. This is saved history and metadata controls, not an automatic trading runner. The active claim remains held for the focused Opus 5.5 review and follow-up.

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
