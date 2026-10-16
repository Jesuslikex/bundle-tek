# Quiet references found; qualification still refused

Implementation checkpoints: 1896062 pins per-asset references and records the first fixed sample/diagnosis; 8614edd separately narrows the USDC fixture to an absent wrapped-SOL ATA in both snapshots. No production source or Claude UI changed. The final offline checker also refuses any claimed pinned-reference pass with its identity missing.

Both fixed samples are retained. Each has three alternating SOL/USDC rounds. All twelve attempts had unchanged before/after observed public-reference activity. No replacement attempts, retries, reference rotation within a sample, 429, signature or broadcast. Every refusal remains in its sample's denominator. SOL 0/3 and USDC 0/3 in each sample. This has resolved the observed busy/missing-fixture problem for these samples, not established future inactivity or repeatable runtime qualification.

The second discovery selected SOL idle for 216411 slots and USDC idle for 16911 slots; USDC had 2362227156 raw units and no existing wrapped-SOL ATA. The same pinned per-asset references were freshly checked on every subsequent attempt. Public reference identities are hashed in committed evidence; their actual public addresses stay in ignored work. The second discovery, all six unmodified receipts, hashes and offline summary are in CODEX-PAIR-PINNED-SETUP-EVIDENCE-20261016.json. The first discovery revisions and six other receipts remain in CODEX-PAIR-PINNED-REFERENCES-20261016.json.

| Second sample | Exact refusal | Classification |
| --- | --- | --- |
| SOL 1 | Original minimum 28775; packet minimum 28774 | Correct protected-minimum refusal, unchanged rule |
| USDC 1 | RPC context slot 457696321; Clock slot 457696322; wall skew 488 ms | Bank mismatch, not excessive wall-clock drift |
| SOL 2 | RPC context slot 457696335; Clock slot 457696336; wall skew 656 ms | Bank mismatch |
| USDC 2 | Original-packet simulation response failed complete post-state guard after 12 first-scan reads | Retained refusal; exact simulation error/post-state operands were not captured, so root cause remains unresolved |
| SOL 3 | RPC context slot 457696384; Clock slot 457696385; wall skew 1051 ms | Bank mismatch |
| USDC 3 | Runtime 457696403..457696433 = 30; post-attempt audit slot 457696436 gives 33 | Correct freshness refusal against unchanged 32; not a pass |

USDC 3 retained one original-packet simulation and both full fresh 13-read code phases. First code responses span slots 457696408..457696420 (about 2985 ms including other concurrent work); simulation slot 457696420 (223 ms); final code responses 457696421..457696432 (2657 ms); final runtime tail reaches 457696433, and activity audit reaches 457696436. These are overlapping observation intervals, not additive independent benchmarks. All runtime and audit checks remain necessary. Neither the 30-slot runtime nor the earlier 31-slot runtime qualifies when its required activity audit ends at 33.

The no-existing-wrapped-SOL fixture did not reproduce the earlier token-close refusal in this second sample. That is a narrower fixture observation, not a repaired decoder, proof of the old failed predicate or support for every existing account state. The old captured CloseAccount remains refused. No program was permitted by ID alone. Clock wall-time tolerance is still 30000 ms and bank equality is still exact; these new bank mismatches do not justify widening time tolerance. Original minimum-output, custody, lifetime, per-request/slice code limits and serial group defaults stay unchanged. Stock signing stays hard off.

Verification: 25 related Vitest files / 518 tests together (pair files plus code identity and RPC pacing), fourteen Node tests, plain TypeScript, scoped script lint/format, exact receipt hashes, offline recomputation and all current runtime-source hashes pass. No new production build, full-suite, rendered browser or funded/signing proof. Main's two unrelated dirty files remain intact and unstaged. No push, deployment, remote SQL, provider/credential/cron change or real wallet action.

Next review should address the remaining 33-slot full-window latency and obtain exact simulation refusal operands without changing acceptance. Provider Clock/context mismatches and genuinely worsened packet minima must continue to refuse; do not retry until a lucky sample hides them. Complete repeatable SOL/USDC 32-slot qualification has not been achieved.
