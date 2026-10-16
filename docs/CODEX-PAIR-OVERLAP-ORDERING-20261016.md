# Pair runtime concurrency review

## Initial observation barrier

Static candidate/mint/Rent/fee checks now begin alongside the runtime's initial account inventory. That inventory still identifies the actual executable programs and intermediate custody scope. Once it resolves, the full first code observation and protected account/Rent reads run together. An internal, optional collector barrier joins all initial evidence after instruction assessment and immediately before original-packet simulation. Ordinary candidate callers retain their existing path.

The runtime owns a child abort scope so a failed parallel branch prevents later simulation/publication and stops further scoped reads. Every context-bearing ordinary read is checked against its actual captured request floor, including floors raised by the runtime wrapper. Code observations validate their own captured starting floor rather than the mutable high-water mark of an unrelated concurrent response. All returned evidence still contributes to the unchanged global 32-slot bound; out-of-order completion does not permit a response below its own request floor.

Three deterministic latch tests hold either initial code or protected accounts while proving static fee reads proceed, prohibit simulation until released, and reject a first code observation with HTTP 429 after fee checks without simulating. Existing runtime, byte bounds, account/auxiliary/Rent, candidate and both API route selections pass together: **9 files / 263 tests** (10.81s). Standalone TypeScript and typed lint on the three changed TypeScript files pass. These are offline ordering proofs, not live latency qualification. No group production code or UI changes; stock signing remains off and no deploy.

## Final observation barrier

After the original-packet simulation, economic checks and inner trace validation, a second internal collector barrier starts fresh runtime inventory and a complete fresh code collection while the candidate's final account/mint/Rent, lookup, validity, height and genesis checks proceed. The fresh code collection uses the original program-address scope, never the original code bytes. Fresh final inventory must independently match that scope, and the native compute marker comes from that fresh inventory. Full before/after identity comparison is unchanged.

The runtime still performs its existing final protected-account/Rent, lookup and lifetime checks **after** code collection. Moving every check earlier caused two existing unchanged tests to miss Rent and wallet changes introduced during final code I/O. This tail preserves those rules and restores both tests; it is not removed or satisfied by the earlier candidate observations. The final height must still be at least the candidate's recheck height. All concurrent replies use their captured request floors, and the unchanged global 32-slot bound is checked throughout and before publication.

A fourth deterministic latch test holds final code after simulation, proves candidate lifetime checks proceed while it is held, prevents publication, and verifies the runtime custody tail occurs after release. The same **9-file selection now passes 264 tests** (9.86s), including both late-mutation tests with their original expectations. Standalone TypeScript and typed lint on the three changed TypeScript files pass. Initial overlap is the separate parent commit `306781c`. No code-identity/group collector changes, real signing, provider setting changes or deployment.

## Strict batch response contract

Per the user's explicit requirement, reordered responses now fail the entire envelope, even when every ID could otherwise be mapped. Missing, duplicate, unknown and wrong-type IDs, wrong cardinality and constituent errors continue to fail the entire envelope without partial resolution or fallback/retry. This supersedes the reordered-reply acceptance described in the previous batching checkpoint.

Each slot-bearing result (`getSlot`, account snapshots, fee, blockhash validity and simulation) is checked against **its own captured minContextSlot**, including the 32-slot relative ceiling, before any constituent resolves. Invalid input floors fail before HTTP. Downstream evidence/Clock checks and the global 32-slot span remain independent and unchanged. `getBlockHeight` carries minContextSlot to the provider, but returns a height without a context slot; a height is not compared with a slot. Genesis replies likewise have no context slot.

The transport's **44 tests** include twelve independently stale/future/malformed-slot batch failures, distinct valid per-method floors, simulation-floor refusal and strict reordered-envelope rejection. The transport, ordering, owned runtime and runtime route pass together: **4 files / 95 tests** (4.86s). Standalone TypeScript and typed lint on the two changed files pass. Final ordering is the separate parent commit `a2806af`. Live provider batching/slot calibration follows as a separate evidence checkpoint; these tests alone do not establish provider support.

## Live provider and wall-clock calibration

Strict batch/floor enforcement is separately committed as `3e7b1c6`. `CODEX-PAIR-SLOT-CALIBRATION-20261016.json` records one read-only timing interval and a real two-method batch at 00:57 UTC. It used one fixed configured RPC URL, three HTTP requests, no endpoint rotation and no provider-setting change. All three returned HTTP 200; no HTTP 429 occurred. The real `getSlot` / `getBlockHeight` batch passed the new exact-ID, exact-order and per-slot-floor validation. This confirms that bounded pair of methods on the configured provider at that time, not every possible batch size or method combination.

| Observation | Value |
| --- | ---: |
| First confirmed slot | 457445491 |
| Second confirmed slot | 457445511 |
| Slot advance | 20 |
| Midpoint wall interval | 4,228.77 ms |
| Estimated seconds per slot | 0.21144 |
| Estimated 32-slot wall budget | 6,766.03 ms |
| RTT-based elapsed interval bounds | 4,002.11 to 4,455.42 ms |

The RTT bounds describe sampling uncertainty, not a statistical confidence interval. One sample is consistent with a roughly 6.8-second budget and cannot rule out node lag or establish a long-run slot rate. The request-scoped transport already pins client reads to one endpoint URL. This is not a guarantee about the provider's internal load balancing or Jupiter's own upstream bank; no alternate provider was introduced.

## Final verification and live qualification limit

All **36 selected files / 853 tests passed together**, two workers, **250.88 seconds**. This includes both ordering barriers, the unchanged late Rent/wallet mutation cases, strict batches/context floors, pair candidates/runtime/APIs, mint/Rent/auxiliary/economic checks and existing group code/runtime/authorization regressions. This is not the complete repository suite. Production build, subsequent standalone TypeScript and typed lint on all five changed TypeScript files pass. All 1,290 frozen source/config hashes stayed unchanged through the run, and the retained probe source hashes match current application source. Whitespace checks pass.

Once build/tests were idle, the old public reference failed its suitability/stability setup check before quoting (three HTTP 200 requests). One bounded discovery using fresh public transaction references then passed setup and reached the owned runtime pipeline, but the unsigned order's minimum deteriorated. It correctly returned the existing fresh-quote refusal before inventory/code/simulation (20 HTTP 200 requests overall, eight logical pipeline RPC reads, no 429). `CODEX-PAIR-OVERLAP-LIVE-20261016.json` retains both sanitized receipts. No live overlap latency or full-path 32-slot qualification can be claimed from these attempts. There was no automatic retry, relaxed minimum, signature, broadcast or funded trade.

Keep the global **32-slot** limit, mandatory two full code observations, final runtime custody/lifetime tail, default one-read-at-a-time group code collection, stock signing/execution **off**, and production untouched. Main's two intentional dirty files remain preserved. The next live qualification needs a genuinely fresh acceptable unsigned order; the offline ordering results do not authorize signing or a funded test. UI, credentials, provider settings, cron, migrations and remote SQL are unchanged.
