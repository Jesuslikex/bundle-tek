# Proxima live wrapped Pump.fun movement evidence

Two public transaction links were read from the existing DINGER Proxima feed. Both mainnet transactions were available, successful and decoded with complete wallet token metadata. The live known-classification QA failed at classification: both remained unknown. This is not a passing buy/sell proof.

The executions have a GMGN router as outer instruction 5. Each has 18 recorded inner instructions, all with reported stack depth. The first inner instruction invokes Pump.fun at depth 2 with discriminator `5df6823ce7e940b2` and 26 accounts. The published Pump.fun IDL identifies this as `sell_v2`. Its user, base mint and source token-account roles match the tracked wallet, DINGER and the wallet's token account; its exact u64 amount matches the negative token delta in both captures.

The quote mint is `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`. Its wallet net delta is zero, while subsequent Raydium CLMM and Orca Whirlpool calls occur within the same GMGN operation. A direct native-SOL balance increase is not itself proof of the route's settlement amount. Current direct/native decoders do not support this wrapper plus intermediate-quote flow.

Official account-layout evidence: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json. The bounded source capture and SHA-256 are retained in `work/live-provider-qa/pump-wrapped-layout.json`. The computed exact role/amount comparison is `work/live-provider-qa/wrapped-pump-attribution.json`. No captured application code was executed.

## Implemented prerequisite

`lib/tracked-wallet-transaction.ts` now preserves outer instruction index, inner ordinal and explicitly reported stack height on movement instructions. It leaves absent/null depth absent and rejects malformed heights or duplicate inner caller groups. This retains the provenance needed to distinguish transfers and route calls in separate top-level operations. It does not yet derive caller trees or classify arbitrary CPI routes.

The captured public transactions, including all balance facts and decoded instruction records but no credentials/signing material, are pinned in `test/proxima-wrapped-pump-transactions.json`. The offline regression verifies caller attribution, observed account roles, exact sell argument versus wallet delta and zero-net intermediate quote. It requires unknown classification until an explicit supported route/settlement decoder exists.

Five transaction/classifier/direct/native/pool test suites passed 43 tests; TypeScript and scoped lint passed. The separate live QA continued to fail its known-label requirement after fetching the updated decoder's evidence. All 18 inner records in each live decode retained caller index and reported depth. Passing prerequisite tests must not be reported as successful live classification.

Next work: reconstruct validated CPI ancestry, pin the wrapper and actual sell_v2 quote layouts, attribute base/quote transfer legs inside the correct call, and distinguish intermediate quote from final wallet settlement. Unknown wrappers, incomplete ancestry, unsupported swap programs, token extensions or contradictory transfers must not receive a buy/sell label through a permissive program allowlist or net-delta shortcut.

The pinned live-evidence regression also passed. Final TypeScript and all five production-build stages passed; the existing large client chunk warning remains. These checks cover the context-retention change, not a completed wrapped-route classifier.

Claude's protected files were untouched. No credentials were displayed or changed, no transactions signed/submitted, and no database mutation, live migration, push or deployment occurred.

## Scoped sell_v2 decoder implemented afterward

`movementInvocation` now reconstructs a selected call's descendants from the retained outer index, inner ordinal and depth. It requires a unique root, complete consecutive CPI ordinals and a valid depth progression. A Pump call's subtree excludes subsequent Raydium/Orca siblings. Missing or contradictory ancestry withholds attribution.

`pump-quote-movement` pins the published sell_v2 discriminator, 26 account roles and two u64 arguments in `lib/pump-quote-route-schema.json`. It checks fixed program roles, wallet signer/user ownership, base/quote mint and token programs, distinct token-account boundaries, exact sell amount versus base delta and the wallet-authorized base transfer into the curve. Quote transfers must originate from the curve's declared quote account/authority into only the declared user/fee accounts, with matching precision and a positive user transfer above the instruction's minimum. Other operations on the wallet's base token accounts reject attribution, as do unknown programs inside this invocation and unsupported token-transfer layouts.

This proves an executed Pump.fun venue sell, not the entire GMGN wrapper or final route settlement. Returned classification uses `pump-quote-and-token-transfers` with required `quote.scope: venue-transfer`. The classification validator rejects using that scope as a direct/native quote, missing scope or a buy label. Activity summaries include the scope in duplicate-evidence comparisons. This quote is consumed only by the explanatory movement label; it is not a signing authorization, valuation or P&L input.

The UI shows sell/Pump.fun, “Venue quote transfer” and a visible “Final wallet proceeds are unverified” qualifier. Final settlement remains unverified even when native SOL increases. The pinned regression was extended from the original unknown expectation to require the explicit venue classification and scope after implementing these proof checks; contradictory ancestry, account roles, amounts, quote minima and transfer variants still require unknown. The direct sell_v2 path is also tested.

The repeated bounded live probe passed: both captured successful transactions classify as venue sells. Their observed venue quote transfers are 11739705 and 54718842 atoms, respectively, at eight decimals. The provider read budget remained three requests (mainnet genesis and two fixed public transactions); no signing or mutation occurred. Sixty-five focused tests, TypeScript, scoped lint and all five production-build stages passed. These results do not prove complete multi-hop settlement, wrapped buys, universal protocol support or full Proxima parity. Broader current UI verification remains outstanding.

## Fixed-amount buy_v2 added

The schema also pins published buy_v2: 27 account roles, two u64 values and one OptionBool byte. The decoder accepts the exact 25-byte layout only with partial_fill=false. The curve-authorized base transfer must equal the positive wallet delta and requested amount. All user-authorized quote transfers within the call must go into declared curve/fee accounts, and their exact aggregate must be positive and within max_sol_cost. Output scope remains venue-transfer; final wallet cost is explicitly unverified in the UI. buy_exact_quote_in_v2, partial fills, refund layouts and unsupported token-transfer variants remain unknown.

The buy fixture is synthetic with a test signature and fixture provenance; it is not a live receipt. Fixed amount, total fee-inclusive quote spending, maximum-cost, wrong authority, missing ancestry and partial-fill cases are tested. Thirty-six focused tests across buy, sell, pinned live-sell facts, labels and existing classifiers passed, followed by a narrower 13-test fixture/label check. TypeScript, scoped lint and all production-build stages passed.

Two additional public Proxima feed signatures could not be decoded because the configured RPC rejected both under maxSupportedTransactionVersion=0 with error -32015. The bounded live buy QA failed; zero known buys were observed. No version limit or signing guard was relaxed. The sanitized report is work/live-provider-qa/proxima-buy-movement-report.json. Solana's official versioned-transaction guide documents this v1 read incompatibility: https://solana.com/docs/core/transactions/versioned-transactions. Read-only v1 decoding and a successful real buy sample remain required before live buy coverage is claimed.

## Read-only v1 and live buy evidence

The read path now requests maxSupportedTransactionVersion=1 and validates v1 inline account bounds, signer/signature agreement, transactionConfig integers, absence of lookup addresses and bounded opaque instructions. Signing and packet construction are unchanged. Historical 24-byte buy_v2 receipts are accepted only when actual base transfer, requested quantity and positive wallet delta agree; the decoder does not infer an absent partial-fill flag. Current 25-byte partial-fill variants remain rejected.

Associated-token setup is accepted only inside reconstructed ATA invocations with matching payer, account, mint, owner and token program. Unknown callbacks, transfers hidden as initialization, mismatched rent creation and unrelated base-account operations withhold classification.

The bounded three-read live probe subsequently passed on two actual v1 FLASH-wrapper receipts from Proxima's public feed: one venue sell (41225546 quote atoms) and one venue buy (43001184 quote atoms). Final wallet settlement remains unverified. `test/proxima-v1-transactions.json` pins public transaction evidence without logs or credentials. Eleven new regressions cover both receipts and malformed v1/setup evidence. Forty-nine focused tests, TypeScript, scoped lint, the 69-migration fresh D1 test and the production build passed. This is scoped classification evidence, not complete historical/P&L or funded execution proof.

## Exact-quote-budget buys

The current official Pump.fun IDL defines buy_exact_quote_in_v2 with 27 roles, spendable_quote_in, min_tokens_out and a one-byte OptionBool partial_fill. The read-only classifier now supports its exact 25-byte layout with partial_fill=false. It requires a positive wallet base delta matching the curve-authorized transfer and at least the minimum output. Every observed quote/fee payment must match the declared source, authority, recipient and precision, and the total must be positive and within the quote budget. It reports observed spending rather than claiming the entire budget was spent. Current account-setup and CPI ancestry checks still apply.

The schema updater verifies existing instruction roles/discriminators/arguments, the new exact-quote roles/arguments/fixed addresses, and OptionBool encoding before pinning the IDL hash. Eleven new synthetic regressions cover fee-inclusive observed spending, budget/minimum violations, partial/absent flags, mismatched base legs/deltas, fees, authorities, roles and ancestry. Forty-eight targeted tests passed including captured fixed-amount live buy/sell regressions; scoped lint and production build passed. Exact-quote live receipt verification and final wallet settlement remain outstanding. No signing, provider-secret change or new deployment occurred for this extension.
