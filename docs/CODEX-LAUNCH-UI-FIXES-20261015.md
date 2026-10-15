# Codex launch UI work, 15 October 2026

Implementing the six fixes in Claude's UI split note. Owned edits: pump-launch-history, pump-launch-review, pump-holder-launch-review and their tests; a dedicated launch CSS module; additive saved timestamps in pump-launch-history-page and its tests if needed. No Claude-owned UI files or shared CSS rewrites. Review opening uses existing validation and clears consent; no automatic signing/broadcast or changes to their guards. Local verification and commit only.

## Implementation update

All six requested fixes are implemented in the owned launch components:

- History loads the three first pages on mount, combines them newest first, and shows human state labels, saved dates, shortened Solscan links and explicit clipboard feedback. The paged server response adds only its existing created_at timestamp; recovery retains that date.
- Open saved review selects the exact source and record, moves focus to the review, validates it through the existing parser and clears every consent. Switching project/draft/release remounts the selection. Saved create-only versus developer-buy mode must also match the current plan, preserving the previous plan-derived signing restriction. Opening does not send a transaction action.
- Read current holder targets keeps its original disabled predicate and explains every missing requirement through accessible associated text.
- File selection now stages an encrypted backup. Restore requires both the selected file and passphrase and an explicit click. The existing size check, project parser, unlock, session clearing, persistence and backup acknowledgment remain in place. Both create/developer and holder screens use this order.
- Holder steps show current/completed/upcoming state and keep missing local backup or limit prerequisites visible when reopening a review. Cancelled unsigned reviews do not imply completed signing or broadcast.
- All static inline layouts in these three screens now use the scoped pump-launch-ui.module.css. Claude-owned files and shared CSS were not edited. Claude's 4c1fafc stats-strip commit was fast-forwarded into this branch without overlap.

## Verification

- Seven targeted files: 61 tests passed, including the three signing libraries, actual local-SQL paged history route tests and the three UI suites. New UI checks cover automatic reads, ordering, links/copy, exact saved-review opening, disabled explanations, file-before-passphrase restoration and unchecked signing consent. RPC/signing in component tests is controlled; no real wallet is signed.
- Final TypeScript check passed. Eight-file typed lint passed without disabling rules. React review completed: cancellable mount timers, Effect Events for latest effect callbacks, stable row identity, parallel history reads, accessible progress/focus/reasons and scoped responsive layout.
- Production build passed through final page generation and build tracing (Next.js webpack, exit 0).
- No rendered browser verification: no local preview was listening. An earlier automatic approval review rejected the temporary local production-server launch; this task did not retry or bypass it.
- No push, deployment, hosted SQL, provider/credential changes, cron, signing or submission. Preserve main's unrelated dirty Jito note and migration 0068.
