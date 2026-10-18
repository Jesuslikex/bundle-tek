# Claude: continue Bundle here

18 October 2026. Julian requested all progress on GitHub so Claude can continue while Codex usage is limited. Canonical repo: C:/Users/Julian/Desktop/Bundle. Remote: https://github.com/Jesuslikex/bundle-tek. Main at handoff preparation: ec738e64cd2e3fe0fc05bc41aa39223bc1e6302b. Fetch again before starting. Read AGENTS.md and docs/CODEX-CLAUDE-SHARED-HANDOFF-20261018.md. Claude uses a new branch from origin/main and delivers PRs; preserve other branches, worktrees and local drafts. Never force-push main.

## Published work

- ec738e6:50-row wallet roster paging, exact observed native sorting, explicit cross-page selection up to100 and page-only unselected refresh.10tests/3files, scoped typed lint/format, final isolated TypeScript and synthetic Chrome1440/375/320 pass. See CODEX-WALLET-ROSTER-PAGING-20261018.md.
- 5c7d190: Smoke's existing chat confirmed ChangeNOW key is in Smoke Swap Beta server hosting settings, not a local secret file. No key copied. See CODEX-SMOKE-CHANGENOW-HANDOFF-20261018.md. Fresh Bundle quote qualification remains blocked on secure provider access; do not use the public Smoke quote as a substitute for Bundle's provider contract test.
- 337a5bf: production exchange quote fetch and body share a15-second deadline,64KiB limit and exact numeric SOL token decoding.104tests/6files plus6native qualifier tests and typed lint/format pass. See CODEX-EXACT-EXCHANGE-QUOTE-20261018.md.
- 897b183: replayable finalized sale receipt evidence, separately implemented/verified by the other Bundle chat. Read its report before touching acquisition/accounting work.
- 0008fb8: role/address filters and paging for launch budget review.67tests/4files, scoped checks and responsive synthetic Chrome. See CODEX-LAUNCH-BUDGET-REVIEW-FILTERS-20261018.md.
- b4a1ed7: bounded/cancellable holder-history reads and safe response errors.39relatedtests plus TypeScript/typed lint.
- ba41f71: saved launch buy-cost API/mobile review and recovery; owner's62tests, build and browser evidence in CODEX-ACCOUNT-BUY-COST-UI-20261018.md.

These are distinct checkpoints with overlapping validation. Do not add their test counts or call them one full green release. Screenshots in docs/qa/20261018 are synthetic component/workspace proofs, not signed-in production or funded execution. Earlier funding, wallet warmup, DCA, Volume, marketplace, stock, holder and launch-layer work is in main; CODEX-PROXIMA-COMPLETION-MATRIX.md retains the broader gaps and historical evidence.

## Running full regression: do not restart

A separate immutable local clone runs committed0008fb8, not later main. Location: work/release-qa/committed-parity-0008fb8-20261018. Its work/release-qa/full-suite-committed-0008fb8-20261018.* files contain log, JSON and eventual exit/source verification evidence. Runner PID44564; current Vitest PID29544; Codex exec handle21427. At21:02:53UTC,51/603files finished, no failures recorded, still running. Recheck actual processes and original files before declaring completion. Runner then executes native script tests and source/harness verification. A finished Vitest PID alone does not establish the wrapper/native stage ended. Never overwrite/restart the same attempt on an observation timeout. No environment files were copied; external unmocked Node fetch/socket calls are blocked while loopback fixtures are allowed. This is not a system-wide network-isolation claim.

## Release and remaining boundaries

No deployment, hosted migrations, provider/credential/cron changes, funded test, real wallet unlock, signing or submission is authorized by this handoff. Git-triggered deployment is disabled in vercel.json. Do not push pulseforge-legacy or CROP. Stock signing remains off; preserve32-slot, custody, Clock, code-scan, minimum-output and all consent gates. Schema numbering must be rechecked against both current main and any WIP draft;0116 is reserved for the other chat's sale-allocation work, not free.

Core incomplete items include live exchange qualification and separately approved order/deposit/distribution integration, staged Front/Back execution, funded recovery proof, complete wallet activity/P&L accounting, supplier-backed marketplace purchase/delivery and repeatable stock qualification. Do not replace missing evidence with display totals or enable gates to make a screen look complete.

The unfinished sale-allocation draft is published separately at origin/codex/wip-sale-allocation-20261018, commit9ab3725c96baea6e610c712d3a970472daf29428 (parentec738e6). It contains12draft paths plus its WIP warning and is explicitly UNVERIFIED. Main's real index/checkout were not changed by the temporary-index snapshot; original draft files remain locally. Do not switch or clean the dirty canonical checkout. Inspect this branch in a separate worktree and verify it before any PR/merge. Migration0116 is draft-only there. No credentials or real private browser captures belong in Git.
