# Protected stock-pair intermediate accounts

15 October 2026. This extends unsigned pair candidates and runtime evidence. It does not enable signing or execution. Production remains d62300e; this increment is local.

## Compatibility gap and change

Live read-only QA found that Jupiter uses an existing canonical wallet USDC account between SOL and TSLAX. The old static guard rejected every wallet token account outside the selected pair, including a valid intermediate. Literal route-field matching alone could not resolve this.

The collector now discovers at most eight potential intermediate accounts from wallet-controlled writable token account prefixes and explicit setup instructions. It reads full account state, actual mint/Clock evidence and size-specific rent independently. Mint policies use the existing legacy Token / Token-2022 restrictions, including scaled units and required account extensions. Canonical associated accounts are required except for validated new seeded WSOL setup. Duplicate selected mints, duplicate intermediate mints, writable mints, noncanonical custody and unsupported mint policies fail review.

The exact packet's static review permits only the existing bounded setup/funding/cleanup forms. Intermediate accounts cannot receive explicit SOL funding beyond approved creation rent. Gross setup rent must fit the user's fee/rent allowance even when cleanup refunds it. Cleanup requires zero pre-existing intermediate token units and a wallet refund destination. Delegated/close-only wallet custody remains unsupported.

Standard RPC post-account bytes must preserve every intermediate's existing raw units, owner, delegate/close-authority restrictions, valid state, extension layout and rent. Positive dust can remain. `maximumNetDebitRaw=0` is a net balance constraint, not a claim that a route never temporarily moves intermediate units. Missing/created/closed accounts and WSOL reserves/refunds are accounted separately from selected-pair input/output and fees. Selected input and minimum-output checks are unchanged. Unadmitted wallet-controlled post-accounts still fail. Actual account bytes and mint policies are rechecked after simulation; runtime evidence now also rechecks admitted intermediate accounts after its final code observation.

No approval or reservation is created. `signingAllowed` and `executionAllowed` remain false. The endpoint remains an owned, revision-bound, unsigned review path. Matching simulated balances are provider observations, not a semantic audit or an on-chain outcome.

## Read-only live result and remaining blocker

The bounded probe at 22:37:05 UTC used a historical public transaction fee payer as an isolated local SQL reference, not a user's wallet. It made 47 allowlisted provider requests: mainnet reads, Jupiter GET quote/order requests and original-packet `simulateTransaction` with `sigVerify=false`, `replaceRecentBlockhash=false`. Existing server configuration was loaded without displaying credentials. No transaction was signed, sent or executed.

The wallet preflight and fresh Metis v0 candidate passed. The decoded split route used Meteora DLMM / Tessera V2 into an intermediate, then Manifest into TSLAX. Simulation consumed exactly 1,000,000 lamports (0.001 SOL), charged 31,259 lamports in observed message fees, returned 29,124 raw TSLAX against minimum 28,990, and preserved all 19,900 existing raw USDC units. No account rent remained. Packet SHA-256: e57fd3c5c289d7c2db36194d625d3b00b52e1abd138426aa89f0454572677fd7. Candidate observation slots were 457406527 through 457406558.

The runtime preview did not complete: its next observations reached slot 457406560, crossing the existing 32-slot bound. The limit was preserved. This is successful live unsigned candidate/simulation qualification, not successful runtime, signing, broadcast or funded qualification. The live probe preceded final discovery-envelope hardening and rent-loop cleanup; final-source controlled checks cover those changes. Receipts are ignored `work/pair-auxiliary-live-transaction*`; they contain public observations, not credentials. The expired packet must never be used for signing.

The next runtime step is to avoid preparing and simulating the candidate twice while retaining a complete independent review bracketed by full code observations. Runtime policy, durable currency-aware reservation/approval, encrypted browser signing, registration/broadcast/recovery and protected UI integration remain outstanding for stock pairs.

## Verification

The focused run passed 74 tests in three files. It covers legacy / extended Token-2022 / WSOL intermediates, positive dust, created accounts, seeded WSOL setup, cleanup refunds, exact gross rent, prohibited net debits, delegate/close authority/freeze/owner/rent failures, missing/writable/changed mints, too many accounts, late balance/policy changes, the actual owned API and final runtime custody rechecks. Test packets and simulations are synthetic, and runtime code bytes are fixtures, not audited executable programs.

The final combined run passed 712 tests in 31 selected files together, including native quote/signing/receipt and shared group code/runtime/authorization regressions. It completed in 252.50 seconds. Production Next webpack build, subsequent standalone TypeScript, eleven-file typed lint, formatting and whitespace checks passed. All 1,275 frozen implementation/configuration/style hashes remained unchanged throughout validation. The complete repository-wide test suite was not rerun. Ignored receipts are work/pair-auxiliary-{tests,build,types,lint}.log, the selected-file list and source-freeze manifest.

No UI file, schema migration, remote SQL, provider/credential setting, cron, push or deployment belongs to this increment. Main's two unrelated dirty files were verified byte-identical. No real wallet was unlocked and no transaction was signed or sent.
