# Warmup review Save and Recover controls

20 October 2026. API checkpoint `ee0b48c` follows immutable storage `cc24a0c`. The owned automatic-session review now exposes explicit Save and Recover controls. Saving retains review evidence only; every trading authority flag stays false and there is no automatic Start.

## Behavior

- Saving checks the current reviewed plan again, hashes its exact context and creates one immutable request identity. Before its only POST, it stores a minimal public recovery reminder in browser session storage. If that reminder cannot be persisted/read back, no save is sent. No key, password, packet, raw receipt source or full context is put in that reminder.
- A lost, malformed, timed-out or stopped save response leaves the identity available and withholds confirmation. Recovery uses GET for that same identity; it never retries the POST. A 404 does not silently clear the reminder or establish that a pending write was cancelled. Late/cancelled/context-changed responses are ignored.
- The client checks response identity, revision/hash/time bindings, false authority, bounded wallet/action scope, exact budget sums and sell dependencies before displaying a historical summary. A successful save also compares the complete returned manifest with both the original review and its context-bound manifest. Historical recovery does not renew expiry or become signing permission.
- Reminder restoration does not fetch on mount. Recovery works independently of a current live review, including older/archived plan context. Users can retain/copy the displayed ID and paste it into the recovery field later. Clearing a local reminder is explicit, never deletes server evidence, and requires a fresh review before another save. Session storage is tab-scoped: closing the tab can remove the reminder, so server-side saved-review discovery remains a useful follow-up.
- Review/dismiss controls avoid competing with an active save/recovery. All new controls use native accessible buttons/labels and the existing CSS module. No protected shell or token layout slot changed.

## Verification

All 15 related files and 216 tests pass together. This includes the 22 actual local-D1 retention route cases, 22 immutable storage cases, 15 new client admission cases, nine new retention component cases, existing review API/domain/UI checks, the migration/checksum tests and the existing 40-case warmup preparation/receipt workflow. Four synthetic signing modes still complete buy-to-sell locally without live providers. Expected negative-path preparation logs are retained. This is not the full repository suite.

Plain TypeScript, scoped seven-file typed lint, eight-file formatting and diff checks pass. Both isolated production builds passed with unchanged source hashes. The final build includes the only subsequent application change: increasing the reminder-clear button from 32 to 44 pixels. Its exit is 0 with `unchanged: true` and `passed: true`. The existing nested-workspace/no-build-cache warnings remain; no warning was suppressed.

Synthetic Chrome checks used the actual TSX/CSS with declared in-memory API fixtures, separately from the real local-D1 route tests. Both desktop and final 375x812 phone checks exercised a lost save response followed by exactly one GET recovery, with one POST total. A fixture reset also demonstrated reminder restoration and a 404 without an automatic save. Clearing the reminder and requesting a fresh review recovered the normal path. Final phone DOM widths were 360 within a 375 viewport, panel width 298; all three retention buttons and the recovery input were 44 pixels high. The temporary viewport was reset. Early transient frame-tree observation timeouts were re-observed on the same tab; no duplicate browser session or real action was started.

Generated evidence: `work/release-qa/warmup-session-retention-tests-20261020.json`, `work/release-qa/warmup-session-retention-build-20261020/result.json`, `work/release-qa/warmup-session-retention-final-build-20261020/result.json`, and `work/warmup-session-retention-browser-20261020/retained-desktop.jpg` / `retained-phone.jpg`. These ignored fixtures are not production or signed-in browser proof.

## Remaining scope

Production still needs migration 0117 in an approved release; no application or hosted migration ran here. Automatic session consent, the scheduler, fresh per-transaction checks/authorization, session stop/recovery and alternative platform routing remain open. Stock signing and every existing signing safeguard remain unchanged. No provider, credential, cron, actual wallet, funded action or deployment change occurred.
