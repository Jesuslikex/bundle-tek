# Counter Buy wrapping and gross native settlement

Source commit **bfd5b00** joins the Counter collector to an explicit ExactOut native settlement policy. The existing public ExactIn warmup settlement entry point retains its behavior and return shape; a private shared validator now holds the common setup/rent/wrapping/cleanup checks. No approval/signing API or UI is enabled.

## Behavior

The Counter collector now observes standard token-account rent and retains the route's decoded pre-state bindings, full native/token account evidence, the two simulated route account post-states, resolved instruction review and rechecked lookup-table observations. These are the inputs needed for instruction-level settlement comparisons, rather than a mint-level net balance alone.

`reviewExactOutputNativeSettlement` independently checks shared-v1 ExactOut instruction fields and zero additional compute price. It applies the existing canonical ATA/seeded-account derivation, payer/writability, initialization, funding, synchronization, cleanup, owner/delegate/close-authority and rent checks. Unknown instructions and unrelated transfers are rejected. The target token delta must equal the recorded exact output. Actual effective SOL input can improve below its quote, but must be positive and stay within the protected ceiling and funded wrapping amount. This native-only path requires zero pre-existing wrapped token units and wallet-bound WSOL cleanup.

Gross wrapping/setup debit and peak token-account rent are counted before refunds. The wallet must cover that gross debit plus the observed network fee. The separately reviewed fee/rent allowance must cover peak rent plus the network fee. A wallet that can cover only the smaller final net debit after rent refunds is rejected. Rent changes are reconstructed from per-account identities and raw native/token amounts; unknown or changed account state is rejected.

`reviewCounterBuySettlement` binds fresh collected evidence to the preparation hash and budget, then independently decodes the actual unsigned packet and compares its resolved instruction review and account-key mapping with the recorded simulation. Substituted instruction evidence cannot pass merely by retaining a matching hash field or balance claim. The result retains the proposal/project/plan identities, actual input, settlement limits and expiry, with `executionAllowed=false` and `instructionsVerified=false`.

## Verification

- **351 tests across seventeen files passed**, including ten new ExactOut settlement tests, three packet-to-collector-to-settlement integration tests, inherited ExactIn wrapping/signing regressions and the preceding Counter, pricing-route, balance, lookup, instruction and simulation suites. Report: `work/release-qa/counter-gross-settlement-tests-20261014.json`.
- The new tests cover ATA and seeded setup, rent-only seed funding, lookup evidence, improved input price, inadequate gross funds despite sufficient net funds, under-budgeted temporary rent, extra transfers, excessive wrapping, wrong mode/target, compute-price changes, missing cleanup, changed packet/instruction evidence, budget changes and expiry.
- Actual-source TypeScript, six-file typed lint and production build exited zero. Logs: `work/release-qa/counter-gross-settlement-types-20261014.log` and `counter-gross-settlement-build-20261014.log`.
- All **1,095 source hashes** stayed unchanged during verification, digest `6a91b5d33a6c3219d98e1f89535f599e74fda15b5e40ae53989a88c57012af23`. Snapshot: `work/release-qa/source-counter-gross-settlement-20261014.json`.
- Tests use actual encoded packets with synthetic chain/provider evidence and fixed fixture wallets. No user transaction was signed or submitted; no live provider, funded, browser or authenticated Counter approval flow was verified.

## Remaining integration

Current project/wallet/source admission and durable proposal-use reservation must be enforced in authenticated storage before explicit user approval. Persisted budgets must be immutable and bound to the packet. Signature/receipt recovery and concurrency must prevent duplicate use. Existing positive WSOL balances, Token-2022, other ExactOut layouts and non-native quote assets require further supported paths; the full goal remains open. Shared strategy/session limits, live launch, complete holder and audited P&L requirements are also unfinished.

Claude UI/protected source, historical SQL, CROP candidate, hosting and credentials are untouched. The two unrelated pre-existing whitespace edits remain unstaged. Nothing pushed, saved as a hosted version or deployed.
