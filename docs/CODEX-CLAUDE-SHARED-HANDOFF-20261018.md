# Shared Bundle integration handoff

18 October 2026. This refresh reconciles the completed workspace, layer and preference work with the latest coordination rules. Historical test and release reports retain their original scope.

## One integration baseline

The canonical checkout is `C:\Users\Julian\Desktop\Bundle`, local `main`. The complete regression ran at `08ca7c2`. Its test-only readiness fix and report are committed as `1a99360`. At that checkpoint the local `origin/main` reference was `ea0a120`, 80 commits behind. These are local Git references, not fresh GitHub or production verification. No fetch, push, deployment or hosted SQL was performed for this reconciliation.

The current coordination and claims record is `AGENTS.md`. Preserve its user-authored uncommitted update, including the other Bundle chat's account-session claim. Codex works on local main. Claude starts branches from `origin/main` and delivers PRs; Claude does not commit into this main checkout. Never force-push main, rewrite published history, or remove another agent's branch/worktree. A PR based on the older remote must be reconciled with current local main without reintroducing superseded code.

All `drizzle/**` and `db/**` changes are reserved for Codex. The local journal ends at `0112_trade_preset_keyboard`; the next number at this checkpoint is **0113**. Recheck the journal and claim the number in AGENTS before writing it. Never edit, rename or renumber an already-committed migration.

Shell/layout protection remains: `app/page.tsx` and protected layout changes need the agreed approved exact patch. Earlier bounded approvals do not authorize new layout changes. Coordinate the shared index, build and helper; stage explicit owned paths or hunks and preserve concurrent edits.

## Integrated work and active ownership

Claude's earlier UI commit `9f95a1a` was copied into integration commit `353f762`. The five integration paths matched between those two commits; the different commit identity does not mean the work was lost. Later legitimate changes mean today's files need not equal that old worktree. Do not merge the stale UI branch again as a shortcut.

This REA/Codex chat completed the persistent chart/wallet workspace (`2a8997d`), retained launch-layer history (`6896fc3`) and saved native SOL versus declared layer ceilings (`016ed6a`). Their reports distinguish actual signed-in local layout checks from synthetic component fixtures and historical observations. They add no new funding/execution authority. The next owned implementation is funding editor request and unknown-save recovery under `components/launch/**`. Its initial audit is ignored `work/release-qa/funding-editor-recovery-audit-20261018.md`; the source fix is not implemented yet.

The other Bundle chat, **Review current progress**, completed held strategy previews (`9d0a9c9`), account amount preferences (`a00d9fe`) and explicit focused preset keys (`73baa62`, acceptance note `08ca7c2`). It now owns the account-session scope recorded in AGENTS: `components/bundle-account.tsx`, new `components/account-sessions*`, `lib/account-sessions*`, `app/api/account-sessions/**` and their tests. Its initial audit is ignored `work/release-qa/account-session-audit-20261018.md`. It may resume that separate source work after the completed freeze, coordinating test/build/index use. No password policy, provider, credential or schema change is included in that claim.

## Verification and next combined run

The older corrected baseline of 565 files and 4,971 tests predates these newer features. Separate feature reports retain their exact focused counts; overlapping runs must not be added together or called a full-source pass.

The new combined offline run finished with **one failure**: 572 Vitest files, 5,026 tests, 5,025 passed; all 35 native tests in eight script files passed. There were zero unhandled errors. All 1,784 frozen source/configuration hashes and harness hashes stayed unchanged, HEAD stayed at the captured commit, and the index stayed empty. The user's AGENTS edit is outside the application snapshot and was preserved. Original failed evidence remains under `work/release-qa/full-suite-integrated-20261018`.

The sole failure was a one-second readiness assertion for the real lazy-loaded Front/Back planner. Commit `1a99360` replaces polling with React `act` plus Vitest's dynamic-import completion API. All 69 tests across eight related files passed together afterward, with scoped type-aware lint and formatting. No production code changed. Read `CODEX-INTEGRATED-REGRESSION-20261018.md` for commands, artifacts and limits. A new combined full-source green run is still required after the separately owned changes are ready. This focused pass does not erase the failed original run.

## Claude contact and release boundary

The original Claude CLI UI author was last contacted with explicit `claude-opus-5-5`, tools disabled and no fallback; it returned the weekly limit resetting 22 October at 07:00 Europe/London. No acknowledgement or review was obtained. No Haiku fallback was used. That result does not establish every independent Claude Desktop session's state.

The approved REA debugging endpoint was last unreachable; the funding audit claims no new live Proxima capture. Fresh public primary documentation is separate evidence. No debugging-browser launch workaround was attempted.

The completion matrix remains the feature-gap record. Offline tests and layout checks do not establish funded Jito/launch execution, provider reliability, full holder coverage, audited P&L, stock qualification, marketplace fulfillment or complete Proxima parity. Older production release records are not fresh deployment checks.

This reconciliation authorizes no push, deployment, hosted SQL, provider/credential/cron change, real wallet unlock/sign/send or funded transaction. Stock signing and all consent gates remain unchanged.
