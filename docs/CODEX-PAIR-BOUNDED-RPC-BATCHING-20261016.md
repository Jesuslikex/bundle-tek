# Unsigned stock-pair RPC batching and stage follow-up

This follows Claude's approval of `3ef640e`, the stage handoff `3f99d2c`, and the quote-error mapping fix `d4b3ef8`. Both candidate and runtime APIs now map early and repeated instruction-review `PairOrderQuoteBoundsError` failures to the same fresh-quote HTTP 409, with no-store caching. See `CODEX-PAIR-QUOTE-ERROR-MAPPING-20261016.md` for the four actual route regression cases and parent-source failure replay.

## Implementation

The unsigned pair runtime's default provider now uses a request-scoped transport in `lib/pair-read-rpc.ts`. Explicit dependency injection remains available for isolated tests. No signing or group transport uses this adapter.

- Coalesce at most two independent logical reads per HTTP envelope, without deduplicating or reusing results. Keep every original method, parameter, commitment and context floor; map responses by unique exact IDs, including reordered responses. Validate the entire envelope before resolving any of its constituents.
- Allow only the runtime's required read methods and its unsigned original-packet simulation (`sigVerify: false`, `replaceRecentBlockhash: false`). No send, bundle submission or airdrop method is accepted. Maximum four HTTP requests in flight, 64 outstanding logical reads and 32 KiB serialized parameters per logical request.
- Retain HTTPS, manual redirects, no-store, the existing endpoint and configured pacing interval. Pace once per HTTP envelope. This deliberately permits up to two logical methods per paced HTTP request; it does not preserve the former logical-method rate. Providers may meter individual batch methods separately. A provider failure trips the request's circuit, cancels queued/active work, and never retries or falls back to singles. HTTP 429 retains the existing typed status/backoff mapping. No provider or credential setting changed.
- Bound the entire streamed response by the smallest constituent limit: 512 KiB for ordinary reads or 2 MiB for code-only reads. Check actual aggregate decoded account data against 1 MiB whenever an envelope contains code-profile reads. Each requested per-account slice remains at most 720 KiB. Two 720 KiB slices therefore stay in separate envelopes; two 360 KiB slices can share one. Misleading length hints cannot increase either bound.
- Retain at most 256 declared account-length hints within this one request for conservative packing. They contain no account bytes, slots, identity evidence or results. Both complete program-code observations still issue new requests and hash newly fetched bytes. The final observation is never skipped or satisfied from the initial scan.
- Abort stalled fetches and streamed bodies, cancel late responses, sanitize generic provider failures, preserve exact u64 JSON spelling, and dispose the adapter on every runtime exit.

`pump-group-code-identity.ts` and all group production files are unchanged. The collector's default remains one code-data read at a time. Its existing one-read-per-request slices and limits are unchanged.

## Measurements and limits of the evidence

These are individual public-reference probes, not repeatable performance benchmarks. They used the existing approved read-only provider settings, a public historical fee payer and isolated in-memory owned SQL. They involved no user wallet, private key, real signature or submission. Instrumentation added only removable observer statements, with exact source equivalence checked after removing those statements. It made no extra slot reads. Pipeline read functions were injected for recording around the same transport factory used by the default service; the probes do not constitute a default-environment end-to-end test.

The earlier committed unbatched observation used **37 policy slots** and failed during candidate final checks, before the final inventory and full code recheck. Its initial code scan took 16 policy slots. Full details remain in `CODEX-PAIR-RUNTIME-STAGES-20261016.json`.

The **preliminary** batching probe at 00:36 UTC reached both complete code collections, then refused the accumulated **46-slot** span (`457439519..457439565`). It ran before the final extra aggregate raw-envelope check and is historical evidence for that intermediate implementation, not a qualification result for the final source. Its source hashes are retained in `CODEX-PAIR-BATCH-STAGES-20261016.json`.

| Stage | Policy slots | Logical RPC reads | RPC HTTP requests |
| --- | ---: | ---: | ---: |
| Quote | 2 | 5 | 5 |
| Wallet checks | 3 | 3 | 3 |
| Unsigned provider order | 0 observed | 0 | 0 |
| Initial inventory | 4 | 3 | 3 |
| First full code observation | 12 | 14 | 11 |
| Static candidate checks | 5 | 6 | 5 |
| Original-packet simulation | 1 | 1 | 1 |
| Candidate final checks | 3 | 5 | 4 |
| Final inventory | 2 | 1 | 1 |
| Fresh full code observation, then global-span refusal | 14 | 14 | 11 |
| Runtime and publication final checks | Not reached | 0 | 0 |

The preliminary pipeline mapped 52 logical RPC reads into 44 HTTP requests, saving eight round trips within that probe. Including six reference-setup RPC requests and two Jupiter requests, it made 52 HTTP requests, all HTTP 200, with no 429s. Pipeline elapsed time was about 10.8 seconds. The first scan's lower observed cost does not establish a stable speedup across different live banks or routes. The later stages still exceed the global window. Unreached final checks have unknown cost, not zero cost.

The **final implementation** probe at 00:40 UTC stopped earlier because the unsigned order offered less than the original minimum output. It correctly requested a fresh quote before inventory, code reads or simulation. All 16 requests returned HTTP 200 and none returned 429. Its exact source hashes, refusal and unreached stages are in `CODEX-PAIR-BATCH-FINAL-PROBE-20261016.json`. This probe does not establish final-source performance for the later stages.

## Verification

The final combined selection passed **35 files and 834 tests**, with two workers, in **241.70 seconds**. This includes the transport, owned runtime, both quote-bound API routes, pair state/instruction/economics/mint/Rent checks, group code identity/runtime/authorization regressions, and existing swap/signing integration fixtures. It is a selected regression run, not the complete repository suite. Separate unchanged pacing/balance-parser tests passed **2 files and 13 tests**, and all **7 stage-recorder checks** passed.

The final production build, subsequent standalone TypeScript and typed lint on all four changed TypeScript files passed. The final run's 1,287 frozen source/config hashes were unchanged; the final probe's application hashes also match current source. Whitespace checks passed. The final probe receipt was added separately without modifying application source.

The transport tests cover reordered/absent/duplicate/unknown IDs, wrong JSON-RPC versions, whole-envelope rejection on a constituent error, precise u64 values, frozen parameters, two-method limits, normal/code response bounds, stale length hints, actual aggregate raw-byte overflow, provider 429 without retries, stalled fetch/body cancellation, write-method refusal and changed simulation-policy refusal. Two owned runtime fixtures use a 3 MiB ELF program: the unchanged program completes both fresh code observations and one unsigned original-packet simulation; changing a code byte after simulation rejects the final observation. All success fixtures still report signing and execution disabled.

The first parallel selection passed 831/832 tests, with the scheduled stock-multiplier stable-quote case failing a quote freshness check. That test fixed the service clock while its mock provider used wall time. The two scheduled-transition cases now freeze Date for both sides, restoring real time afterward; production freshness tolerances and transition boundaries are unchanged. The first lint attempt also caught test-only generic body stringification; the mocks now assert a string request body before parsing it.

No UI files, provider settings, credentials, cron, migrations, hosted SQL, push or deployment changed. Main's two intentional dirty files must remain byte-identical: `docs/CODEX-JITO-ATOMIC-BUNDLES.md` and `drizzle/0068_remarkable_frightful_four.sql`.

## Next handoff

Keep **32 slots**, the mandatory fresh final complete code observation, the default serial group reads and stock signing/execution off. Batching alone has not qualified the live stock route. Before selecting another optimization, use the recorded first/final code costs and the still-unreached final checks; any further live measurement must retain original-packet simulation, quote bounds and all final checks. Code identity does not establish semantic auditing or a trusted signing policy. Do not deploy without the user's request, and do not run a funded trade without their approval for that specific trade.
