# Bundle: Codex, Claude and OpenCode

24 October 2026. Julian explicitly asked Codex to coordinate with the existing OpenCode Bundle session as well as Claude. This is a coordination checkpoint, not a deployment or a claim of complete Proxima parity.

## Verified starting point

Canonical checkout: `C:\Users\Julian\Desktop\Bundle`. Local and remote main were `488f6cf` when this coordination started. That includes the storage-environment checkpoint `573b684`, Auto Sell slippage checkpoint `4bed783`, and both recent Jito checkpoints. The six Jito type errors in the supplied OpenCode screenshot were from an earlier working state. The latest Jito checkpoint passed 849 focused tests across 42 files plus 19 harness tests, TypeScript, typed lint and formatting on an isolated source overlay. Do not rebuild or patch an already-fixed failure based on that screenshot.

OpenCode's existing Bundle session was matched through both its desktop tab and local CLI project/session metadata. Codex sent the handoff through the supported CLI to that exact session, preserving its selected model and permissions. No new session was created, no automatic permission approval was enabled, and the separate GMGN Trador session was left alone. OpenCode acknowledged: "Understood: read-only status and audit, no edits/staging/commits. Starting from verified git state and the three documents."

The current request is an audit and ownership proposal, not permission for overlapping edits. Its completed findings will be recorded separately; acknowledgement alone is not a completed review or test result. OpenCode's visible session history reports that it produced `6d611f9` (honest wallet readiness), `4bed783` (tighten-only Auto Sell slippage) and `573b684` (jsdom storage). Codex independently confirmed those commits are in main, but did not rerun the session's self-reported Node26 test totals in this coordination turn. Older notes attributing that parallel work to Claude should not be used as evidence of authorship merely because its documents have `CLAUDE-` filenames.

For future messages, use OpenCode's supported local CLI: list sessions in the canonical project with `session list --format json`, match the existing Bundle directory/session, then use `run --session <returned-id> --format json` with a focused prompt. Do not guess a session ID or send to the active GMGN tab. Do not add `--auto`, fork/start another session, override a model or interact with permission/security prompts. The installed CLI inspected today was `C:\Users\Julian\AppData\Roaming\ai.opencode.desktop\cli\2.1.4-x64\opencode-cli.exe`; rediscover it if that installation changes. Keep transcripts and transient session IDs in ignored local QA receipts, not this public handoff.

The native Git executable verified in this turn is `C:\Users\Julian\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe`. Use a verified executable if an agent's PATH lacks Git; do not install a second Git or treat PowerShell's `where` alias as a reliable executable lookup. No global PATH or Git settings were changed.

## Active split

| Agent    | Current area                                                                                                                             | Editing boundary                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | Jito raw simulation, assets, runtime qualification and recovery verification                                                             | `lib/jito-*`, `test/jito-*`, associated Jito tests, diagnostic component/API wiring and focused evidence notes. No changes to program pins merely to pass a sample.                                                                                                                                  |
| Claude   | Existing PR57 and its explicitly claimed UI/features                                                                                     | PR57 was OPEN at `ecdbb15aab4bb450e60d4375ecddc2714653fcc5` when inspected. Its file list includes venue launch/live views, portfolio, sniper guard, cleanup and chart-link work. This records ownership, not approval or a fresh code review. Read the actual current PR and claims before editing. |
| OpenCode | Read-only audit of wallet creation, legitimate funding/history warnings, launch review and recovery; status of its existing storage work | No editing claim is granted by this audit. It must propose one bounded area with exact paths checked against AGENTS and PR57. Its next implementation belongs on a separate branch/worktree from current origin/main, delivered through a PR.                                                        |

Protected shared layout files still need the existing exact-patch coordination. Existing ownership and pending PR review concerns are not waived by adding another agent. Do not assume another agent is idle or that old claims identify the latest code state.

## Common working rules

1. Read AGENTS, the active split note and this handoff; inspect current HEAD, index, working changes and the other agents' current PR paths.
2. Before editing, claim a bounded area with exact paths. Reading another agent's files for context is allowed; changing them requires coordination first.
3. Claude and OpenCode use their own branches/worktrees from origin/main. Do not switch canonical main's branch, manipulate its shared index, overwrite files, install dependencies into another agent's checkout or restart another agent's dev server.
4. Preserve the four original unstaged AGENTS additions and seven frozen warmup drafts, including the unregistered `0144_wallet_warmup_runtime_read_attempts.sql`. Do not stage, resume, delete, stash, reset or renumber them. Recheck the actual migration journal and reservations before any future migration work.
5. Verify on stable source and state the Node version and test scope. The primary package engine is Node24; Node26/jsdom compatibility work is a distinct test-environment concern. Do not change global Node, permissions or security settings to avoid a failing test.
6. Commit only owned changes, publish the exact hash and handoff, and use ordinary fast-forward pushes/PRs. Never force-push main or silently include another agent's dirty work.
7. A source commit, passing unit tests, a rendered mock, an unsigned provider observation and a funded final receipt are different kinds of evidence. Label them accurately. Main being pushed is not proof that a feature is live.

No deployment, hosted SQL, provider/credential/cron changes, real wallet unlock/sign/send, strategy run or funded trade is authorized by this coordination. Do not read or copy `.env`, wallet secrets or secret-bearing logs into an assistant handoff. Do not bypass a permission rejection. Future financial tests need Julian's separate approval for the specific action.

## Product acceptance priorities

- **Wallet creation and custody:** clear supported-chain selection, simple password flow, encrypted browser custody, explicit backup/export and a readable ready/not-ready status. Reuse the existing vault and recovery work.
- **Accurate history:** distinguish creation recorded by Bundle from observed on-chain activity. Show timestamps, provenance, unknowns and coverage. Time passing can make a wallet older; generated transactions do not establish independent ownership or justify an "aged" claim.
- **Funding warnings:** show actual known funding times, sources, proximity and relationships, with uncertainty visible. Keep the existing exact-gap warnings. Do not hide links or imply coordinated wallets are independent.
- **Supply and allocations:** show selected/team wallets, planned and observed allocations, amounts, fees, rent, quote assets and holder coverage clearly. A simulation is not acquired supply; missing coverage is not zero holdings.
- **Launch execution and recovery:** preserve explicit review and consent, browser-only signing, fee/minimum-output bounds, send-once behavior and conservative unknown-outcome recovery. Clearly show unsupported routes and disabled reasons.
- **Proof before claims:** qualify supported read-only profiles first. Do not promise landing, profitability, complete anonymity or market leadership from a test count.

The agreed product scope excludes artificial volume, wash-trading loops and manufactured wallet history intended to disguise coordinated ownership. Work on legitimate wallet management and transparent, user-approved launch tools.

## Current Jito release gate

Read `CODEX-JITO-RAW-RUNTIME-20261024.md/.json`. Full read-only qualification has not passed. The real public-reference unsigned SOL/USDC attempt captured a complete baseline and mint/Rent-before data, then refused changed Jupiter code and unlisted Tess under the unchanged policy. The initial code scan already reached original F+32. Both code-policy review and timing work remain. Do not add observed hashes or allow an executable by ID just to obtain a pass; do not widen the window or remove the final scan.

This handoff does not publish or deploy new application functionality. The latest production state has not been re-audited in this coordination turn.
