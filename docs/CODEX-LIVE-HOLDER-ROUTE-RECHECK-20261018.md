# Live holder route recheck, 18 October 2026

Source commit: `85b55eaa068d7dcd44064d2b3762bb20bbb1c1e4`.

The actual holder-index POST/GET route passed a fresh bounded read-only check at 20:14 UTC using the existing Helius indexer. The public mint was `Ap1o2WJYUarJLjT5LQWGH1ztuiV4PcUyqEEfL8jbpump`. Two pages enumerated two accounts and two positive owners, covering the reference supply of 1000000000000000 raw units with zero remainder. All eight RPC calls returned HTTP 200; no retry or rate-limit refusal occurred.

Both pages were persisted and reloaded through the real route with disposable local D1, and both exact page replays used zero additional provider reads. Foreign-owner access returned 404. All 115 current migrations were applied only to that disposable database. Authentication was a synthetic test owner. No production database write, signing, broadcast or provider-setting change occurred.

One opt-in live test passed in 17.624 seconds (21.05 seconds including setup). All eleven captured source/harness SHA-256 values matched after the run. Original local evidence remains under `work/live-provider-qa/holder-route-recheck-20261018.json` and `work/release-qa/holder-route-recheck-20261018*`; ignored runtime files and private configuration are excluded from Git.

This establishes current provider/route persistence and replay behavior for one small public mint. It does not establish signed-in production behavior, same-bank atomicity across pages, every token extension, large-mint coverage, general provider reliability or complete Proxima parity. No application code changed.
