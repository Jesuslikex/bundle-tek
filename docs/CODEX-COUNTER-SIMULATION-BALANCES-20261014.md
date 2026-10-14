# Counter Buy simulation balance checks

Source commit **2536042** adds `assessCounterBuySimulationBalances` to compare simulation balance evidence with an inspected Counter Buy preparation. It does not issue RPC requests or enable preparation/signing controls. It is a required balance-policy component for the remaining approval integration.

The preparation now retains the saved token precision. The assessment snapshots its inputs, redecodes/hashes the actual unsigned packet, binds the evidence to that hash and wallet, checks preparation/review/quote context and expiry, rejects substituted blockhashes, and requires consistent bounded quote/fee/simulation slots. Loaded lookup addresses must match those retained by preparation. Invalid/incomplete native balance arrays are rejected; failed simulation results never produce successful balance claims or expose upstream error details.

For a successful simulation, the wallet must receive exactly the retained token target, with the saved precision and standard token program. Receiving more than the target also fails the ExactOut comparison. Missing token metadata/ownership/program observations remain unknown. Unrelated wallet token debits and any change in wallet WSOL holdings are rejected. Token arithmetic remains integer-based above JavaScript's safe Number precision.

The fee/rent allowance is an independently supplied exact raw amount, separate from the swap-input limit. The observed network fee must be positive and within that allowance. The net wallet SOL debit must fit the quote's protected input ceiling plus the allowance. The result calls this a **net wallet debit**, because refunds can hide gross spending. It does not assert that this comparison proves all gross debits, SOL wrapping or actual fee/rent sources.

Every result retains `executionAllowed=false` and `instructionsVerified=false`. Matching comparisons report `Matched balances`; mismatches and missing observations are distinct. No provider error payload is returned. The policy never mutates or consumes the plan/preparation.

## Integration still required

An authenticated simulation collector must obtain trustworthy before/after account evidence for the same packet, verify mainnet and original blockhash, independently inspect mint extensions/account ownership, wrapping, all gross debit instructions and fee/rent sources, and recheck immutable lookup table hashes. Standard RPCs cannot be assumed to return enriched pre/post balance metadata: the collector needs explicit account snapshots and decoding or a verified provider contract. This policy accepts typed evidence; its tests do not establish that a real provider supplies it.

Current database/project/wallet/source validation, persisted independent budgets and durable proposal reservations must precede explicit user approval. Signature/receipt recovery, shared limits and complete Counter signing remain unfinished. Do not convert this policy's status into execution clearance or use a client-supplied evidence object for approval.

The shared fixture was extracted from the existing preparation test without importing a test suite into another suite. Claude UI/protected source, schema/history, CROP candidate, credentials and hosted state are untouched. No browser, provider, funded, signing or submission action is part of this checkpoint. Nothing pushed or deployed.

## Verification

- **299 tests across eleven files passed**, including eight new balance-policy tests with adversarial cases, the 22 preparation tests, existing ExactIn/balance/simulation/envelope/lookup suites and seven real pricing-route/local-D1 tests. Final report: `work/release-qa/counter-simulation-balances-final-tests-20261014.json`.
- Actual-source TypeScript, five-file typed lint and production build exited zero. Type/build logs: `work/release-qa/counter-simulation-balances-final-types-20261014.log` and `counter-simulation-balances-final-build-20261014.log`.
- All **1,090 source hashes** remained unchanged during final checks, digest `cfcbbfa8ca045fc14c83036d7f1024028319299f9f968b70ba11302bb19f5248`. Snapshot: `work/release-qa/source-counter-simulation-balances-final-20261014.json`.
- Evidence is synthetic, using actual encoded unsigned preparations. No live simulation provider, authenticated approval route, rendered UI or funded flow is verified by this pass. The two pre-existing unrelated whitespace edits remain unstaged.
