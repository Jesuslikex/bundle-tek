# Native Pump.fun movement classification

Added read-only native bonding-curve classification for the pinned current `buy`, `buy_exact_sol_in` and `sell` layouts. This does not add transaction construction, launch support or signing permissions.

The primary source is the [official Pump.fun IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json). `lib/pump-native-route-schema.json` records its exact source hash, capture time, instruction discriminators, arguments and account order. The current buys carry two u64 arguments and two one-byte OptionBool arguments, including partial-fill: 26 bytes. Sell carries two u64 arguments: 24 bytes. Historical byte/account forms and the separate V2 token-quote instructions remain unsupported.

`scripts/update-pump-native-route-schema.mjs` verifies the mainnet program, signer and fixed program roles, argument names/types, OptionBool representation and Anchor discriminators before regenerating the pin. Future schema diffs require review.

## Evidence requirements

All labels require a successful transaction with complete token metadata and inner instructions, one top-level native Pump.fun route, the tracked signer matching `user`, the selected mint and owned token account matching the instruction, distinct wallet/payment/token roles, known program boundaries and exact SPL transfer reconciliation. Additional changed wallet assets remain unknown.

For buys, actual parsed inner System transfers must originate from the wallet and go only to the decoded curve, fee recipient or creator vault. A nonzero curve payment is required. Their totals must reconcile with each recipient's before/after lamport balances and the instruction's SOL budget and token amount bounds. The current partial-fill buy can acquire fewer than its specified maximum tokens; exact-SOL input still must satisfy the retained minimum token output. Missing fees, unrelated payments and unsupported byte layouts withhold the label. Native wallet debit alone never supplies a buy label.

For sells, the token debit must equal the instruction amount and its actual transfer to the curve token account. The curve lamport debit must equal wallet proceeds, protocol fee and creator fee. Wallet proceeds account for the explicit network fee only when it was the fee payer, and must meet the minimum output. A separate fee payer must lose exactly the network fee. Changed unrelated native accounts, System transfers, ATA operations and token-account rent/close operations withhold attribution. This conservative path does not claim coverage of every legitimate sell variant.

`lib/tracked-wallet-transaction.ts` now retains public native account before/after/change integers and parsed System `lamports`. Existing account-key validation still applies. `lib/pump-native-movement.ts` returns a separate `pump-native-and-token-transfers` basis with protocol `Pump.fun`. Its opposite leg explicitly identifies native SOL, using the canonical WSOL mint identifier only for asset identity. The label component displays SOL without calling it a wrapped-token transfer. Old classifications remain readable; native asset metadata is rejected under unrelated evidence bases.

The movement activity summary includes native asset identity in duplicate comparison. Native labels save/reload through the existing authenticated movement API without a database migration.

## Verification and limits

- Six new native tests cover all three layouts, signer/payment/amount/partial-fill rejection, missing sell settlement, unrelated balance/rent rejection, and the actual RPC decoder through classification for buy/sell fixtures.
- Existing decoder and rendering suites passed with native evidence. The broader focused classification/summary run passed 33 tests; decoder/native/render run passed 20 tests, with six overlapping native cases.
- Ten real Miniflare-backed authenticated movement API tests passed, including native Pump.fun save/reload alongside PumpSwap and CPMM.
- TypeScript and scoped lint passed.

These are fixtures and real local API persistence tests, not live native Pump.fun transaction proof. Public mainnet classification, final browser visual QA, historical layout support, account-rent variants, native execution and full Proxima parity remain unverified or incomplete. The previous browser policy rejection was not bypassed. Claude's protected holder/watch-wallet and test-reliability files were untouched. No credential access, live configured RPC call, signature, submission, migration or deployment occurred.

Final production build passed all five stages; existing large client chunk warning remains.
