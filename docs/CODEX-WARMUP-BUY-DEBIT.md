# Warmup Buy finalized SOL debit validation

13 October 2026. Local implementation; no provider read, real wallet unlock, funded signature, broadcast or publication.

`decodeWarmupReceipt` now requires Buy settlement to equal the negative reviewed exact input, with a positive canonical u64 input. Settlement already reconciles the wallet SOL change, actual network fee, locked/refunded account rent and changes in existing WSOL balances. The new check uses that combined amount, matching the existing signing simulation's debit rule. Received token units and minimum output checks continue independently. The receipt shape and persisted schema are unchanged.

Before the fix, four synthetic signed receipt cases accepted a one-lamport debit mismatch: newly wrapped SOL, an existing wrapped balance, a retained wrapped account, and a seeded rent-only temporary account. All four new tests failed because the decoder resolved instead of rejecting. After the fix, both excess debit and insufficient debit are rejected in each case. The existing wrapping, lookup, fee, cleanup and Sell cases remain passing. The basic mocked envelope fixture now includes its one-lamport input in its native debit instead of counting only the network fee.

The actual checkout's two test files passed 31 tests with `--exclude 'work/**'`, recorded at `work/release-qa/warmup-buy-debit-source-only-20261013.json`; scoped lint passed. The preliminary report without that exclusion also selected archived commit-tree copies and is not the actual-source test count. This validation uses deterministic synthetic signatures and mocked provider metadata. It does not establish instruction semantics, prove a funded transaction, or independently reconcile a legacy stored receipt that omits the WSOL delta.
