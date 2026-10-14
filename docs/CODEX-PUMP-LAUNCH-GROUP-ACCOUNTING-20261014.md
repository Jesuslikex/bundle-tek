# Complete launch-group economic accounting

14 October 2026, based on 8e500ce. Adds independent economics to the reconstructed sequential trace. This is a pure verifier, not an enabled group preparation or signing workflow.

## Behavior

The wrapper revalidates the original producer response through the trace gate and rebuilds the complete packet group. Every frame must conserve SOL except its exact funded network fee. Positive wallet SOL and SPL quote debits accumulate against full reviewed caps; later credits do not erase earlier spending.

After each frame, the wrapper reconstructs the complete account union and independently validates that economic prefix. Unexecuted holder slots are masked only inside the accounting clone, after assembling the original complete group. Future accounts remain at their observed initial state, and only already executed packets grant writable permissions. Reports distinguish verified packet count from complete group coverage. The final prefix must cover every packet and reconcile all network fees.

The existing independent settlement arithmetic checks ordered developer/holder buys, exact-output and exact-quote targets, fee rounding, quote/base custody, rent allocation, immutable mint metadata, supply, curve reserves and lifecycle, creator/protocol/buyback fees, wallet volume and unrelated account state. The single-packet public report is preserved. This reuses independent arithmetic, rather than trusting a producer success label or a declared trace-validation flag.

## Verification

- Fifteen selected holder/group/model/service/route/UI test files passed 181 tests. This run included the first eight accounting cases.
- Final accounting file passed all nine cases after strengthening the intermediate-curve assertion and adding excess-debit/refund coverage.
- Controlled multi-packet fixtures cover native SOL, SPL and Token-2022 quotes, developer-free plans and both holder buy denominations. Fees sum each decoded message's signer count; intermediate snapshots use independent integer reserve/fee arithmetic.
- An intermediate curve corruption preserves trace continuity and is repaired before the final state. The trace gate passes, but prefix economics rejects the reserve mismatch.
- Excess deployer spending and a later refund preserve final balances and trace continuity. The trace gate passes, but cumulative SOL debit rejects the reviewed-cap breach.
- Missing holder tokens, wrong fees and per-packet SOL creation reject.
- Final-source TypeScript, four-file typed lint, whitespace checks and the production Next.js build passed. Build log is retained in ignored work/group-accounting-build.log.

These are controlled fixtures. They do not execute BPF or prove an actual provider's v1 decoding or trade behavior. No browser UI changed.

## Remaining work

RPC-origin/source/lifetime collection and program deployment review remain mandatory. Both economic helpers keep signingAllowed=false, executionAllowed=false and completeLaunch=false. Buyback rounding attestation remains explicit and unresolved. The existing empty-bundle capability result establishes method acceptance only.

Next connect economic verification to a qualified complete unsigned replay and source/program gates, then add owned durable group review, reservations, explicit approval, complete signatures, one-attempt submission and recovery/UI. Tip and send transport remain unverified; groups above five packets have no enabled execution policy. No subset or independent-simulation fallback is introduced.

No remote SQL/migration, UI/protected Claude file, provider/credential change, cron, push, deployment or real signing/broadcast occurred. Migration 0081 remains local; main's unrelated dirty files are preserved. Full Proxima parity remains unfinished.
