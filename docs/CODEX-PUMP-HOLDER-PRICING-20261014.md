# Holder pricing arithmetic checkpoint

Added the exact-quote output calculation and sequential pricing projection needed for independent holder simulation checks. Fee selection is shared with the existing initial-buy collector without changing its supported non-mayhem/default-creator profile. Each projected buy uses updated virtual/real reserves and reselects the fee tier at the updated market cap. Exact-output buys enforce their individual quote caps; quote-input buys enforce their minimum outputs. Inactive slots remain ordered with zero projected movements. Exhaustion/synthetic migration, overflow, invalid fee schedules and inputs too small after fee rounding reject.

Quote inputs follow the inspected SDK's fee-inclusive net calculation, one-step rounded-fee correction and `floor((net-1)*virtualTokens/(virtualQuote+net-1))` output calculation. The net plus ceiling fees may be below the quote budget. That remainder is reported explicitly rather than presenting the full budget as exact spending. Carrying the SDK net into a projected curve is a model assumption that must be checked against actual observed settlement before approval.

## Source evidence

The cached official `@pump-fun/pump-sdk` 4.1.0 archive SHA256 matched `5c0af15764468ac4c6fa6aaada9653d97eff1ea3532b62bc60da451354faacfb`. Both inspected `package/src/bondingCurve.ts` and `package/src/fees.ts` were byte-compared with the archive, not trusted as loose extracted files. Relevant functions are `v3ExactQuoteInNet`, `getBuyV3TokenAmountFromQuoteAmount`, and the existing fee schedule selection. The attempted public Git source URL returned 404 and the browser registry read was unavailable; no fresh public Git/source availability or newer SDK version is claimed. No dependency was installed or upgraded.

## Verification

Four focused files passed, 38 tests, Node 24: independently calculated quote/output examples, a nonzero rounding remainder, sequential reserve updates and price changes, native fee-tier crossing, inactive slots, cap/minimum rejection, exhaustion, overflow and malformed fees, plus existing independent initial-buy simulation and holder packet/owned-preparation regressions. Actual-source TypeScript, scoped lint and production build passed.

## Not settlement proof

These are pricing projections, not a completed all-wallet simulator. They perform no RPC, inspect no actual wallet balances and authorize no signatures. Results explicitly retain `settlementValidated=false` and `observedSettlementRequired=true`; signing and execution remain false. Prefix/whole-packet RPC snapshots, actual quote/fee/rent debits, token custody, program stability and all-wallet conservation must still be checked independently. The projection is not attached to a signing approval and does not change the active launch API/UI.

No real signing/submission, remote SQL, provider/credential change, cron, push or deployment occurred. Claude's protected files and unrelated main changes remain untouched. Last verified production release remains source `11ad20b`.
