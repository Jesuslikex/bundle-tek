# Current Proxima Counter Trading controls

13 October 2026. REA controlled scenarios used the already-approved Chrome CDP target and existing launch workspace. They opened the unsent Auto Sell configuration, inspected its default Counter Trading form, expanded End Conditions and Advanced Options, used the actual Close button and restored the original account route. No amount, replication factor, trigger percentage, timing, slippage or wallet field was filled. Add Strategy, Run, trade, signing and export controls were never clicked. The form reported no active AutoSell session and Run 1 Strategy was disabled; these are captured interface observations, not a backend audit.

## Observed requirements

- Mode choices: Counter Trading, DCA and Limit Orders.
- Counter description says it sells tokens when someone buys the token.
- Required Replication Factor spinbutton and Trigger Condition with Rate (%) input, displayed default 100.
- Optional minimum percentage of supply per sell, market-cap range and a Whitelist 0 Wallets control. The whitelist editor was not opened and no address was selected.
- Strategy-local end conditions: maximum amount and hours/minutes/seconds duration. The form explicitly says those stop only that strategy while others continue.
- Advanced options: optional start delay, slippage and wallet selection. Existing selected-wallet count was visible, but no selection was changed.
- Session-wide ending controls: maximum amount and duration. Text says Auto Sell stops completely as soon as either condition is reached when both are set.

## Unknowns and Bundle impact

The capture does not establish the exact replication-factor amount formula, whether Rate means probability or another threshold, minimum-sell rounding, denominator freshness, whitelist inclusion/ownership semantics, wallet allocation, trigger deduplication/order, settlement-based maximum-amount accounting, duration clock anchor, concurrent strategy reservations or server custody/signing. The user-approved browser-encrypted vault and per-transaction review/signing/submission rules still govern Bundle. Observing Run/Add Strategy controls does not authorize invoking them.

Bundle's finite DCA cycles/deadline and existing Limit/Grid monitoring do not implement this Counter strategy or independent strategy/session ending hierarchy. The next implementation must reconcile genuine classified buy evidence, exact reviewed sell amounts and shared budget/stop conditions, not assume that a DCA input alias or net balance delta proves Counter parity. Source remains frozen while the current full suite runs; no speculative application change was made in this investigation.

## Complete Evidence

Records are retained outside the application/deployment tree at C:/Users/Julian/Documents/Codex/2026-10-09/https-github-com-morluto-rea-https/work/proxima-counter-controls-20261013, with file bytes/SHA-256 in manifest.json:

- launch-start.json: ev_c292ff31e7fc5c526b465c996928bc82674d94a863a2497ea8387e8908bb71f1. The initial navigation captured only the loading shell; it did not establish missing controls.
- launch-ready.json: ev_93f3cc6a41b42d6b534b6cfe730f13dbcc8de8a0579947569a71d4aab502ac5c. Subsequent passive observation found the loaded AutoSell configuration controls and identified the first Configure button's context.
- counter-open.json: ev_c7e1dec039c21ac73322576002da63a35f5c70aae7efe015e20f5b1b707e8cfd. Actual unsent Counter form.
- counter-controls.json: ev_86d48fbfa989424dc3449d4a8e756da768c486b6e9035c5d66097721a5662cce. End/advanced controls followed by completed actual Close, with the Auto Sell heading absent afterward.
- restore-account.json: ev_2ccceb5ce3f64ec3a14829c6541320f512d8f2132f8666b3c0ad74d805439551. Both steps completed at https://app.proxima.tools/account with no Auto Sell form heading.

The scenario provider reports incomplete event coverage; the passive inspection is policy-filtered. No complete network trace, raw request/response body, header value, credential, cookie, storage value or screenshot was exported. Initial schema-validation attempts were rejected before browser execution because start_url requires a structured URL and scenarios require at least one action. Navigation captures used a body Escape key action; actual form closure was verified separately with Close, not inferred from Escape. Complete records were saved in bounded data-only pieces, reassembled and JSON/identity checked.

Only documentation changed. The same full-suite handle 75317 remains active on unchanged 1056-file source digest 7593e0ccc5b2f76f0c1475b7a988378b73841301e82a2fcb5b98ce05006bb5fd. Ten completed passing files are observed so far; final totals/terminal status and post-run verification remain pending. No source, protected Claude file, migration, CROP candidate, hosting, credentials or scheduler changed. Nothing pushed, deployed, saved as a hosting version or transacted. Full Proxima parity remains unproven.
