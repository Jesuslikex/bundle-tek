# Live unsigned stock runtime qualification

Scope: finish the read-only 32-slot stock runtime qualification with signing hard-disabled. No deployment, provider/credential/cron change, remote SQL, user wallet unlock, signature or submission. Probes use a public on-chain system-account reference in an isolated in-memory SQLite database, not the user's wallets or a claim of key ownership.

## Current result: one complete live pass, broader qualification still open

At 2026-10-16 13:26:54Z, **SOL 0.001 -> TSLAX passed the entire unsigned runtime lifecycle in 30 policy slots**, 457653824..457653854. The original unsigned packet was simulated once with `sigVerify: false` and `replaceRecentBlockhash: false`. Both full code observations completed and their identities matched exactly. Eleven executable identities cover 8,060,235 bytes per observation; fifteen logical code-profile calls per observation include genesis/header reads, not fifteen code-data slices. Candidate checks and the fresh final custody, lookup, validity, height and genesis tail all completed before the immutable local-only review returned. The overall order-first lifecycle took 8,667.77 ms, including the initial preview and preparation before the fresh runtime floor. There were 67 total HTTP 200 responses and no 429, signature or broadcast.

This is **one observed route pass, not universal or repeatable stock-pair readiness**. All 23 attempts, including setup failures and guard refusals, are summarized with original receipt hashes in [the evidence package](CODEX-STOCK-LIVE-QUALIFICATION-20261016.json). It embeds the complete successful receipt and representative failures. The passing route contains DefiTuna, RaydiumClmm, Hadron and Riptide. No DEX/router exclusion, account-count reduction, smaller code slice coverage, cache or reused final scan was introduced to produce it.

| Checkpoint in successful observation | Highest relevant slot | Policy advance from floor |
| --- | ---: | ---: |
| Fresh runtime floor | 457653824 | 0 |
| First complete code observation finished | 457653840 | 16 |
| Original packet simulation | 457653840 | 16 |
| Fresh final complete code observation finished | 457653853 | 29 |
| Final custody/lookup/lifetime tail and publication | 457653854 | 30 |

These are observed context high-water checkpoints, not additive independent stage costs: checks overlap, and a response without a context slot cannot isolate chain advancement. Both scans include fresh deployment metadata and all bytes. Runtime lifetime/height/custody checks repeat after the final scan. A later final-source SOL attempt finished both full scans but was refused because the public reference account changed; another stopped during preflight for the same reason. USDC 1 -> TSLAX has **not passed**: retained failures include a 33-slot span and mismatching quote parameters. A subsequent bounded quote-only diagnostic accepted exactly matching input/mints/ExactIn/50-bps fields, so it did not reproduce or explain the intermittent mismatch and is not another runtime qualification. Its sanitized booleans are in the evidence package. The 23-attempt count excludes that standalone quote inspection and the initial precision-only inspection. No tolerance, original minimum, trace policy, custody check or Clock rule was relaxed.

## Further committed optimizations and rate accounting

Compatible simultaneous `getMultipleAccounts` reads can now share one physical read when configuration and response bounds match, using the higher floor. Every child keeps its own requested floor and 32-slot ceiling, original key ordering and exact result cardinality. Expansion and validation of all children finish before any publication; a partial/old/oversized child rejects the entire HTTP envelope. Only the current request queue is combined, with no result cache across observations or simulation. Code headers get queue priority, and a second microtask coalesces reads released by an already-resolved collector barrier. Whole-envelope/raw-code limits and max two methods/four HTTP remain unchanged.

Final network observations overlap the final mint/wallet snapshot and both still must pass before publication. Deterministic latch tests hold account reads while asserting the fresh genesis call starts and publication remains pending. The private diagnostic cause on the generic candidate error is nonenumerable: the public 409 and message are unchanged; a regression proves the cause is not serialized.

The existing 200-ms HTTP interval remained a bottleneck for single-method code slices. The internal unsigned qualifier now explicitly opts into a Helius-mainnet-only pacing profile. It targets nine logical methods per second, charges each physical batch for its actual one or two upstream methods, and enforces at most nine admissions in any rolling second. A serialized admission queue rechecks actual time after timers; cancellation does not send/retry. Intervals above 200 ms remain respected. No environment variable, endpoint, account, plan or credential changed. The normal application/authorization constructors still select the configured profile, and every group collector keeps its serial default. If ordinary reads share the qualifier's process and endpoint, they retain their configured interval and are conservatively charged two methods against that same admission budget. This opt-in timing result is not a claim that the default configured application path has qualified.

The successful receipt's recorded HTTP starts independently yield a maximum of nine RPC methods per rolling second. The subsequently committed harness also checks this automatically, hashes itself, and records the metric. **Every production source hash recorded in the successful receipt still matches `3489415`**; the later harness-only additions changed no production source, packet, guard or scheduling. The stock signing policy remains hard-coded false. The database rule against signable reviews, exact consent, five-second server authorization, reservations and trusted-program requirements are unchanged.

## Review checkpoints

- `2f569d3`: bounded provider precision, exact numeric bounds.
- `7df8508`: internal one-simulation qualification lifecycle and bounded reusable probe.
- `bd131bb`: validated native code decoding for the explicit pair profile; serial group decoder unchanged.
- `284d98c`: small full-account packing hints, with unchanged actual response limits.
- `f6cecf1`: compatible account-read coalescing and header queue priority.
- `5fb0f4b`: fresh network/account observation overlap.
- `7460cb7`: private failure cause, unchanged public refusal.
- `3489415`: explicit method-counted unsigned Helius pacing, controlled-clock tests, richer probe accounting.

## Remaining boundaries

Stock signing and execution remain off, and nothing is pushed or deployed. This evidence does not establish trusted executable policy, semantic audit, application reservations, signing-window execution, a funded buy/sell, or repeatable qualification for every route. The probe uses an isolated public account reference, not a user wallet or ownership proof. Its market-observation table is intentionally empty, and the review explicitly says no saved observation is available; actual saved-market comparison and the extra acknowledgement were unit tested in the preceding release, not exercised live here. Invalid provider quotes, changing public balances and >32-slot routes must continue to fail closed. Next qualification work should diagnose the direct USDC parameter mismatch and obtain repeatable stable-reference observations, not enable signing from this single pass.

Full original per-attempt receipts are retained under the Codex worktree's ignored `work/stock-qualification-*` folders. The committed package contains sanitized metadata, code/packet hashes and public executable identities only. No raw transaction packet, provider URL/key, wallet key, cookie or user database was exported. Main's two pre-existing dirty files and Claude-owned UI files remain untouched.

## Final verification

On the final committed implementation (`3489415`), **54 related pair/group/quote/pacing/scheduled-multiplier test files passed together, 794 tests, zero failures**, two workers, 713.97 seconds on Node 24. The exact selected filenames are recorded in the JSON package. This is a targeted combined regression run, not the entire repository test suite. The production Next/webpack build passed, followed by plain `tsc --noEmit` with zero errors. Fifteen touched backend/test/script files passed scoped typed lint. Evidence invariants independently verified the single 30-slot pass, both complete scan call counts, all 23 retained runtime-attempt summaries, original production file hashes, max nine observed RPC methods per rolling second, all passing-response statuses 200 and zero signatures/broadcasts. `git diff --check` passed.

No migration was edited or applied, locally or remotely, for this qualification task. No UI file, provider configuration, credential, cron, user wallet, signing gate or hosted release changed. Local commits are for Claude review only. The preserved dirty files are `docs/CODEX-JITO-ATOMIC-BUNDLES.md` and `drizzle/0068_remarkable_frightful_four.sql`.

## First observed blocker: provider display precision

The first bounded live order-first attempt stopped before simulation/code scans on `Invalid order price impact estimate.` All 13 HTTP requests returned 200, no 429, and no transaction was sent. One additional bounded unsigned-order metadata inspection observed a string `-0.0004986315722698763`, 19 fractional digits. Only that numeric field/type/length were displayed; credentials, wallets and packets were not printed.

The display-only parser now preserves up to 60 fractional digits, still bounded to absolute value <=100 with exact decimal checks (including values that Number would round to 100). It never rounds a tiny value to zero or alters transaction economics. New tests retain the captured precision and reject exact over-bound values. Three quote/review/bounds files pass 53 tests; scoped typed lint is clean. Minimum-output/slippage/input/fee checks are unchanged.

## Qualification lifecycle (next checkpoint)

The internal qualification entry point follows initial Jupiter preview -> unsigned packet -> fresh quote/owned preflight -> one traced runtime simulation with both complete code scans and the existing final custody/lifetime tail -> immutable local-only review evidence. It does not simulate an ordinary candidate first, reuse a scan, create an approval, or enable signing. There is no client-selectable qualification flag. Runtime/trusted policy/reservations remain false as before. Live receipts will record actual slots and stage timing, not infer success from unit tests.

The entry point and reusable one-attempt script are separate from the display-precision repair. Five qualification tests prove exact quote/order/quote sequencing, one simulation, all six header/body/recheck reads per fixture program across two observations, changed-code/33-slot/cancellation refusal and no client flag. Existing owned service and ordering tests also pass (23 cases). The script permits only read/quote/original unsigned simulation methods, captures only sanitized metadata, stops on 429 and makes no automatic retry. It uses the configured endpoint unchanged; it does not access a real app database.

## Measured bottleneck and bounded optimizations

After the precision repair, one attempt refused an inconsistent/stale chain Clock before scanning; a later retained public reference changed between reads and was refused. Fresh public-transaction reference discovery then reached one traced simulation and both full code observations: 59 HTTP 200 requests, no 429, 11,654.75 ms for the order-first lifecycle. Fresh quote slot 457647003 reached final code metadata slot 457647046, already 43 slots before the remaining custody tail. It correctly failed to publish. The full receipt retains Clock slot/Unix/skew and logical read timings; no freshness tolerance was relaxed.

Two independent optimizations follow this measurement: (1) the explicit four-read code profile uses native base64 decoding into owned Uint8Array bytes after the unchanged canonical envelope validation, while default group serial code remains unchanged; binary-vector/full-hash and malformed-base64 tests verify parity. (2) full-account packing now uses bounded size hints (64 KiB per unknown account) for scheduling, instead of assuming every small wallet snapshot fills the entire response allowance. These are hints only. Max two methods/four HTTP, normal 512-KiB and code 2-MiB whole-envelope caps, aggregate 1-MiB raw code, exact IDs/order/floors and no-retry policy remain unchanged. Underestimation rejects the entire envelope before any result resolves. Four targeted files / 72 tests pass. Each optimization is committed separately for Claude.
