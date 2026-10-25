# Jito retained replay pacing fix

25 October 2026. Full read-only qualification is still not passed. No program pin, slot limit, provider setting or signing authority changed.

## Measured blocker and change

A fresh, single unsigned public-reference SOL-to-USDC diagnostic on `fb0b44e` made 26 read-only HTTP requests, with no 429, signing or broadcasting. It refused in `runtime-before` at captured context 461294246 against original floor 461294213, a 33-slot span. That last context is refused diagnostic evidence, not an admitted slot. Program policy was not reached in this attempt.

The new outer timing shows why the gap grew: retained baseline replay spent **1902.815 ms** between its begin/finish marks, despite reading only already-captured bytes. `simulateImportedSwap` reused `balanceRpc`, which unnecessarily paced that local replay and advanced the ordinary endpoint queue. Initial baseline acquisition took about 2041 ms, tip preparation 378 ms, network check 279 ms and initial lookup 175 ms. The initial runtime branch took 2812 ms before refusal. These overlapping/process-monotonic durations are diagnostic measurements, not a trusted validator clock or quantities to sum indiscriminately. Compilation was before the quote and is reported separately.

`createJitoRetainedRpcReplay` now owns detached retained request/response bytes in a closed process-local fetch function. It has no network callback or provider-forwarding path. Only that exact function object, registered in a private WeakSet, omits live RPC pacing. Callers cannot select this through flags, properties, wrappers or proxies. Ordinary captures and actual provider calls remain paced. The original balance response parser, envelope/integer/stream bounds and all simulation/settlement checks still run.

Endpoint, POST method, exact body, sequence and signal must match; extra, missing, cancelled or changed reads refuse. Intrinsic typed-array length/copy handling refuses proxy size spoofing and does not consult a custom iterator. Caps remain 32 records, 512 KiB per response and 16 MiB total. The original issued-capture identity, whole/per-read hashes, stored simulation comparison, expiry and final signing-review checks remain. The replay factory itself creates no trusted capture or authority.

## Outcomes retained

| Sample | Result | What it proves |
| --- | --- | --- |
| Pre-fix live diagnostic | 26 HTTP reads; runtime-before refused at F+33; no 429 | Measures the local replay pacing defect and remaining slot pressure; no policy or full-runtime pass |
| Post-fix live diagnostic | One Jupiter unsigned-order GET returned HTTP 400, `Failed to get quotes`; no baseline/runtime reached | Provider quote refusal only; no post-fix slot measurement; no retry or replacement |
| Offline historical baseline replay | All ten retained requests consumed, original reproduced simulation equal, replay **28.600 ms**, zero network requests | Confirms local replay delay removal for these retained bytes; uses an explicitly controlled past clock, so establishes neither freshness nor live qualification |

The 29 ms measurement was taken after byte-copy hardening and before a final equivalent intrinsic-getter invocation style change required by lint. Final controlled-clock tests cover the checked-in implementation. A 1.9-second local delay removal does not prove the remaining live path, both scans and exact-bank simulation fit within 32 slots.

The historical Jupiter router pin mismatch and unlisted Tess from the prior 24 October run remain unresolved policy questions. No observed hash was added just to obtain a pass. Claude acknowledged that it has no Jito work underway or reproduced-build/provenance evidence. Its proposed separate stock-pin scan/PR is not a Codex policy approval or semantic audit, and no permission rejection was bypassed. PR59 route filtering alone cannot resolve the mandatory router mismatch.

## Verification and coordination

The companion JSON records final owned source hashes and test/review outcomes. Final related run: **888 tests in 40 files**, plus **19 offline native harness tests**; plain TypeScript, five-file typed lint and formatting pass. Controlled fake-clock tests use the real pacer: replay completes without advancing queued timers, and the next real read keeps its original 4000 ms queue position. Other tests cover exact function identity, parser refusals, cancellation, completeness, detached bytes and spoofed byte length. No full repository, rendered browser, production build or funded proof is implied.

Actual `claude-opus-5-5` source-only review completed on 12 unchanged copied files, zero permission denials and no blocker. It ran no tests. Its low-severity byte-copy and real-pacer-test suggestions were implemented and independently verified by Codex; these final follow-ups were not rereviewed.

Codex checked open PR57/59/60 and posted a focused check-in on PR59; Claude explicitly acknowledged the disjoint split. Claude's files, stock pins/route filtering and marketplace checkout/migration0147 remain untouched. OpenCode's prior vault PR58 is merged; its existing usage-limited session has no accepted new claim, and was not restarted or replaced. Shared handoff and AGENTS are updated. Original four AGENTS additions, seven frozen warmup drafts and pending protected recovery-navigation patch are preserved.

No deploy, application/hosted SQL, provider/credential/cron change, real wallet unlock/sign/send, strategy run or funded trade occurred. Next: reviewed program provenance/policy, provider quote availability and a separately retained live measurement of the remaining complete path. Both full serial scans, original F..F+32 and every custody, Clock, Rent and minimum-output condition remain unchanged.
