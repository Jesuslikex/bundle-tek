# Complete launch-group funding observation

14 October 2026, based on d8d1f74. Adds collectPumpLaunchGroupFunding and shares the existing single-packet validation engine without changing its public report shape.

## Implemented

The observer clones the complete input/limits/evidence and reconstructs every unsigned packet itself. No caller packet bytes or account maps are admitted. It fetches getFeeForMessage for every reconstructed message and sums all reported fees against the one deployer fee/rent allowance. The deployer remains every packet's fee payer. Repeated deployer signer charges are included in fixtures through each decoded message header. Holder quote budgets and own fee/rent caps remain ordered and exact; zero slots stay in the wallet report with zero requirement and no queried wallet balance.

The account union comes from decoded packet static addresses plus known public creation/configuration evidence. Observation is capped at 2048 addresses and uses getMultipleAccounts chunks of at most 100. Each before and after snapshot must have one identical provider-reported bank slot across all chunks. A mixed snapshot is discarded and fully retried, at most three attempts per side. Malformed mappings, ignored context slots and other RPC failures fail immediately. Before and after snapshots may occupy different banks; exact own/custody/configuration identities must remain stable, with only the existing packet-derived shared buyback balance normalization admitted. This is not source-to-simulation bank matching.

Known creation evidence must include global/payer/new mint and remain inside the group scope. Its hashes must match the observed bank. The mint must be absent; public global/quote/control account owner, executable flag and bytes must match the reconstructed input. Quote precision/program and token custody remain strict. All active wallets must cover their full declared SOL/quote caps, not merely estimated costs.

Mainnet is checked before and after observation. Original blockhash validity, final height and ten-block expiry headroom remain required, within the existing 32-slot drift bound. Group observation has a 60-second deadline and an explicit read budget of four network/lifetime calls, one call per packet fee, and at most six calls per account chunk (two snapshots with three attempts). Single-packet limits remain twenty seconds/eight reads. RPC promises race cancellation so an injected abort-ignoring provider cannot hold the observer forever. Final allowance hashing also precedes the final cancellation check.

Group reports bind the unsigned manifest digest, allowance digest, per-packet fees, all wallet rows, raw/normalized account hashes and both snapshot bank slots. FundingValidated means observed coverage of full declared caps only. Actual rent/quote consumption, successful instructions, settlement and group atomicity require later simulation. SigningAllowed/executionAllowed/completeLaunch stay false and sequentialSimulationRequired stays true. There is no new API, UI or durable write.

## Verification

- Final thirteen-file cohort passed 162 tests under Node 24: new group funding, group/single assembly, target allocation, existing funding, full simulation/settlement, durable review, signing/execution, client/panel and holder route suites.
- Eleven new cases cover native/SPL/Token-2022 quote funding; every one of 200 slots and later chunks; cumulative fees; final-wallet SOL/quote shortages; mixed-bank retry/exhaustion; absent evidence/misordered limits/configuration mismatch; malformed batches, expiry/network changes; own-wallet versus allowed shared-balance changes; and cancellation with an abort-ignoring injected provider.
- Actual-source TypeScript, two-file typed lint, whitespace checks and final production Next build pass.
- The first new fixture used numeric RPC slots where the existing lossless RPC contract requires canonical strings. Corrected fixture representation; its default fee now uses each decoded signer count with a controlled 5000-lamport fixture rate. No fixed production fee rate is assumed. Final cohort is green.
- All RPC responses were controlled fixtures and keys synthetic. No actual provider read, user account/key access, signature, transaction or remote database call.

## Required next work

Build genuine sequential bank/bundle simulation with independent per-packet and whole-group settlement. Independent simulateTransaction calls cannot carry earlier packet effects. Verify the configured unsigned simulation and v1 transport capabilities, then tip construction/costs, complete owned project/wallet revision checks and immutable group reviews, reservations, approvals, full signature registration, one-attempt submission and complete/partial/unknown recovery. More than five packets still has no enabled execution policy. This read-only funding utility is not connected to a group preparation API and grants no signing authority.

No SQL migration/history or remote SQL, UI/protected Claude file, provider/credential setting, cron, push, deployment, real signing or broadcast changed. Production remains 11ad20b and 0081 remains local only. Main's unrelated dirty Jito note and 0068 migration remain preserved. The original full Proxima goal remains active.
