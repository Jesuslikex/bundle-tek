# Stock-pair repeatability check, 16 October 2026

**Result: not repeatable in this sample. SOL 0/3, USDC 0/3. Signing remains off.**

Tested unchanged source at `a0d03cf` with three fixed alternating SOL/USDC rounds, 14:34:28 through 14:35:26 UTC. Each run independently selected a public transaction reference and built a fresh unsigned TSLAX order in isolated in-memory storage. Amounts: SOL 0.001 and USDC 1. No replacement attempts, retries, reused orders or cached code scans. The earlier isolated 30-slot successes remain historical observations, not repeatability evidence. These references do not establish ownership or funded user-wallet behavior.

| Round | Input | Result | Runtime time | Simulation | Code-profile reads before/after simulation |
| --- | --- | --- | --- | --- | --- |
| 1 | SOL | Freshness refused at 457672625..457672671, 46 slots | 11.658 s | 1 | 26 / 26 |
| 1 | USDC | Original minimum-output bound refused a worsened unsigned order | 2.248 s | 0 | 0 / 0 |
| 2 | SOL | Inconsistent or stale chain clock | 3.919 s | 0 | 8 / 0 |
| 2 | USDC | Candidate instruction/account/raw-spending review refused | 4.292 s | 0 | 8 / 0 |
| 3 | SOL | Candidate instruction/account/raw-spending review refused | 4.807 s | 0 | 8 / 0 |
| 3 | USDC | Invalid balance-provider response during mint identity setup | Not started | 0 | 0 / 0 |

Code-profile counts include metadata reads, not just code-data slices. Final scan activity in the first run does not imply completion of the final comparison/custody/lifetime tail: the runtime refused freshness. Failed runs have no completed-runtime slot span; the 46-slot span is the exact failing guard's diagnostic, not an invented success receipt.

All six receipts report zero 429s, at most nine RPC methods in a rolling second, unchanged source, zero private keys/user wallets/signatures/broadcasts and signing/execution false. There were 253 completed HTTP 200 responses across 258 request records; five leftover requests have no status after cancellation. HTTP 200 does not establish valid JSON-RPC account evidence, as the last refusal demonstrates. No provider account, endpoint, credential, cron, transaction limit or production runtime code was changed.

## Evidence and reproduction

`CODEX-STOCK-REPEATABILITY-20261016.json` embeds all six sanitized original receipts, their exact-file SHA256 hashes, source hashes, per-phase observed slot ranges, rejection reasons and the offline summary. No environment values, URLs, credentials, unsigned packet bytes or private runtime bundles are included.

The new `scripts/summarize-stock-repeatability.mjs` is an offline checker only. It requires exactly six chronological alternating attempts on identical source, retains refusals in the denominator, rejects duplicate/reordered receipts and unsafe action/pacing evidence, and refuses claimed passes without a single simulation, both code phases and a completed <=32-slot runtime. It reports only sample repeatability, never signing authorization. It cannot independently prove the runtime from diagnostic counts; the unchanged runtime remains the enforcing implementation.

Reproduce the bounded live set manually with the existing qualifier: three rounds, sequentially running `node --env-file=.env.local scripts/qualify-stock-pair-runtime.mjs --live-readonly`, then the same command with `--quote-usdc --one-unit`. Pass the six resulting `receipt.json` paths in that order to `node scripts/summarize-stock-repeatability.mjs NEW_OUTPUT.json SOL1 USDC1 SOL2 USDC2 SOL3 USDC3`. The output uses exclusive creation and will not overwrite an earlier evidence file. Do not run concurrent probes against the paced provider.

## Verification and remaining work

- Offline checker: five deterministic Node tests pass, including rejected-source/duplicate/unsafe/missing-final-scan/>32-slot evidence and keeping failures in the denominator.
- Runtime regression selection: seven Vitest files, 141 tests pass in two bounded runs: pair-read-rpc, pump-group-code-identity, pair-order-first-service, pair-order-quote-bounds, imported-pair-runtime, pair-runtime-ordering and pair-order-first-qualification.
- Scoped lint and formatting pass for the two new tooling files. Production source is unchanged; no new build, full-suite, rendered browser or funded acceptance claim.
- Next: narrow the instruction/account/spending mismatches with sanitized field-level diagnostics; establish whether clock refusal comes from provider lag or read timing; then reduce the code-heavy route's latency and rerun a fixed set. The 32-slot bound, minimum-output rule, fresh final code scan and serial default group reads must remain intact.

No push, deployment, remote migration/SQL, wallet unlock/sign/send, UI edits or signing enablement. Claude-owned files and main's two unrelated dirty files are preserved. Local migration 0091 remains unapplied remotely. Trusted program policy and application reservations are still separate blockers even if later samples pass.
