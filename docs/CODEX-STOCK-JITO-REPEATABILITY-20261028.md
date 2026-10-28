# Stock and Jito read-only repeatability, 28 October 2026

This checkpoint does not qualify either flow for trading. No deployment, hosted SQL, persistent provider/credential/cron change, real wallet signature, broadcast or funded transaction was made.

## Stock scanner

The declared-size, four-read, 100-account stock profile now uses a sliding window of at most four independent code reads instead of waiting for the slowest member of each group. Slices, full ordered bytes and hashes, per-read floor and original 32-slot checks, 720 KiB per-slice and 1 MiB per-request limits remain. The default serial group path and five-account path retain their existing schedule. On the first error the new window stops, aborts its other reads, settles the worker wrappers and returns the original error. A transport that ignores its abort signal can continue its underlying request, but its late response cannot produce a result or start another read.

Deterministic tests compare the exact mixed-loader slice plan with the committed predecessor, verify the full hashes and deployment header, exercise out-of-order completion, stragglers, 429 and external cancellation, and check bounded concurrency and no new post-stop dispatch. An independent source review found the initial in-flight cancellation gap; it was fixed and the follow-up review found no further blocker in that scope.

One fixed alternating SOL/USDC read-only campaign then ran using the existing fallback endpoint and settings. It stopped on the first 429; no attempts were replaced.

| Attempt | Outcome |
| --- | --- |
| SOL | Refused: snapshot slots 462553427–462553468, a span of 41; no 429. |
| USDC | Refused after one HTTP 429; candidate reported cancellation or timeout. Campaign stopped. |

Both receipts report unchanged source, zero signatures and zero broadcasts. The campaign was incomplete, so it cannot support repeatability or infer the results of the four unrun attempts. Historical USDC 42-slot results and this SOL 41-slot result use different requests and are not a controlled before/after performance comparison. The original 32-slot limit, both code scans and strict early minimum remain unchanged. Raw private evidence is retained in ignored `work/stock-repeatability-2026-10-28T17-01-40-315Z/`; provider details are not published.

## Jito

Concurrent read-only qualification invocations now have separate diagnostic stages. A deterministic test reproduces the former cross-run wrong-stage report and verifies isolation, cancellation and reset for the next run. No admission rules or authority flags change.

A separate fixed three-attempt native diagnostic used unsigned zero-value transfers, not real swaps. All three refused fee/simulation-bank mismatch: fee versus simulation banks were 462552488/462552486, 462552495/462552493 and 462552502/462552499. No retry, signature or broadcast occurred. These results are retained under ignored `work/release-qa/jito-native-exact-bank-20261028/` and do not establish full swap, economic or runtime qualification.

The existing private collector already composes raw mint/Rent brackets and both runtime scans. The latest real-swap qualification stopped at its reviewed program policy before reaching complete simulation/final evidence. A fresh external review found no reproducible source/build or official binary attestation linking the deployed Jupiter router to reviewed source. The [public verification record](https://verify.osec.io/status/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4) reports it unverified; [Jupiter's audit index](https://developers.jup.ag/docs/resources/audits) does not establish that the current binary matches an audited version. A read-only public validator check matched the previously recorded program deployment header, but did not rehash its code or prove source provenance. This is not a finding that the program is unsafe. Do not automatically repin it or admit unlisted route programs merely to obtain a pass.

## Verification and next steps

On Node 24.22.1: 360 focused tests across 13 files, 36 native/campaign script tests, TypeScript, scoped typed lint and formatting pass. This is not a full suite or production build; the isolated worktree reused installed dependencies whose Next version differs from the current lockfile. No final full-source Claude review or signed-in browser check is claimed.

Full qualification remains open: investigate the 41-slot timing and rate-limited runtime using a suitable approved provider profile, and establish a reviewed Jito program policy and a provider that can provide coherent same-bank evidence. Preserve the original constraints, keep stock signing off, keep every refusal and do not send or deploy without separate authorization. Shared worktree changes on the user's original checkout were not touched.
