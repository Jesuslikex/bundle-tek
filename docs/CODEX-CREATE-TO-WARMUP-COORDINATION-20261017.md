# Create wallet to warmup: coordinated verification

The user explicitly requested coordination between this chat and the active Bundle chat, Review current progress (01a14bd5-064e-73b2-afda-7daadb2855e7), to finish the simple wallet-to-warmup flow without overlapping edits, funded trades or deployment.

## Ownership

The other chat retained browser-wallet-vault.tsx, wallet-workspace.tsx, its onboarding CSS/tests, local HTTPS launcher/guard/tests and onboarding/HTTPS notes. It owns the shared production build/server and the user's password handoff. This chat retained wallet-warmup.tsx and warmup-cycle-workflow.test.tsx. No onboarding file or HTTPS process was edited or restarted here. Both chats explicitly agreed to this split by direct messages. While the owner had its files staged, this chat waited and did not use the shared index.

## Warmup landing change

The screen now explains the order: check wallet history, choose tokens, review a plan. An unfunded wallet can still be inspected and its plan saved. Saving does not fund it or start trades. A zero native-balance observation explains that swap input, network fees and account rent need coverage, and directs the user to preflight after saving. No automatic funding, extra provider call, scheduler, signing or submission is introduced. Balance and execution acceptance rules remain unchanged.

The new mounted regression renders the actual entry panel, explicitly requests fixture history with zero balance and zero sampled signatures, checks the guidance and disabled unreviewed Save action, and asserts no unlock, sign, register or submit call. It does not infer wallet creation age or readiness from an empty sample.

## Verification

- Node 24.19.0: seven relevant source files / 70 tests passed together, work/** excluded. Selection: warmup-cycle-workflow, warmup-read-panels, wallet-warmup-plans, wallet-warmup model/preflight/history, and warmup-swap-quote.
- After a test-only TypeScript annotation cleanup, the full mounted workflow file passed again: 12 tests. Scoped typed Oxlint and formatting pass. A temporary missing annotation brace was corrected before the final passing run.
- After the owner completed its production build and restarted HTTPS, an independent Chrome tab confirmed signed-in app -> My wallets -> Create wallet. The final dialog shows Wallet password, Confirm password, Create wallet, collapsed Restore and the encryption/backup guidance. Both password fields remained empty. Screenshot: ignored work/release-qa/create-wallet-password-final.png. The duplicate QA tab was closed, preserving the owner's password handoff tab. No new wallet or password was created by this chat.
- Previous wallet-free real provider checks in CODEX-WARMUP-REAL-READS-20261017.md remain a separate result. They do not prove authenticated generated-wallet history, preflight, storage, preparation or funded execution.

The user must enter and submit their own wallet password in the final creation screen. That handoff is required for a new credential; do not choose a password, read it or paste it into chat. Until the user completes creation, real generated-wallet warmup inspection is pending. No complete signed-in end-to-end or funded-success claim is made. No push, deployment, provider/credential setting, remote migration or trade occurred in this task.

The owner committed its nine onboarding/HTTPS files separately as 4160215, Simplify wallet creation and hand off directly to warmup. This task waited until that commit left the index empty, then staged only its two warmup files and this note.
