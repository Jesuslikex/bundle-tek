# Generate Activity: first UI step

Source checkpoint after `67f0763`. Julian asked for Generate Activity and Auto Sell one by one, matching Proxima. Codex owns the work while Claude is out of credits.

## Current live reference

Inspected Proxima's signed-in My Wallets -> Generate Activity, then an existing live token -> Auto Sell -> Advanced Options. No Start, Run, wallet unlock or transaction action was taken in Proxima.

Generate Activity uses a compact centered dialog with Fixed/Range input, loop count, minute/second delay, alternative routing, wallet count, required amount, estimated duration, Start, and a wallet/Tx/volume table. Auto Sell has Counter, DCA and Limit Orders, per-strategy range/end/whitelist controls and session-wide start delay, slippage, wallet selection and max-amount/duration ends.

## This UI change

The former inline warmup wizard is now a native modal dialog titled Generate Activity. Native modality keeps focus inside the dialog and Escape follows the same close callback. Amount modes, loop count, delay and budget strip stay together. Public history, trading token entry, fee/start settings and saved-plan/recovery controls are secondary sections. Review opens saved-plan controls; validation reveals every ancestor section before focusing an invalid field. The review button remains accessible while scrolling.

Planning, exact range draws, saved-document admission, recovery, approval and signing behavior are unchanged. The button says Review warmup plan, not Start: saving is not automatic execution. Direct routing is disclosed; an unimplemented alternative-routing checkbox was not added.

## Verification

- 32 related test files, 286 tests passed offline, including workspace mount, history cancellation, exact saves, signing/receipts, Auto Sell and native dialog cancellation.
- Final two-file typed lint/format and plain TypeScript pass.
- Isolated production webpack build at `67f0763` plus these three UI/test files passed, with unchanged source hashes. Result: ignored `work/release-qa/activity-dialog-build-20261020/result.json`.
- Existing Chrome rendered the actual components against synthetic fixtures. Desktop modal, token selection/collapse and retained review action verified. Screenshot: ignored `work/activity-autosell-browser-20261020/activity-desktop.jpg`.
- A requested 375px viewport override did not affect the observed page (it remained 1920px); therefore mobile rendered QA is not claimed. The override was reset.

## Next steps and limits

Generate Activity is closer in presentation, not full execution parity. Automatic warmup sessions, alternative platform routing and an aggregate wallet/Tx/volume session table remain unimplemented. Existing per-swap approval and receipt recovery are retained. Auto Sell still lacks session-wide start delay, user-selected slippage and whole-session end conditions. Do not treat per-strategy end conditions as equivalent to a shared cap. Durable background execution and funded mainnet proof remain unverified.

Next bounded step: native keyboard/modal handling for Auto Sell, then implement and test session-wide controls in the runner before displaying them as working settings. Never weaken minimum-output or custody checks to match Proxima's defaults.

No deploy, hosted SQL, credentials/provider/cron changes or funded actions.
