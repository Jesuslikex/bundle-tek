# Offline partitioned stock wallet consumer

## Scope

Preceding scope correction `c0b4bbe` requires exactly one original Clock entry, matching the wallet reader's unique requested scope. It refuses zero or multiple original Clocks before IO rather than collapsing requested observations.

`readPartitionedPairWalletEvidence` now composes the collector with the actual wallet evidence parser. It explicitly maps each retained partition's original account positions and verifies coverage. Its Clock comes from the first real partition response, whose context and full Clock must match every other partition. There is no fabricated merged RPC envelope or maximum-slot relabeling. The returned object includes ordinary wallet evidence and all partition receipts.

The existing `readPairWalletEvidence` entry point retains its single RPC read. Both entry points share the extracted wallet parser, including fresh mint identity, selected wallet owner, token extensions, rent, balances, amounts and policy-time checks. Existing funding/stability functions are unchanged. The optional partitioned entry point has only test callers; production services, qualification script and group paths do not select it.

The partitioned consumer takes a clock function, evaluates it during actual response validation, and rechecks every partition Clock before returning. It never freezes server time at the start of a pending read. Effective+1 Clock slots are retained in wallet evidence while receipts keep the raw context slots.

## Verification

Final Node24.19.0 run:12 files,299 tests passed together. Files: pair-wallet-partitions, pair-wallet-evidence, pair-account-partitions, pair-account-partitions-transport, pair-read-rpc, pair-stock-clock, imported-pair-wallet-preflight, imported-pair-order-candidate, pair-order-first-service, imported-pair-runtime, pair-runtime-ordering, pump-group-code-identity.

The new consumer tests compare complete evidence objects with the ordinary reader for synthetic SOL and USDC quote mints against the retained scaled-stock fixture. They verify raw/effective slots, the exact32-slot boundary and+33 refusal, a controlled31-second pending read refusal, missing mint, wrong wallet owner, invalid Rent and changed custody balances rejected by the existing stability guard. Partition scope/cancellation tests also pass. No sleeps or real provider calls are used.

Plain TypeScript, scoped typed lint and formatting pass. A TypeScript printer comparison against `5b9c6b7` confirms the wallet parser's tail from unix/rent/mint inspection through its returned evidence is identical after substituting the account-array variable. Seven existing helper functions, including token decoding, funding assessment and wallet stability, are unchanged under that comparison. Existing21 wallet tests still pass. This is scoped verification, not a full-suite/build/live/browser result.

## Remaining work

Review these commits before opting a runtime path into partitions. The caller must own a bounded, paced request transport capped at five actual accounts, propagate all observations and later effective floors, and cancel/close it on refusal. Sliced inventory/code requests above five remain unsupported by this full-account collector; they must retain complete identity coverage and the full final code recheck. A new fixed three-SOL/three-USDC live campaign has not run. Same-slot failures remain refusals with no retries.

The minimum-output rules, custody admission,30-second Clock bound,32-slot limit and stock signing gate are unchanged. No UI ownership files, providers, credentials, remote SQL, cron or deployed release changed. Preserve the two unrelated desktop edits.
