# Warmup saved-buy Sell runtime composition

Source base: `e17fab8c317f814a47e9e7f4317261c803a64c64`. This is a source-only checkpoint, with signing off and no deployment.

The retained Chrome Proxima wallet page displayed a completed 50-minute activity session: seven wallet rows, 22 transactions each, and 6.94 SOL total displayed volume. This is live UI evidence, not independent verification of those transactions or its signing/backend architecture. Bundle's complete automated execution parity remains unfinished.

## What changed

The new integration tests connect an original retained buy and partial-sale history to the real inventory HTTP observer, existing provider core, unsigned raw runtime collector, private observation storage and saved-only recovery. Declared synthetic JSON-RPC and disposable native SQL are used throughout. They do not unlock, sign or submit with a real wallet, or contact a live provider.

Two reproduced production defects are corrected:

1. The inventory observer wraps RPC errors in `HoldingsReadError`. The attempt service previously treated a genuine HTTP 429 as an evidence refusal. It now recognizes that known class in the same branch as `WalletRpcError`, preserving the provider-limit/unavailable distinction. Refusal, cooldown, attempt accounting and no retry behavior remain unchanged.
2. A partial lot could accept inventory newer than its original buy but older than its recorded finalized partial sale. Runtime Sell now derives the latest finalized receipt slot for the selected lot from the original owned immutable source and requests that floor from the existing holdings observer. The actual baseline must satisfy it; slots are never clamped or relabelled. The adapter also rejects a returned inventory/mint observation below the floor. Existing source guards still run before and after asynchronous work.

The floor helper checks the current owned journal/head/terms/action/plan context, exact source hash/canonical representation and bounded history. It checks the selected buy, related finalized sales, wallet/mint/program/units and acquired = remaining + consumed accounting. It does not confer new receipt, signing or execution authority. Historical receipt slots supply a lower bound, not an extra old observation inside the live 32-slot span.

`observeWalletHoldings` and `inspectWarmupSellInventory` have optional floor parameters with default zero. Ordinary callers keep their original request body and behavior. Only the runtime Sell adapter selects this new lower bound. Both full serial code scans, exact ordinary Clock checks, 30-second clock age, 32-slot live span, custody, fees/rent, output minimums and source/expiry guards remain in force. All authority flags stay false. No migration or schema change is needed; 0135 remains immutable and 0136 is the next unclaimed number subject to recheck.

Shared synthetic fixtures accept explicit token amounts and starting balances so tests can represent full 101-unit lots and real recorded 25/1-unit remainders. A partial fixture retains a sale decoded from a synthetic signed native packet rather than inventing consumed units. Default Buy/Sell packet and raw receipt bytes are checked against the original explicit 1,000-unit form.

## Evidence and limits

See the companion portable evidence JSON for final results and hashes. The original failed HTTP429 and stale-partial-receipt regressions are retained locally under `work/release-qa`, alongside the actual Opus 5.5 read-only review. An earlier fixture typo and partial-accounting failures were corrected in tests; original accounting guards were not weakened.

The focused tests cover full/partial Sell, funded wrapped-SOL closure accounting, frozen/insufficient/decimal/stale inventory and mint observations, +33-slot span, ordinary Clock +1 refusal, required native close, provider429/shared cooldown, owner isolation, saved-only recovery and Stop/consumed-source races. Reading an unsigned candidate does not consume the lot or advance the action.

This is not live Sell qualification, funded proof, full repository/browser QA, independent price assurance or trusted program-code policy admission. Financial reservations, short browser signing authorization, finalized settlement, action/budget advancement, durable orchestration and qualified alternative routing remain separate work. Do not claim Proxima execution parity or unlock signing from these synthetic checks.

## Review follow-up

Actual claude-opus-5-5 completed a read-only review with no blocking production finding, zero permission denials and unchanged copied source. Opus ran no tests. Its medium test gaps prompted direct malformed-source and exact-query-binding cases, wire-level default/explicit floor assertions, invalid floor rejection, stronger stale-baseline assertions and a runtime observer that returns a stale report despite the requested floor. These test-only follow-ups were independently implemented and verified; they were not rereviewed by Opus.

The floor is the latest receipt for the selected lot in its approved plan, not all wallet/mint activity across plans. Ordinary preview/legacy paths intentionally retain their previous behavior and have no new floor. Lagging-node RPC errors may be provider-unavailable while a returned stale slot is evidence-refused; neither permits execution or retries. The floor is reconstructible from the immutable source, but is not an additional stored runtime evidence field. Missing legacy fields still require the original core's source/receipt admission. Partial fixture rows use decoded packet evidence inserted directly into disposable tables; they do not prove the full sale-capture save path or Token-2022 runtime Sell. Those scopes remain separate.

## Final verification

The final frozen related run passes 2,009 tests in 111 files, with zero failures/unhandled errors and one opt-in real SQL-clock test skipped. That clock proof belongs to the previous unchanged-SQL checkpoint and was not repeated here. All 2,792 source hashes remain unchanged through the final run. This is not a full-repository suite claim. The first broad run retained one failed UI assertion (1,988 pass/one failure/one skip); the test now waits for actual recovery state and retained ID instead of assuming five event-loop turns complete hashing/storage. All 22 cases pass independently and in the final broad run. No product UI behavior changed.

Plain TypeScript, fourteen-file typed lint and fourteen-file formatting pass. The isolated Node 24.19.0 production build uses committed e17fab8 plus exact overlays, contains no local environment file/provider credential and passes. Final production overlays still match that build; only independently checked test additions changed afterward. Opus reviewed 2,749 unchanged copied files with zero denials and no blocking production finding. No application/hosted SQL, provider/credential/cron change, wallet action, signing, funded test or deployment occurred.

