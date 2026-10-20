# Activity and Auto Sell checkpoint, 20 October 2026

Julian transferred bounded warmup and Auto Sell ownership to Codex while Claude is out of credits. Base: `3143bfa`. No deployment, hosted SQL, provider change or funded action.

## Fixed

Auto Sell could start after an asynchronous vault unlock completed following component unmount. A synthetic component test reproduced the failure before the fix. Each unlock now belongs to a mounted run epoch. Leaving, pagehide, cancelling the unlock, changing project revision/token, changing wallet roster/revisions or locking the workspace invalidates it. A late session is erased and its acquired browser lock released. A successful current run still starts normally; Stop clears the browser session. Closing the configuration dialog intentionally does not stop an already running strategy.

Warmup estimates now refuse invalid wallet/cycle counts, zero input and out-of-range or fractional delays. Unavailable estimates no longer misleadingly display zero cost and duration. Existing exact saved range amounts, per-wallet budgets and all transaction safeguards remain unchanged.

## Verification

- 31 focused Vitest files, 281 tests passed with external Node network calls blocked; synthetic providers only.
- Seven lifecycle cases cover late unmount, pagehide, cancel, project/wallet/lock changes, and a current run followed by Stop. No actual key, signature or send.
- Plain TypeScript and five-file typed lint/format pass.
- Isolated production webpack build at `3143bfa` plus these five source/test overlays passed. Source hashes were unchanged before/after the build. Result: ignored `work/release-qa/activity-autosell-build-20261020/result.json`.
- Existing Chrome rendered the actual components in an isolated Vite harness. The synthetic pending unlock shows Cancel unlock; cancellation clears the password and restores a disabled Run button. Harness unlock never resolves and cannot sign or send.

## Live comparison and remaining work

Read Proxima's signed-in My Wallets -> Generate Activity screen without pressing Start. It has fixed/range input, loop count, minute/second delay, alternative routing, wallet count, required balance, estimated duration and wallet/Tx/volume progress. Our matching amount/delay/budget controls exist, but the current screen is a longer draft wizard. Next: compact Generate Activity presentation, then Auto Sell presentation and settings comparison, each separately verified.

Warmup still requires separate approval per transaction and is not an automatic activity session. Alternative Axiom routing is not implemented. Auto Sell is an explicitly approved browser-tab session, not a durable background service. Do not imply full execution parity or funded proof from these checks. No stock signing gate or approval rule changed.
