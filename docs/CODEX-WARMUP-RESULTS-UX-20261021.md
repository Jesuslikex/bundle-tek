# Warmup recorded results UX

Source base: `4cef9e3f1fd85823f04b52028910cefff84c5cf8`. Source-only checkpoint, signing off, no deploy.

## Reference and change

The existing signed-in Chrome Proxima wallet session was reopened read-only: its Generate Activity results report a successful 50-minute session with seven wallet rows, each showing 22 transactions and a separate SOL volume. No Start, Done, funding or trade control was invoked. This is a displayed vendor result, not independent blockchain proof. [Proxima documentation](https://docs.proxima.tools/wallets/generate-activity/) also describes per-wallet progress, transaction counts and volume. Alternative routing and actual automatic execution remain separate unfinished requirements.

Bundle now presents already admitted finalized receipts as a compact wallet/transaction/volume table with exact aggregate wallet, loop and SOL totals, overall progress, native keyboard-accessible wallet details, and an explicit shortcut to the existing approval recovery. The parent passes the returned saved revision, earlier-history setting and archive flag. Current-revision and earlier-history tables have distinct captions. There is no new fetch, effect, HTTP route, write, approval or signing behavior in the summary.

A display-only bounded BigInt helper validates receipt-row count/volume conservation, canonical integers, unique wallets, matching cycle capacity and consistent states. It does not replace original receipt/lot admission or financial calculations. Empty and unrecorded states never imply completion; partial and recovery remain distinct. Recovery can mask completed loops in the original builder, so affected row loop counts and aggregate loop/completion totals are explicitly withheld until recovery, while finalized transactions and volume remain visible. The warning says recovery may belong to another plan. Malformed rows withhold totals and point to the existing per-step recovery table.

Turnover adds recorded buy spending and sell proceeds before fees/rent. It is not profit, current balance, readiness, an active runner or elapsed-time evidence. No user consent is reused or prechecked. The recovery shortcut only invokes the existing callback with that row's wallet, including for archived plans.

## Verification

The portable companion JSON records the exact test files, source digest and browser measurements. Final related regression: 202 tests in 11 files, no failures/skips, actual terminal exit0. The initial old buy-to-sell workflow text expectation caught missing markup whitespace; UI spacing was corrected without weakening the assertion. The original walletWarmupActivity builder is unchanged; only an additive display helper follows it.

Actual components and production globals/UX CSS were checked in an isolated loopback Vite fixture with synthetic receipts. Desktop shows seven compact57px rows and44px native details controls. At375/320px no horizontal document overflow was measured; the recovery control remains44px. Enter opens full-wallet details. Recovery navigation selects the exact synthetic wallet without a transaction. Exact values beyond Number precision, empty, partial, recovery,20wallet capacity and the actual archived parent revision toggle were checked. Parent opening makes one intercepted GET; explicit earlier inclusion makes the second. No real provider, private wallet, application database or production authentication was involved. Own tab/server closed; viewport reset. Local screenshots live in ignored work/warmup-results-browser-20261021, not the shared source or public app.

Actual claude-opus-5-5 completed a read-only review with zero denials and unchanged copied source. It found the recovery-loop label issue and low-severity bounds/accessibility/caption/alignment concerns. The corrections above were independently verified by Codex, not rereviewed. Opus ran no tests and did not inspect protected global CSS; rendered verification used those styles. No substitute model was used.

Final plain TypeScript, six-file typed lint and seven-file formatting pass. All 2,797 frozen source files remain unchanged at digest c58bd6f0f03af3a899bbf5fe4d76f5f6b16f4e188a4b1cba8d7f2cdd401e5fca. The final isolated production build exits0 on the committed base plus seven exact overlays, without local environment files or production credentials. Expected isolated-copy lockfile/no-cache warnings are retained. This is the related regression scope, not a new whole-repository full-suite pass.

## Remaining product scope

This is receipt history UX, not Proxima automation parity. Connected warmup runtime remains unsigned evidence. Trusted executable code policy, whole-path live qualification, financial reservations, separate short browser authorization, finalized receipt/action advancement, durable orchestration and qualified alternative routing remain open. Do not enable signing from this UI checkpoint. Auto Sell, marketplace and other parity work are not certified by this change.

Protected Claude shell/layout/global files, original migrations/db and provider/credential/cron settings were not edited. No application/hosted SQL, wallet unlock/sign/send, funded test or deployment.
