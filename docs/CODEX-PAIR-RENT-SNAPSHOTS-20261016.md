# Stock-pair Rent snapshots and provider backoff

Local continuation of Claude's approved `1fdd264` scheduling review, on top of `d1e921b`. No UI files changed. No push, deployment, migration, provider/credential change, cron change, wallet unlock, signature or submission.

## Changes

- Final runtime block height now requests `minContextSlot: afterFloor`. The order collector's initial and final height reads also carry their current floors. All three still check confirmed commitment and the original blockhash/lifetime bounds. A node refusing the floor fails the request; no retry is added.
- Provider HTTP 429 survives the quote, wallet, candidate and code-read wrappers as a sanitized 429. The existing runtime API returns `Retry-After: 15` and `Cache-Control: no-store`. Failed code reads terminate collection rather than starting another slice batch. Up to four already-started slices may finish; there is no retry loop or provider rotation. Configured provider pacing is unchanged. Group code reads remain serial by default.
- Wallet snapshots and before/after order snapshots now include Rent beside the protected accounts, mint metadata and Clock. Runtime's existing protected-account snapshots include Rent too. These additions require no extra RPC calls.
- The Rent parser checks sysvar owner, non-executable status, funded u64 envelope, canonical 17-byte layout, optional declared size, burn bounds, SDK rate bounds and exact threshold 1 or 2. Unknown floating-point profiles are refused. Integer BigInt arithmetic computes `max(1, (128 + size) * rate * threshold)` for the already bounded 0..4096-byte account sizes. No current network rate is hardcoded in the application.
- This replaces separate per-size rent calls. SOL/TSLAX preflight saves four calls across its two snapshots. A review protecting 165-byte WSOL/USDC and 179-byte TSLAX saves three more calls. Savings depend on the distinct account sizes. Selected balances, raw units, gross creation rent, fee allowance, system-wallet reserve and post-simulation custody checks remain required.
- Before/after order review rejects changed Rent bytes. Runtime rejects changes across its final code observation. Synthetic fixtures now use protocol-shaped Rent arithmetic rather than their old arbitrary additive formula.

## Evidence and limits

An earlier separate read-only mainnet proof at 2026-10-15T23:34:14.999Z matched six independent rent RPC results (sizes 0, 82, 165, 179, 200 and 4096) to the captured Rent bytes. These exact results are regression vectors in `lib/pair-rent-evidence.test.ts`; capture-specific rate 5080 is test evidence only. The proof remains in ignored `work/pair-rent-proof.json`.

The new owned runtime probe at 2026-10-15T23:45:06.764Z used public historical transaction fee payer `2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y` in an isolated in-memory database. It made 44 read/quote/order requests, no rent RPC calls and no simulations. All HTTP responses were 200, with no 429. The mint comparison covered slots 457425425..457425451, then the independent instruction/account/raw-spending review refused the candidate. This is a new unresolved qualification failure, not proof of a supported route or a timing benchmark. Details remain in ignored `work/pair-rent-live-transaction.json`.

A bounded diagnostic capture at 2026-10-15T23:46:23.954Z added local failure-line instrumentation without altering guards. Its public reference was `Fri2hiuuj8TjavnmsNLtTBjugba73T95tbHKA9xp2BAR`. It stopped earlier on inconsistent/stale Clock evidence after 13 reads, all HTTP 200. No unsigned order or simulation occurred. Details remain in ignored `work/pair-rent-diagnostic-transaction.json`. It did not reach the instruction failure and therefore did not identify that guard. No repeated polling/retry loop followed.

Neither probe unlocked a wallet, used private keys, signed, sent, wrote a hosted database, or created approval/reservation. Public-reference preflight is not wallet ownership proof. RPC evidence and independent account parsing are not a semantic audit or cryptographic proof of provider honesty. The global 32-slot bound is unchanged. Stock-pair signing and execution stay disabled until the actual live runtime path qualifies, with subsequent separate consent/reservation/browser-signing and finalized-receipt recovery work still required.

## Verification

The final combined selection passed all 33 files and 788 tests in 235.32 seconds, with two workers. It covers stock units/mints/quotes, custody/funding, route parsing, order preparation and simulation, runtime/API boundaries, shared code identity and group runtime authorization, and existing warmup/imported signing regressions. This is a selected regression run, not the complete repository suite. No rendered UI or funded mainnet test was performed.

Production Next build, subsequent standalone `tsc --noEmit`, typed lint on all 21 changed/new TypeScript files, and Git whitespace checks passed. All 1,280 frozen source/config hashes remained unchanged across verification. The focused eight-file run also passed 260 tests; these overlap the final selection and are not additional unique cases. Group collector production code was unchanged; the added test confirms a four-slice 429 batch is not retried.

Exact local selection/commands and logs: ignored `work/pair-rent-tests.cjs`, `work/pair-rent-checks.cjs`, `work/pair-rent-{tests,build,types,lint}.log`, and `work/pair-rent-source-freeze.json`. Node 24 was invoked explicitly. Main's two unrelated dirty files were verified byte-for-byte against the prior preservation manifest before integration.

## Next bounded step

Capture the precise failed instruction guard and its public unsigned context for offline replay, while retaining the existing Clock, raw-budget and 32-slot refusals. Reduce remaining code/metadata round trips only with equivalent evidence and response bounds. Do not enable signing from a partial observation or loosen freshness to obtain a passing run.

Primary references checked for this implementation:

- [Solana getBlockHeight configuration](https://solana.com/docs/rpc/http/getblockheight)
- [Solana Rent SDK implementation](https://docs.rs/solana-rent/latest/src/solana_rent/lib.rs.html)
- [Agave Bank minimum-balance implementation](https://raw.githubusercontent.com/anza-xyz/agave/master/runtime/src/bank.rs)
