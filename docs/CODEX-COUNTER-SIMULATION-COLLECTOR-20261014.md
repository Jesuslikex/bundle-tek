# Counter Buy original-packet simulation collector

Source commit **eff6d26** connects the unsigned Counter Buy packet to explicit RPC account snapshots and the simulation balance policy. It adds two library/test files. No UI, authenticated preparation/signing route or approval state is enabled.

## Collected evidence

`simulateCounterBuyPreparation` snapshots the preparation, redecodes and hashes its actual unsigned v0 packet, checks expiry, then uses the configured server-side Solana indexer RPC or an injected RPC interface. Default RPC requests use the existing lossless integer parser and two-megabyte response bound. Configuration is never returned; unexpected RPC failures are sanitized. The operation has a 25-second cancellation deadline, including a cancellation race for a provider that ignores the signal.

It verifies mainnet genesis, checks the original last-valid height, obtains the original message's fee, and resolves/rechecks lookup tables against retained preparation hashes. It independently reruns the ExactOut route comparison against resolved accounts. No blockhash is replaced and no transaction is broadcast.

The collector reads complete message account snapshots in batches of at most 100, consistent with Solana's [getMultipleAccounts contract](https://solana.com/docs/rpc/http/getmultipleaccounts). It decodes standard 165-byte token accounts and initialized 82-byte mint accounts. It verifies saved output precision, WSOL precision/reserves, route source/destination ownership/mints, supported wallet token authority and enough native funds for the protected input plus the independently reviewed fee/rent allowance. Token-2022 and unknown layouts remain outside this checkpoint.

It requests [simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction) with the exact unsigned packet, `sigVerify=false`, `replaceRecentBlockhash=false`, confirmed commitment, bounded minimum slot and explicit post-account addresses. It does not rely on enriched pre/post native or token-balance fields. Those policy inputs are constructed from the collected account bytes. Missing post accounts, wallet reassignment, changed mint bytes, replacement blockhashes and inconsistent fee/slot evidence are rejected. Failed simulation payloads retain only a failed comparison, with no upstream logs/error text.

Afterward it rechecks immutable lookup hashes and the chain snapshots of the wallet, route source/destination, previously wallet-owned token accounts and mints. Busy foreign pool accounts are not required to remain unchanged. Retained snapshot hashes and bounded observation slots accompany the balance assessment. All returned records retain `executionAllowed=false` and `instructionsVerified=false`.

## Verification

- **311 tests across thirteen files passed**, including nine new collector tests with adversarial cases, actual encoded packets, a 107-account lookup-backed packet and 100-account batch bounds, immutable lookup changes, cancellation during an ignored RPC, original-packet flags, wallet/mint changes, sanitized failures and the prior Counter/ExactIn/binding/lookup/simulation/pricing-route suites.
- Actual-source TypeScript, two-file typed lint and production build exited zero. Reports/logs: `work/release-qa/counter-simulation-collector-tests-20261014.json`, `counter-simulation-collector-types-20261014.log`, `counter-simulation-collector-build-20261014.log`.
- All **1,092 source hashes** stayed unchanged during checks, digest `5b69485254f46d00f4f64dad7dfb1fce72530e2b4d21583cce1b548e7a682e72`. Snapshot: `work/release-qa/source-counter-simulation-collector-20261014.json`.
- Provider/RPC responses remain synthetic. This proves local collector behavior against the documented shape; it is not live RPC, funded, authenticated approval-route or browser proof.

## Remaining approval work

Account snapshots and net balance checks do not prove every gross debit or wrapping instruction; refunds can offset spending. Independent instruction/debit/wrapping checks and actual rent sources remain required. Current project/wallet/source admission, durable proposal reservations and persisted review budgets must be bound to the packet before explicit user approval. Signature/receipt recovery and shared strategy/session limits remain unfinished. Do not treat a matching simulation balance status as permission to sign.

Claude UI/protected source, historical SQL, CROP candidate, hosting and credentials are untouched. The two pre-existing whitespace edits remain unstaged. Nothing pushed, saved as a hosted version, deployed, signed or submitted.
