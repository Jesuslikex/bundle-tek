# Warmup preparation and control clarity, 21 October 2026

UI edit notice before source changes. Base `bbbbab2e483472f6e179134efd866d12ef472a81`. Codex owns the two warmup V2 components and their focused tests. Protected Claude parent/shell/token layout/global CSS remain untouched. No deployment, wallet or provider action.

Current source has a fourth preparation step labelled Runtime check unavailable although its child supports separate read-only runtime requests. Pause/Stop preserve pending action metadata, but the parent does not explain that an already reserved provider-check attempt may still count. The child also says those controls are above although its parent renders them below. Changes will correct the capability labels, add an accessible explanation and controlled-promise parent/child recovery regressions without altering existing consent checks or eligibility/request behavior.

Reference rechecked: https://docs.proxima.tools/wallets/generate-activity/ describes actual buy/sell loop execution, per-wallet progress/Tx/Volume and cancellation retaining completed trades. Bundle's saved review/read-only session is not that executing feature. Its UI must state the current first-action/read-only limit and keep execution unavailable until operational prerequisites are qualified. The private signed-in Proxima browser is not refreshed by this public documentation read.

## Implemented source changes

The fourth preparation step is now Read-only checks. The section identifies the first-pending-action scope and explicitly states that signing and execution remain unavailable. It does not present the configured loop count as a running buy/sell session or mark a runtime check as passed. The current-step highlight clears on client or server expiry, Pause, Stop and stale/invalidated source state.

Pause and Stop share a stable `useId` description explaining that a check which already reserved an attempt may still count and that the original request ID is needed to inspect saved status. That description remains visible after Stop. It does not imply another check is possible in a stopped session. Busy saved-history wording does not imply provider work, and the child no longer points to controls above it or promises controls exist in a stopped view.

These are presentation changes. Existing pre-return component statements were compared through the TypeScript printer: all 31 parent and 15 child statements are unchanged, excluding the parent's new `useId` binding. Request paths/bodies, consent and repeat requirements, eligibility, timers, reminder writes, cancellation and server/storage/financial rules are unchanged. No CSS or protected Claude file was edited.

## Regression evidence

The original five added checks failed against the old UI labels/direction wording. They did not establish five financial or cancellation bugs. Both original component files then passed 50 tests. The first broader cohort passed 307 tests in 18 files before the review refinements.

The first actual Opus 5.5 review found no high/medium production UI regression, but correctly identified swallowed assertions in a fetch stub and vacuous late-refusal assertions. Those tests were corrected before final verification. Captured method, ID, exact POST shape/mode and the reminder at POST entry are asserted outside component catches. Stale refusal produces no alert or stale-error text, while separate existing child tests cover valid stale-success admission. New actual-parent tests cover Pause/Stop × preview/runtime × ignored-abort late response/abort-aware rejection, preserve the exact original reminder, keep controls usable with their separate approval, ignore late results without stealing focus, and recover with an exact-ID GET and no second provider POST.

Additional tests cover each preparation stage, client expiry, server-expired history with a lagging client clock, and source invalidation via pagehide, receipt and storage events. One intermediate run had a test observation error: it checked the POST counter before asynchronous request preparation had reached fetch. Waiting for the captured request boundary corrected that test; the original report is retained, and no product deadline, cooldown or tolerance changed.

The final broader cohort passes **315 tests in 18 files, zero failures and zero skips**. Plain TypeScript, three-file type-aware lint and formatting checks pass. The React best-practices review checked stable IDs/aria associations, informational note semantics, existing effect/cancellation ownership and unchanged data-fetch paths; no new effect, listener, request or bundle dependency was introduced. These are source/DOM tests, not rendered signed-in browser or live provider evidence. Ordinary Chrome control remains unavailable from the preceding verified attempt, so no fresh rendered/keyboard/viewport claim is made.

## Review disposition

The actual Opus 5.5 follow-up found the earlier actionable issues resolved and no new high/medium issue within its stated scope. It ran no tests. Its remaining low observations do not establish a production defect: the unchecked button assertion is only a consent regression, and no-auto-request evidence comes from recorded fetch calls; late-refusal tests resolve the controlled promise and observe the aborted signal plus the next event-loop turn, while valid stale-success handling is covered by the separate child tests. The suggested possibility that the parser drops an expired pending action was checked independently: `warmupV2Journal` requires pending metadata for its begin-review receipt and returns the admitted journal unchanged. The introductory first-action description is a capability statement inside an explicitly gated preparation flow, not an authority grant before approval.

The reference and retained capture establish neither Bundle's live execution qualification nor general Proxima parity. Remaining work includes signed-in rendered/keyboard/viewport verification, live provider and program-policy qualification, exclusive financial reservation, short user authorization, exact receipt-driven action/budget progress and durable session orchestration. No deploy or funded test is part of this checkpoint.

## Delivery checks

The final isolated production build passed on the exact base plus the three functional overlays, with no environment files copied or deployment. All 2,349 selected frozen source files stayed unchanged through the final checks and build. The final functional files match the actual Opus follow-up copy exactly. The two read-only reviews copied 3,441 and 3,442 files, respectively, left both copies unchanged and had zero permission denials. No fallback model was used. See `CODEX-WARMUP-PREPARATION-CLARITY-EVIDENCE-20261021.json` for the portable evidence and retained local report paths.
