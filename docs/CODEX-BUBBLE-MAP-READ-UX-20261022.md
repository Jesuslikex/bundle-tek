# Bubble Map read progress and recovery UX

22 October 2026. Source base `b5d3c773d26e265760b37e26894b06163b4edf43`.

## Connected user flow

The previous client could select 32 wallets but immediately POST its second group of 20-or-fewer into the unchanged ten-second owner gate. The new explicit Map funding links action performs at most two groups, waiting ten seconds AFTER the previous response before requesting the next. No retry or mount fetch is introduced. Reading/waiting/completed counts are visible, and Cancel remains available with 44px buttons. Cancelling the local request does not guarantee that provider work already received has stopped.

The active source key includes the holder amounts, team addresses and supply. A committed change remounts the local read scope; layout cleanup aborts the old request before paint. Returning A-to-B-to-A cannot revive A's old map. Cancel clears the controller immediately, suppresses late results and restores focus to the start button. Error and cancellation messages explain the ten-second cooldown. A new explicit check gets a new controller.

The panel discloses its existing 32-wallet cap and unchecked count, plus included valid team count. Invalid or duplicate input entries are excluded and counted; conflicting duplicate holder amounts disable reads with an explanation instead of choosing a balance. Unchecked team wallets do not produce a misleading zero-percent team-link claim. A positive integer total supply is required before provider reads; absent/zero/invalid supply disables the action with an explanation. No protected parent, token layout or provider/schema code was changed.

The client admits only exact mainnet responses containing precisely the requested keys, valid native evidence shapes and explicit unknown reasons. It reuses the existing cancellable one-MiB JSON reader. HTML/parser/provider details never appear in an error. The browser does not override server-validated evidence time with its own potentially inaccurate device clock. Server future-time checks and all financial/runtime Clock rules remain unchanged.

Unknown funding reasons are available in native expandable details with full public address text and wrapping, including long history, no returned history and missing/unsupported/ambiguous oldest evidence. This is bounded provider history, not first-funding completeness or common ownership proof.

A failed second group produces no partial map. Its error states how many wallets were read and that starting a new check reads all selected wallets again; there is no implicit resume or retry. New checks are explicit and can consume provider reads again. Already-started RPC transport is not cancelled server-side. Existing totals and history caps remain; complete all-holder graph coverage still needs separate work.

## Verification

79 tests pass, zero failures/skips, in eleven related files. These include the new finite client, real production API handler with controlled auth/RPC and the unchanged gate (32 wallets in two requests), parser/history regressions, JSON body bounds, actual panel/Cancel/focus/context remounts and the existing red saved-funding indicator/server/API/table cases. The handler test simulates provider and DB gate behavior; it is not production database, provider or funded qualification.

Plain TypeScript, five-file typed lint and six-file formatting pass. Initial lint issues (semantic status element and a test-only Header spread) were corrected. A later test-only DOM `append` type collision with existing Cloudflare global types caused the first build to fail its TypeScript phase; it was corrected to the repository's `appendChild` pattern. Failed evidence is retained; final results are recorded in the sibling portable evidence. The final guarded-source isolated production build passes, all six overlay hashes remain unchanged, and no environment files were copied. The intervening pre-guard build also passed but does not qualify the final low-severity follow-up by itself.

Actual Opus5.5 reviewed a twelve-file source-only snapshot read-only with Read/Glob/Grep, zero denials and unchanged copies. It ran no tests. Codex verified its findings and corrected unsampled-team zero claims, input admission, local-device-clock rejection and discarded-earlier-group disclosure, with focused regressions. A second actual Opus5.5 review confirmed no material regressions, twelve unchanged copies and zero denials. Its two low findings, cooldown wording and invalid-supply preflight, were independently corrected and tested afterwards, not rereviewed. It could not inspect the protected parent; Codex separately verified its existing project/revision/team key and observation-time child key without editing either. Full product parity was not requested of this focused reviewer and is not established by this checkpoint.

Existing Chrome inventory timed out after thirty seconds, so no new rendered desktop/mobile or signed-in app check is claimed and no alternative browser was launched. DOM tests are not rendered browser verification. No live provider request was made for this checkpoint.

No deploy, application/hosted SQL write, migration, provider/credential/cron change, real wallet unlock/sign/send, strategy run or funded test. Git publishing shares source only. Full Proxima parity, external first-funding coverage and warmup execution remain open.

Ignored evidence: `work/release-qa/bubble-map-read-ux-final-guarded-20261022.json`, `opus-bubble-map-read-ux[-followup]-20261022/`, and the first/pre-guard/guarded isolated build folders. No environment files are copied into builds or reviewer snapshots.

## Public reference refresh

Official Proxima docs checked again on 22 October: [Live Workspace](https://docs.proxima.tools/live-settings/overview/) includes wallet/holder/history/Bubble Map views, while [Marketplace](https://docs.proxima.tools/wallets/marketplace/) describes funding age/source/gap filters and spacing against existing folders, with a greater-than-thirty-minute gap recommendation. These are documented product semantics; they do not establish its backend logic or complete live UI parity. Bundle's existing under-thirty-minute saved-event warning remains a bounded receipt comparison, not a marketplace checkout, full-history scan or guarantee about clusters.
