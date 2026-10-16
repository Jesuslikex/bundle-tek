# Stock-pair early quote bounds and bounded code packing

Local continuation after `b90e5bc`. The previous turn made verified code and evidence progress; this checkpoint continues the same Proxima-parity objective. It does not qualify stock signing or establish product parity.

## Identified live refusal

A fresh bounded read-only diagnostic at 2026-10-15T23:50:40Z identified the previous generic instruction rejection at the original quote-bound guard. The original minimum was 28,886 raw TSLAX units; the later unsigned order offered 28,885. Original and later quoted outputs were 29,032 and 29,031. Pair, side, input of 1,000,000 lamports, wallet, 50-bps slippage, 10-bps platform fee/mint and unresolved-account count otherwise matched. The guard was correct. Neither one-unit drift nor scaled display values authorize weakening the original minimum.

The public historical reference was `2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y`, used in an isolated in-memory database. It was not a user wallet or ownership proof. The ignored receipt/context are `work/pair-rent-diagnostic-transaction.json` and `work/pair-rent-diagnostic-transaction-instruction-context.json`. The local diagnostic loader only recorded guard line/context; it did not change branches, limits or approval policy.

The exact captured quote/order context was also replayed through the new guard offline at 2026-10-16T00:01:38Z. It refused precisely the worsened original minimum, with zero provider calls, signatures or broadcasts. Receipt: ignored `work/pair-captured-bounds-replay.json`.

## Implemented changes

`lib/pair-order-quote-bounds.ts` centralizes the same selected pair, side, raw input, wallet, fixed slippage, platform fee/mint and original minimum checks. Raw minima must also be canonical u64 strings. Owned preparation checks these immediately after the unsigned provider response, before any candidate/code/simulation RPC reads, with a sanitized fresh-quote message. Runtime entry and independent instruction review repeat the same checks. Equal or improved minima are admitted to subsequent review; even a one-unit deterioration is refused. No refresh/retry is automatic, and no quote, consent or reserved budget is silently rewritten.

The declared-size four-read code profile now packs account slices using their exact remaining lengths. Each subsequent planned slice grows when short accounts finish. This reduces wasted response capacity while preserving the existing 1 MiB aggregate decoded response bound, 720 KiB per-account slice bound, four-read concurrency ceiling, 10 MiB per-program/32 MiB total limits, read/deadline limits, header checks, exact code hashes and 32-slot span. Unknown-size accounts retain serial short-read termination. Default group calls remain serial with their previous chunk schedule. No configured pacing, provider, endpoint or credentials changed.

Two unequal-size eight-program fixtures compare exact vectors/hashes between the default and pair profiles. For one 3 MiB program plus seven 4 KiB or 100 KiB programs, code-data calls drop from six to five. Tests inspect actual returned bytes against both response bounds. Existing out-of-order, cancellation, truncation, unknown-size and 429 tests continue to apply. This is a bounded fixture improvement, not a universal live timing claim.

## New live qualification result

At 2026-10-15T23:55:27.566Z the revised owned runtime path made 44 public read/quote/unsigned-order requests, all HTTP 200, with no 429. The quote boundary passed this time; one original-packet unsigned simulation and its independent economics/trace checks completed. The later global slot check refused the review at **457428262..457428295 (33 slots)**. It did not complete the final executable-code observation, publish an approved candidate, or qualify signing. The receipt is ignored `work/pair-route-live-transaction.json`.

No wallet was unlocked, no private key was used, no signature or transaction submission occurred, no approval/reservation was created, and no remote database, provider, credential, cron, deployment or Git remote was changed. UI and Claude-owned layout files remain untouched. Stock signing/execution stay off; the 32-slot limit is unchanged. A funded test still needs the user's explicit approval for that specific trade.

## Verification

Focused five-file verification passed 151 tests. The first two-worker combined run passed 800/801 tests across 34 files, with one candle API case returning storage 503 instead of the expected stale-revision 409 at `app/api/imported-projects/route.test.ts:1778`. That test passed immediately when isolated (1 passed, 36 filtered out). Its test and candle API source are unchanged. The underlying transient storage failure is unconfirmed; it is not being represented as fixed or ignored.

The final single-worker run of the complete same selection passed **all 34 files and 801 tests** in **448.83 seconds**, including the candle case. The initial parallel failure remains an open test-harness observation; serial success does not prove its cause or fix behavior under load. Logs/selections remain in ignored `work/pair-route-{tests,serial-tests}.log` and their `.cjs` runners.

Production build, subsequent standalone TypeScript and typed lint on all eight changed/new TypeScript files passed. The 1,282 frozen source/config hashes remain unchanged. These selected checks do not establish complete Proxima parity or replace rendered/signed-in/funded verification.

## Next: fewer HTTP round trips

A separate read-only capability proof at 2026-10-15T23:57:34.476Z confirmed the existing configured provider accepts small JSON-RPC batches with correctly mapped response IDs. Five reads used two HTTP requests: genesis/slot, then genesis/floor-bound block height/Rent+Clock. Both responses were HTTP 200 (126 and 629 bytes); the context advanced from 457428851 to 457428852. Network, canonical Rent and same-bank Clock checks passed. The ignored proof is `work/pair-batch-capability.json`; no application batch adapter was introduced in this checkpoint.

Implement a bounded read-only batching transport next, preserving strict response ID mapping, independent per-item context/size checks, aggregate byte/request limits, cancellation and 429 backoff with no retries. Qualify with the existing provider and retain the strict 32-slot refusal. Combining transport calls must not imply that their results are an atomic bank snapshot or attest program semantics.
