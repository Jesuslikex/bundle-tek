# Recovery and funding disclosure: rendered QA

22 October2026. Base `eaa66ff9001663864fb5e01954c3b22e303b233f`. Actual current recovery/funding components and application CSS were rendered in the existing Chrome profile through an isolated loopback Vite fixture. The only application-source change is six lines in `components/wallet-funding-proximity.module.css`.

## Fixed phone disclosure target

Before: the red recorded funding-gap summary measured18px high at375px viewport. The new max-width640px media rule gives warning and recorded summaries a44px minimum height. After:44px at375/320, with no horizontal overflow; Enter opens the native details and retains visible focus. Desktop1440 still measures18px. The red color and exact24m34s sample text, threshold logic, source/unknown distinctions, and all provider/financial behavior are unchanged. Unknown summaries already had a44px minimum. Wider touch tablets remain the prior behavior; no whole-accessibility audit is claimed.

Actual geometry:375 requested/client360/scroll360,320 requested/client305/scroll305,1440/client1440/scroll1440. A later375 screenshot observation reported client/scroll375/375; all observations show no horizontal overflow. Record actual client widths instead of assuming a screenshot override took effect. The initial unknown-recovery desktop image was1920, not1440: the viewport capability initially affected the selected Proxima research tab. Responsive measurements were subsequently made in a newly selected owned QA tab, and all overrides were reset.

## Verified rendered recovery boundaries

The story is original interruption reference -> explicit saved-status lookup -> exact admitted synthetic DTO -> separate unsigned cancellation approval -> conservative lost-response/status recovery. History and funding views are separately explicit reads. Every feature fetch is replaced by an in-memory fixture; unknown routes/external fetches throw. No real backend, keys, provider, signer or send path is available in this harness. Vite uses envDir:false; no local secret file was copied. The fixture is ignored under `work/auto-sell-review-browser-20261022`, and uses actual tracked components/test DTOs rather than a recreated product screen.

- No mount lookup; explicit original-preparation GET shows the exact reference and initially unchecked consent. Cancel remains disabled until separately checked.
- Lost cancellation response makes exactly one synthetic POST, disables the parent original-read action and reports unknown. It does not automatically retry. The explicit original-intent GET then reports cancelled and clears the callback block; no session counters, budgets or automatic strategy resume are restored.
- A synthetic active-run lock withdraws checked consent and disables cancellation. Removing the lock does not restore consent. Saved-status reading stays available.
- A pending read followed by outside interaction finishes with focus on the outside Finish pending read control, after the loaded-status message is visible. The normal explicit lookup restores appropriate focus.
- History mount/disclosure makes no read; explicit lookup renders its page snapshot and independent unsigned recovery, with no raw packet text and no horizontal overflow at320.
- Funding read renders two red24m34s badges, one close-time pair and source limitations. The details are keyboard-operable and44px high on narrow screens. Recovery consent labels/buttons also measured44px at375/320.

This verifies real React/DOM/CSS rendering with simulated transport, not authentication, HTTP route ownership, durable financial reservation release, actual finalized receipts or funded execution. The callback indicator is not a rendered test of the full modal's Run/vault guard. Those boundaries remain independently open; the earlier unit/SQLite tests have their documented scopes.

## Proxima reference refresh

Fresh passive REA target/page evidence was obtained through the existing approved temporary relay, scoped only to Proxima. Two fresh records are in a private10-record bundle,4683920bytes, SHA256 `da16c72a4518b074ae23c6753a4365a211e310145973998dd51bbdafa7f30d19`. Capture is policy-filtered/attach-limited; raw network payloads, credentials, storage values and script sources were excluded. Raw private captures are not published.

Separate normal Chrome UI inspection in a new research tab opened the wallet page and unsubmitted Generate Activity form. Observed fields: fixed/range amounts, loops, minute/second delay, alternative routing, wallet count, required amount and estimated duration. An app-reported completed-session summary exposes duration and per-wallet transaction/volume fields. This is UI evidence only, not independently verified chain results or knowledge of the backend. No Start, financial/session control, completion acknowledgement or configuration submission was performed. The user's original launch/wallet tabs were preserved; only agent-created tabs were closed.

A source investigation also confirmed that current manual receipt capture can observe a genuine exact wallet-signed packet without an app-owned signing intent. Do not impose new execution-consent lineage on historical observation as an incidental fix. A future execution root still needs its own verified consent, exact shared source and production outcome admission; nothing here supplies or enables those.

## Verification and review

66 tests pass across six related files, zero failures/skips. Plain TypeScript and CSS formatting pass. Actual Opus5.5 Read/Glob/Grep review completed08:54:49Z–08:55:27Z with seven copied files unchanged and zero denials. It inspected both CSS versions, the component, two synthetic phone screenshots and supplied geometry, found no material regression, and ran no tests. Its comparison was not pixel-identical because the after image also has open/focused details; geometry was independently measured in Chrome. No production build/full suite, signed-in Bundle backend QA or funded/provider execution is claimed.

Screenshots, fixture and detailed measurements remain local under `work/auto-sell-review-browser-20261022`; hashes and sanitized observations are in the sibling portable evidence JSON. No protected Claude source, TS/TSX logic, schema/migration, provider credential/settings, cron, wallet operation, hosted SQL or deployment changed. The isolated QA server was stopped after verification and its listener disappeared.

## Cleanup limitation

The tool policy rejected sending stop to the temporary REA relay because approvals were unavailable. The command was not retried through another mechanism. Last observed: owned Node16944 and WSL Python16664 still hosted the loopback relay; the Windows9223 CDP listener had already disappeared. Cleanup of that relay is not claimed complete. Revalidate state and resolve the policy block before attempting further termination; do not use a different mechanism to bypass the rejected action. This does not block independent source work.
