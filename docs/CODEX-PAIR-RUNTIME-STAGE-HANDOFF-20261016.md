# Stock-pair runtime stage budget for Claude

## Review checkpoint

The earlier minimum-output check and code-read packing changes are already committed and fast-forwarded into local `main` as **`3ef640e3f970a2d8f13db9b6d88e1a9246b00620`**. See `CODEX-PAIR-QUOTE-AND-CODE-PACKING-20261016.md` for that implementation and its verification. Nothing was pushed or deployed.

This checkpoint only records measurements. It introduces no application/runtime optimization, batching, wider freshness limit, final-code reuse or skipped final recheck. Claude's reported approval of `d1e921b` and `b90e5bc` and 13-file/344-test verification are user-relayed review results.

## Measured attempt

The retained 33-slot capture did not record enough per-RPC slot fields to reconstruct its exact stage costs. The table below is a **new instrumented read-only attempt on unchanged `3ef640e`**, captured at **2026-10-16T00:13:07Z**. It reached simulation and final candidate checks, then correctly refused **457433146..457433183, or 37 policy slots**. It is not being relabelled as the previous 33-slot run or presented as successful qualification.

| Stage | Observed policy-slot advance | Wall time | RPC reads | Result |
| --- | ---: | ---: | ---: | --- |
| Quote, including mint/network checks | 2 | 1.296 s | 5 | Completed |
| Wallet checks and source revalidation | 3 | 0.619 s | 3 | Completed |
| Unsigned order provider / early bounds | 0 observed* | 0.241 s | 0* | Completed |
| Initial account inventory / lookup / custody | 4 | 0.513 s | 3 | Completed |
| First complete executable code scan | **16** | **3.571 s** | **14** | Completed |
| Static candidate / mint / fee checks | 6 | 1.222 s | 6 | Completed |
| Original-packet simulation / economics / trace | 2 | 0.233 s | 1 | Completed |
| Candidate final account / lookup / lifetime / network checks | 4 | 0.952 s | 5 | Refused: global 32-slot bound exceeded |
| Final inventory | Not reached | Not measured | None | Prior guard stopped the attempt |
| **Fresh final complete executable code scan** | **Not reached** | **Not measured** | None | Still required, neither skipped nor reused |
| Runtime final custody / lifetime checks | Not reached | Not measured | None | Still required |
| Final owner/source publication checks | Not reached | Not measured | None | No preview published |
| **Total reached pipeline** | **37** | **8.648 s** | **37** | **Signing and execution remain disabled** |

*These are response high-water advances, not isolated chain-time measurements at each code boundary. No extra `getSlot` request was added. A stage without a slot-bearing response can consume wall time while recording zero observed slots; the next observed bank absorbs that movement. The unsigned-order stage made one Jupiter HTTP request, although it made no Solana RPC read. The quote stage also made a Jupiter request. Concurrent responses can arrive out of order, so the recorder uses the highest observed slot, not response arrival order. These numbers are one provider/route observation, not a stable performance budget or causal proof that a particular computation consumed a particular number of slots.

The initial scalar `getSlot` returned 457433145. The first mint evidence, which anchors the actual freshness guard, was 457433146. Thus the raw response-observation span is 38 slots, while the actual policy span and the table sum are **37**. The first quote row is normalized to the real policy floor. Every per-RPC requested floor, returned context slot, stage and timing is retained in the sanitized [stage receipt](CODEX-PAIR-RUNTIME-STAGES-20261016.json).

The first complete code scan was the largest observed stage. Its 14 RPC calls consisted of **8 code-data slice reads, 4 header/link reads and 2 genesis reads**. It observed seven executable accounts and five upgradeable program-data accounts in its header requests. The method/offset/length/account-count ledger is in the receipt. Cumulative policy advance was **31 slots after static checks and 33 after simulation**, before candidate final checks added another four. The existing global guard then rejected the candidate at 37; no preview was published. This identifies where to investigate; this note does not pick or implement a further fix, drop metadata checks, or estimate the unexecuted final scan's cost.

## Attempt scope and guard behavior

The attempt used public historical fee payer `2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y` in an isolated in-memory database. It was not a user wallet or wallet ownership proof. There were 45 total HTTP requests: 6 reference/identity setup reads, 37 pipeline RPC reads and 2 Jupiter quote/order requests. All returned HTTP 200; none returned 429. Simulation used `sigVerify: false` and `replaceRecentBlockhash: false` on the original unsigned packet. No key was used, no wallet unlocked, no signature generated, no transaction submitted and no approval/reservation created.

An earlier bounded attempt at 2026-10-16T00:12:27Z stopped in setup on the existing inconsistent/stale Clock guard after five HTTP reads. It reached none of the runtime stages, so it supplies no stage cost and is retained separately in the [setup refusal](CODEX-PAIR-RUNTIME-STAGES-SETUP-20261016.json). The exact Clock discrepancy was not captured in that first attempt. There was no automatic retry loop; these were separate bounded diagnostic invocations with unique receipt paths.

The final recheck remains a fresh call to `identities(afterInventory)` followed by exact vector comparison with the first complete scan. The new attempt stopped before that call. It has not qualified the full runtime path, and incomplete evidence does not authorize signing.

## Group read concurrency and verification

`collectPumpProgramIdentities` still defaults to `maxConcurrentCodeReads = 1`. Its adaptive packing branch requires the explicit four-read profile. Both runtime service calls and the broadcast service call omit that fifth argument. Therefore group signing/authorization/broadcast rechecks remain at **one code-data read at a time**. Stock-pair runtime alone opts into four. Unknown-size code remains serial even there. No production source changed for this measurement.

The local QA bundler added synchronous observer statements to five loaded modules. Removing those exact statements reproduced each original file byte-for-byte; source hashes and stage anchors are in the receipt. It did not alter arguments, packets, return values, branches, limits, clocks, deadlines, provider pacing or RPC count. The recorder uses monotonic elapsed time, stores only metadata in memory during execution, and serializes after the attempt. The small observer overhead is part of these diagnostic wall times.

Seven recorder checks passed: setup exclusion, parallel response high-water handling, stage-cost additivity, no-slot stage timing, failed-stage retention, unreached final stages remaining null, and empty attempts. Both exporters verify receipt invariants, zero signatures/broadcasts and exact slot-sum correspondence. All **1,282 frozen source/config hashes remained unchanged**, and main's two unrelated dirty files were verified intact. Build/TypeScript/lint and 801 serial regression tests are the existing `3ef640e` verification, not newly repeated tests for this documentation-only checkpoint. That checkpoint's unexplained parallel candle 503 remains documented as unresolved.

Local diagnostic harnesses remain in the Codex checkout's ignored `work/`: `prepare-pair-stage-profile.cjs`, `pair-stage-recorder.mjs`, `pair-stage-recorder-check.mjs`, and the two receipt exporters. The committed receipts contain no endpoint URLs, credentials, cookies, wallet keys or transaction packets. No UI, provider configuration, credential, cron, hosted database, push or deployment was changed.
