# Warmup identity reads through the configured provider

22 October 2026. Base `3bb015f547a69aab442f777f12fc4b60602bcffa`.

Warmup balances used `SOLANA_MAINNET_RPC_URL`, but token identity always used the public reader in `token-import.ts`. A configured provider could therefore supply balances while identity remained unavailable. This was confirmed from source, not a measured production outage.

The new per-preflight adapter sends the existing decoder's fixed account reads through the configured mainnet endpoint. It captures that endpoint once, shares one genesis check among its token inspections, applies the existing wallet RPC pacing to each actual read, combines cancellation with the decoder's original deadline, and stops its token reads on a 429 without retry or fallback. Error bodies are cancelled. Only a hostname is returned; configured URL paths and query credentials never enter the token report.

The generic decoder and its other callers are unchanged. Its mint/program/metadata checks, exact supply, metadata floor, 32-slot span, response bounds and manual redirect policy remain. The existing endpoint fallback is preserved. EVM inspection remains unchanged. Preflight auth, same-origin checks, ownership/revision checks, the 15-second gate and `executionAllowed: false` remain unchanged. No protected Claude UI, schema, provider setting, credential, signing permission or deployment changed.

## Verification

- Final 61 tests in five files pass without failures or skips: configured identity, preflight, generic token import, Token-2022 identity and warmup read panels. Report: `work/release-qa/warmup-configured-identity-delivery-20261022.json`.
- Plain TypeScript, three-file typed lint and three-file formatting pass.
- Tests compose the actual identity and balance readers with controlled RPC responses. They cover endpoint pinning, one shared genesis, mismatched network, URL secrecy, padded metadata, exact 32/33-slot boundaries, wrong mint, embedded control characters, cancellation before/during reads, 429 stop, error-body cancellation, response bounds and unchanged fallback. An Observed report still grants no execution authority; zero balance and token-only failure remain Hold.
- Signed-in Chrome QA used the full Next development app, real Better Auth and a disposable libSQL protocol bridge with all 139 source migrations. No triggers were dropped, environment files copied, real providers accessed or user keys used. The existing synthetic saved draft was reopened and checked through the actual authenticated route. The final rendered result shows USD Coin (USDC), six decimals and hostname-only provenance, zero SOL balance and a 0.013 SOL shortfall. The previous token-identity-unavailable warning is gone; Hold remains because the wallet is unfunded. Final runtime-overlay hashes match the two application source files. Screenshot/AX evidence: `work/warmup-signed-in-qa-20261022/configured-preflight.png` and sibling `configured-preflight-ax.txt`.
- The owned QA tab was closed and its exact server stopped cleanly through its own stdin. Original Chrome tabs were preserved.

Actual `claude-opus-5-5` reviewed 15 unchanged source copies using Read/Glob/Grep only. It completed successfully with zero denials and no blocking defect. Logs/status: `work/release-qa/opus-warmup-configured-identity-20261022/`. After that review, the accepted small error-body cleanup was broadened from 429 to all failed account responses and two regression cases added; Codex reran the final checks and browser QA. That follow-up was not independently rereviewed. The reviewer ran no tests.

## Limits and next work

The padded USDC account is synthetic; it proves decoder compatibility, not actual on-chain metadata or production provider availability. Pacing-call coverage is not a live throughput measurement. The original 12-second decoder deadline includes genesis and pacing time, so a slow provider can still yield Hold. No real wallet was unlocked, signed or submitted, no funded action ran, and nothing was deployed or migrated in an application/hosted database.

The separate full suite is still running against frozen `3bb015f`, not this overlay. Latest verified progress at 19:59:15 UTC: 32 of 799 files completed, no failures reported, wrapper PID 22224 and Vitest PID 30516 still live. This is not a full-suite pass. Its authoritative process/log must be checked again rather than trusting this dated note. `AGENTS.md` contains older archive/full-run entries; those are historical and were not rewritten by this checkpoint.

Full warmup execution, automatic alternative routing, live provider qualification and overall Proxima parity remain unproven. No migration is reserved by this change; 0139 remains subject to the current journal and claims.
