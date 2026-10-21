# Warmup unresolved signing-intent fallback, 21 October 2026

Source overlay on `3d51220b1d2d32976d4328cf796980ce07269456`. This is a read-only runtime prerequisite checkpoint, not an executing warmup session, a financial reservation or a signing authorization.

## Diagnosis and scope

The unchanged 0134 attempt-context view already excludes selected wallets with shared swap or execution reservations. Properly installed signing writes create shared holds through the existing triggers. Normal imported/Auto Sell and manual warmup signing were therefore already protected. The initial expression-only audit overlooked the surrounding view; its broader missing-reservation diagnosis was corrected before this checkpoint.

The added two OR EXISTS clauses refuse unresolved imported/manual warmup signing intents for the exact owner and selected wallet even if a reservation is missing, as can occur in legacy or inconsistent read state. Awaiting-signature, signed and submitted states remain busy regardless of an old document timestamp. Finalized, failed and cancelled records do not trigger this fallback. Other owners and unselected wallets do not block the request.

The common expression already runs at runtime preflight, the atomic lease INSERT SELECT and provider context rechecks. These callers, ordinary preview behavior, same-ID recovery, signing/execution gates and all migrations remain unchanged. Missing required runtime schema fails closed. Existing shared holds still invalidate the view; the post-provider result in that case can be unavailable rather than a newly published provider-refused outcome. No runtime observation is published after the tested conflict.

## Verification and fixtures

The new test file separates active-intent projections from the existing shared-reservation view protection. It covers active and terminal state/owner/wallet matrices, preflight without consuming attempt/purpose/cooldown or invoking a provider, a conflict injected at the actual lease batch with rollback, conflict during provider work without runtime publication, and same-ID recovery without another provider factory call. Both swap and execution holds are exercised through the actual context view. Runtime missing-schema refusal and ordinary-preview independence from orphan intents are distinct cases.

Minimal read projections intentionally do not reproduce a signing lifecycle. The runtime fixture uses the real 0045 warmup table. An additional disposable native SQLite database applies every committed migration, then checks both positive intent projections against the actual tables. Only in that in-memory fixture, intent-table write triggers are removed to seed explicit inconsistent orphans; real schema constraints remain, shared holds stay empty, reads leave the seeded records unchanged, and deleting the fixture row clears the advisory. This is not production SQL, a migration edit or normal signing/write-path proof.

The retained initial reports include incorrect reservation expectations and an incorrect missing-warmup-table preview expectation. Dropping that table also removes an existing required isolation trigger, so ordinary preview correctly refuses. The final preview tests retain the table and insert orphan intents instead. Those earlier failures are not counted as separate product defects.

## Actual Opus 5.5 review

A pinned `claude-opus-5-5` CLI reviewed a secret-free source copy using only Read/Glob/Grep. No fallback model, tests, edits, network, wallet/provider action or permission bypass was used. It identified the same new-test mistake, found no critical/high runtime regression, and checked the owner/state/view/caller/recovery semantics. Its predicted refusal location differed from the observed failure: the actual missing-table case stopped at the installed-trigger count before lease creation. Codex independently reproduced and corrected the test.

The review also requested a positive check against the real imported-intent schema; the final disposable migrated-table regression addresses that gap. Final test changes were independently checked after the review; the production expression and fixture projection were unchanged. Its low performance note remains: imported signing intents lack an owner/wallet active-state index, so the fallback can scan an owner's history per selected wallet. No immutable migration was rewritten or unmeasured index change added.

## Operational limits

Chrome inventory control timed out again after Julian confirmed the extension connection. No Chrome restart, profile switch or interaction with the running Proxima warmup was attempted. Rendered signed-in verification therefore remains open.

No protected Claude UI/shell/layout/global CSS, financial evaluator, authorization, executor, API, application/hosted SQL, provider/credentials/cron, real wallet or deployment changed. Warmup runtime reads remain observations of the bounded first action, with signing, execution and automatic execution false. Full live provider qualification, exclusive financial reservation, short signing authorization, settlement-driven progress, durable orchestration and qualified alternative routing remain separate open prerequisites.

## Final source checks

On the final unchanged functional overlay, the combined 14-file regression cohort passed 273 tests with zero failures. Three opt-in real-database-clock waits were skipped because `BUNDLE_WARMUP_DB_CLOCK_QA` was unset: capture/lease expiry, the three-attempt cooldown cap, and expired runtime observation recovery. This pass is not a fresh run of those slow clock scenarios or the entire repository suite. Plain `tsc --noEmit`, three-file type-aware lint and formatting checks pass. All 136 migrations apply in disposable native SQLite through the tests, with no application or hosted migration.

The final isolated production build passed on the exact base plus three functional overlays, without environment files or deployment. All 2,348 selected frozen source files remained unchanged through the final tests, TypeScript/lint/format checks and build. The actual Opus review copied 3,437 secret-free files and left them unchanged, with zero permission denials and only Read/Glob/Grep. Only the final test file differs from that reviewed copy; its corrections and actual-schema positive coverage were verified by Codex in the final cohort, plain TypeScript, lint and build. See `CODEX-WARMUP-ORPHAN-INTENT-GUARD-EVIDENCE-20261021.json` for the portable receipt and retained local report paths.
