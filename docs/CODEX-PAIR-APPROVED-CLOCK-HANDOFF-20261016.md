# Approved Clock and endpoint handoff

Separate implementation commits: 42e2729 (stock-only equal/+1 Clock policy) and b840562 (server-only stock runtime endpoint setting). See CODEX-PAIR-STOCK-CLOCK-POLICY-20261016.md and CODEX-PAIR-STOCK-RPC-SETTING-20261016.md. No provider setting or credential was changed; SOLANA_STOCK_RUNTIME_RPC_URL is absent locally. The live sample below uses existing-indexer-fallback, not a separately configured validator. QuickNode Build is the recommended next provider plan, pending the user's choice and provisioning. Published capabilities do not prove a Bundle latency or consistency result.

## Fixed sample and exact outcomes

One fixed six-attempt alternating SOL/USDC campaign was started under Node 24.19.0 at source b840562, on 16 October at 17:19 UTC. The first 429 in attempt five stopped the entire campaign. Attempt six was not run. No refused attempt was repeated or replaced; there is no complete six-attempt summary. The retained JSON has all five raw sanitized receipts, tracked source hashes, request status accounting and duplicate Clock correlations.

| Attempt | Asset | Outcome |
| --- | --- | --- |
| 1 | SOL | Jupiter unsigned-order HTTP 400; no order or simulation. |
| 2 | USDC | Complete unsigned qualification pass: runtime slots 457718238..457718264 (26), complete quiet-reference audit span 29. Exactly one simulation and both complete 15-read code observations. Reference activity unchanged. |
| 3 | SOL | Strict initial minimum refusal: required 29161 raw, packet 29160. Fresh-reference-only tolerance does not override it. |
| 4 | USDC | Before-inventory writable guard refused executable LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo, owner BPFLoaderUpgradeab1e11111111111111111111111, data size36, context457718312. No simulation. |
| 5 | SOL | One simulation, 29 first-scan logical code reads, final scan incomplete at two reads. A genesis/account JSON-RPC batch returned429; cancelled pending work and stopped. After-activity audit unavailable, so not considered quiet or passed. |
| 6 | USDC | Not run after429. |

Observed SOL 0/3, USDC 1/2, with one planned USDC attempt unrun. This is not repeatability qualification. The sole pass still has programCodeAttested=false, trustedProgramPolicyEstablished=false, innerInstructionPolicyVerified=false and signingAllowed=false. It is not a funded, signed or submitted trade and cannot enable signing.

All thirty accepted Clock observations retain context/effective slot and relation: 28 equal and two +1. The two +1 observations are context457718301/effective457718302 in the refused USDC attempt and context457718328/effective457718329 in the rate-limited SOL attempt. Each was correlated to two raw response Clock values with identical forty-byte SHA256. The successful USDC attempt's Clocks were equal; it does not independently prove a live complete +1 path. The synthetic full-lifecycle +1 test covers that ordering. The raw response contexts are not rewritten.

The writable refusal is now captured with actual address, phase, owner, executable and size operands. Its comparison labels false/true express required policy versus observed state, not a proven historical account transition. Prior-account operands are unavailable for this before-inventory read. No unsupported program was allowed by ID, and this checkpoint does not claim a transport mapping defect or change the writable predicate. The original generic refusal and this new exact refusal need further packet/mapping diagnosis before choosing a fix.

Transport:177 HTTP200, one Jupiter400, one RPC429 and one admitted request without completed status after cancellation. No aborted read is counted as success. All five tracked source vectors match current source. The first four public-reference audits found unchanged activity; the last audit was unavailable. No user wallets, private keys, signatures or broadcasts were used. The 32-slot limit, both full scans, exact consent/minimum rules and all non-stock/group Clock rules remain unchanged.

## Verification and limits

Final related Node24 Vitest cohort:30 files/570 tests together, including pair/runtime/order/service/API/UI, code identity, endpoint selection, ordinary/qualification pacing isolation and duplicate-preserving transport. Twenty-four offline harness tests pass, plus plain TypeScript, scoped typed/script lint and 21-file formatting. The full-lifecycle +1 regression additionally passed in the 58-test focused four-file cohort before endpoint work. The broad additional 23-file group run produced no completed results in about five minutes, with two busy workers, and was stopped before live measurements. No full-group or full-app-suite pass is claimed; no group source file changed, but the separate regression remains unverified. No build, browser or funded proof was run this turn.

No deploy, push, remote SQL/migration, cron, provider configuration, credential change, wallet unlock, signing or broadcast. Claude UI ownership and main's two dirty files are preserved. Next: separately provision/qualify the chosen standard RPC, diagnose the exact executable-writable scope, and complete fixed SOL/USDC samples within32 without dropping failed outcomes. Stock signing stays off.
