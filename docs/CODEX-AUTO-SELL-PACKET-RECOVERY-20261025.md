# Exact Auto Sell unsigned-packet recovery

25 October 2026. Source base `920e8f6`.

Auto Sell journal preparations now retain the exact original unsigned transaction and original summary in one atomic database write. An authenticated saved-only API can inspect an interrupted attempt without generating another order, resetting its allowance or renewing its expiry. The existing browser runner and modal are unchanged; this is not automatic resume or executable trading authority.

## Implemented

The original preparation service keeps its provider-key, history-capacity, both 15-second rate gates, balance, simulation, current-source, expiry and final-write checks. Journal calls additionally verify the installed packet schema before consuming a start or calling a provider. Ordinary manual calls skip these new journal-only branches.

The actual history writer detaches the journal summary before any asynchronous work, captures exact original JSON and keeps returned context tied to the frozen original guard. It builds the original unchanged preparation SQL and bindings. Only the journal branch pairs that statement with the immutable packet insert in `db.batch`. Packet validation requires the existing canonical unsigned-v0 envelope, zero signature, original wallet, hash, byte count and instruction/lookup counts. Summary validation rejects accessors, unexpected fields, duplicate/noncanonical serialization and mismatched context. Neither structural validation nor a retained simulation grants instruction, custody, lifetime or execution clearance.

The packet insert requires the original run, attempt, preparation start and preparation summary, exact hashes/context, current source and open head. Both writes must report one changed row. A zero-row preparation, duplicate legacy preparation, failed packet insert or changed source cannot leave a newly published summary without its packet through this writer. An acknowledgement lost after commit is recovered by the original IDs; no second provider request or write is dispatched. A failed or unknown publication retains its start and full charged allowance.

`GET /api/imported-projects/auto-sell-run-recovery?runId=...&attemptId=...` authenticates the owner, accepts exactly those two selectors, returns `no-store` responses and performs no provider work. It distinguishes:

- `not-started`: the attempt is reserved, with no preparation start.
- `started-without-result`: a start exists but no saved result is confirmed.
- `summary-only`: an older exact summary exists without retained packet bytes. It is not repaired or re-prepared silently.
- `retained`: the original summary and packet pass saved-source, byte and hash checks. This does not imply successful simulation or finalized execution.

Historical recovery works after Stop, archival and expiry. It returns the original timestamps, not a refreshed preparation. Schema readiness uses uncached literal-preserving fingerprints of 26 required objects plus foreign-key enforcement; missing or altered guards refuse before provider work. Record/summary hashes and packet decoding repeat on reads. A missing result or unavailable database never releases allowance.

Journal signing intents remain blocked by the existing SQL insert/update guards. Signing, execution, automatic resume and allowance-release flags stay false. The only preparation adapter remains server-internal; the new API cannot prepare, sign, submit, settle or retry. New journal summaries explain packet retention accurately; historical summary text remains unchanged.

## Verification

**855 tests across 51 files pass**, with zero failures, on Node 24 using at most two workers. This includes the complete matching Auto Sell library/component cohort, saved-profile/run/recovery APIs, actual journal/packet engines, the real preparation adapter, and imported-preparation/conditional regressions. This is scoped regression evidence, not the repository-wide full suite.

Plain TypeScript, twelve-file typed lint and thirteen-file source formatting pass. Native/Turso and actual local D1 tests exercise atomic pair publication, both zero-change cases including a legacy-row race, packet-failure rollback, lost acknowledgements, one-shot dispatch, historical expiry under a controlled clock, source archival/Stop, owner isolation, schema drift, foreign-key refusal, self-consistent metadata tampering and replacement/rowid defenses. Actual adapter/API composition recovers lost responses without repeating provider work. Codec tests use real synthetic unsigned and signed packets; no real wallet is used.

All 153 whole-file migrations apply through Wrangler's real local command. A separate native upgrade preserves all 152 earlier ledger checksums, 193 old table snapshots and two seeded funding rows; integrity and foreign-key checks pass. Additive `0154_auto_sell_run_packets` is source-only, timestamp `1794860000015`. Claude's reserved `0147` remains untouched; the next number is `0155`, subject to rechecking current claims and the journal.

Source-derived comparisons preserve the complete ordinary preparation function and original writer admission, SQL and bindings after removing only the journal additions and normalizing syntax layout. Twenty-four protected files and all 152 prior migrations remain unchanged. The older 0153 engine fixture now explicitly rejects the current writer without packet bytes and separately checks historical SQL association; new packet engines cover current atomic writes on both databases.

An actual Claude Opus 5.5 source-only review of 15 bounded copies completed with zero permission denials, unchanged review copies and no blocker within this checkpoint. Claude did not run tests or verify schema fingerprints. Final journal-only error copy and small test/type refinements were independently verified afterwards, not represented as final-snapshot Opus approval. The companion JSON records the exact reviewed/current source differences.

## Remaining work and limits

The browser runner still keeps its progress in memory. This checkpoint does not connect a resume UI, reconstruct the full original provider response, retain complete runtime provenance, qualify Counter decisions, settle a sale, close a provably unsigned attempt or release allowance. An unresolved start can hold the run indefinitely. Fresh explicit resume consent, configuration/control epochs, receipt-bound settlement and complete runtime/signing qualification remain required before execution enablement.

`retained` means exact historical packet identity. It does not establish current blockhash validity, route/code safety, successful simulation, ownership/control or final settlement. The owner receives unsigned bytes, as with the original preparation response, and could use them outside Bundle; the false flags describe Bundle's authorization boundary. An administrator with raw SQL can also manipulate connection-level `changes()` or schema independently. The private app writer refuses attaching bytes to a legacy summary; database fingerprints and hashes are integrity checks, not protection against a fully privileged administrator.

The per-run 1000-record/32 MiB capacities remain explicit and fail closed. Existing preparation-history limits remain. No production build, browser rendering, signed-in hosted QA, live provider behavior or funded proof is claimed by this verification.

No application/hosted migration, deployment, provider/credential/cron change, real wallet unlock/sign/send, strategy run or funded action occurred. Git deployment remains disabled. Claude PR57/59/60 files and protected parents, the four original AGENTS additions and seven frozen warmup drafts are preserved. Full legitimate parity, durable execution and read-only Jito qualification remain open.
