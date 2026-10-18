# Account-owned amount presets, 18 October 2026

## Result and ownership

Adds reusable SOL buy amounts, sell balance percentages and sell saved-supply percentages to the existing imported-token quote controls. This addresses the preference gap observed in the retained Proxima inspection in `CODEX-PROXIMA-TRADE-PREFERENCES-REA-20261018.md`. It does not establish full Proxima parity. Defaults come from Bundle's existing controls, not assumed vendor defaults.

Each list holds 1 to 8 distinct values. Customization stays collapsed until opened. Explicit saving persists presentation preferences for the authenticated account; selecting a shortcut only fills the existing amount callback, clearing old quotes/preparations. It never automatically quotes, prepares, signs or sends. Account switching discards stale responses and editors; an expected-owner check prevents a changed session saving the previous account's draft. Atomic revision checks refuse concurrent saves and offer reload. Defaults remain usable after settings failures; resetting defaults requires an explicit save.

The server validates exact fields, canonical positive SOL values and integer basis points. Percentage calculations use BigInt and floor to atomic units. Freshness, available unfrozen holdings, lock state and saved supply remain prerequisites. Existing fixed-preset helper whitelists remain intact. Browser verification exposed a pre-existing refresh-clock issue: a mounted sell component retained its old clock after receiving a new report and disabled fresh selections. It now refreshes its clock asynchronously when observation timestamps change, with timer cleanup and regression coverage.

Owned paths are the new trade-amount preference model/client/service/schema/API/component/tests, migration 0111 and journal export, existing imported sell sizing and quote integration, and the narrow local HTTPS guard allowlist. Peer history commit `6896fc3` and protected token layout paths were preserved. Shared index was released by the peer before this checkpoint. No credentials or generated/runtime artifacts belong in the commit.

## Validation

- `work/release-qa/trade-presets-final-02`: 8 Vitest files, 34 tests pass. Mounted jsdom tests exercise the actual API and service against disposable libSQL with synthetic authentication, account changes, revision conflicts, timeout/failure recovery, defaults, quote invalidation/cancellation, custom sizing, expiry and refreshed-report recovery.
- `work/release-qa/trade-presets-guard-01`: 5 native Node guard tests pass, including actual loopback forwarding and refusal of unexpected preset/financial fields.
- Standalone TypeScript, typed lint for the 15 owned TypeScript files, and formatting for all 18 owned supported source files pass after the refresh fix.
- Actual Wrangler whole-file local migration application: all 112 migrations pass. Receipt: `C:/Users/Julian/AppData/Local/Temp/bundle-wrangler-migrations-r4SPmx/report.json`. This is disposable local state, not a hosted migration. Historical checksum validation requires migration 0111 to exist in Git HEAD and will be checked after the code checkpoint.
- Live browser fixture on loopback port 4315 uses the actual controls and preference service, synthetic Alice/Bob sessions and disposable SQL. It blocks quote, provider, vault and transaction API calls. Saved custom 0.025/0.1 SOL values survive reload, Bob receives defaults, returning to Alice restores her values. 33.33% of 3003 atomic units produces 0.001 token; 0.01% of saved supply produces 0.0001 token. Expired selections refuse; a new synthetic report recovers after the clock fix.
- Browser widths 320, 375 and 1440 fit without horizontal overflow; expanded customization also fits at 320. Settings are collapsed initially. Screenshot: `work/release-qa/trade-presets-mobile-20261018.png`. This is a component/service fixture, not a claim of signed-in hosted persistence or funded execution.

## Remaining gates

The final shared production build and post-commit historical migration checks are recorded below when terminal. Migration 0111 has not been applied remotely. No push, deploy, funding, wallet unlock, signing, transaction submission, provider or credential changes were performed. Same-window widgets refresh each other; separate browser tabs recover conflicts through explicit reload, not automatic synchronization. Custom hotkeys, currencies beyond these existing Solana controls, broader strategy execution and production qualification remain separate gaps in the full Proxima objective.

Final shared build `14709` completed with exit 0 after the refresh fix: webpack 22.8 seconds, TypeScript 8.2 seconds, 6 pages in 1279 ms, traces completed. Peer source was frozen throughout; freeze released only after terminal output. Log: `work/release-qa/trade-presets-build-02.log`. The prior helper handle was absent, but the actual 3443/3188 listener was identified as PID 5568 running this checkout's `scripts/local-https.mjs` before it was stopped for the build. Restart uses the existing trusted certificate and original helper, without certificate or credential changes.

Migration 0111 SHA-256 in the whole-file Wrangler receipt: `edc4d502cea90670359f67e8c5b5ac8328a2a76091b638b18a2891d29bead8e5`. Final synthetic mobile screenshot SHA-256: `a36bb49fe663214104317a2855cd332f8c8227bf26540b4ec72cfce824618964`.

Restored helper session `9075` announced the existing trusted HTTPS origin. System-trust HTTPS GET and a valid-shaped POST to the new endpoint both return 401 without cookies; no account record was written by this health check. This verifies authentication refusal through the built route and local edge, not signed-in hosted saving.
