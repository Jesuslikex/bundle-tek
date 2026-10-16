# Quote/order gaps and complete sample counts

Commits: 8c7d91a instruments full provider calls; 1a3fc3c retains the measured baseline before the fix; 84b2b2a overlaps only independent initial network and slot reads in the quote service. No UI or Claude-owned file changed. Full raw baseline/follow-up receipts and per-attempt reasons/timings are in CODEX-PAIR-QUOTE-GAP-BASELINE-20261016.json and CODEX-PAIR-QUOTE-GAP-FOLLOWUP-20261016.json. Both JSON reports include the older pinned samples too, explicitly without invented historical full-response timing.

| Fixed sample | SOL pass/fail | USDC pass/fail | Refusals |
| --- | --- | --- | --- |
| Earlier pinned, 15:54 UTC | 0/3 | 0/3 | Minimum 1; Clock-bank 1; quote unavailable 1; full audit at 33 slots 1; code bank at 33 slots 1; token-close 1 |
| Earlier narrower fixture, 15:59 UTC | 0/3 | 0/3 | Minimum 1; Clock-bank 3; incomplete original-packet simulation post-state 1; full audit at 33 slots 1 |
| Instrumented baseline, 16:07 UTC | 0/3 | 0/3 | Minimum 3; runtime freshness 2 (35 and 34 slots); full audit at 35 slots 1 (runtime itself 32) |
| Independent-read overlap, 16:10 UTC | 0/3 | 0/3 | Minimum 1; Clock-bank 2; runtime freshness 2 (33 and 39 slots); unsupported writable custody/executable state 1 |

Each row is exactly three fixed alternating SOL/USDC rounds, not three failures chosen from more attempts. No retries, replacement attempts or dropped failures. Minimum-output refusals total 6/24, not dominant across the four samples. The 3/6 baseline minimum count fell to 1/6 in the next live sample, but different routes/market conditions make that unsuitable as evidence that overlap improved acceptance. All 24 before/after activity audits remained unchanged and all samples had zero 429, signatures or broadcasts. There is no complete 32-slot qualification pass.

| Full-response timing | Baseline, six reached orders | After overlap, four reached orders |
| --- | --- | --- |
| Initial quote completion to order dispatch | 74.2..95.2 ms | 89.8..101.5 ms |
| Order provider duration | 136.7..234.7 ms | 143.8..195.0 ms |
| Order completion to fresh reference dispatch | 321.5..333.2 ms | 311.1..326.1 ms |
| Order completion to fresh reference completion | 431.4..630.6 ms | 439.3..469.7 ms |

Two post-change attempts stopped after initial quote response, before order dispatch, due to exact Clock/context bank mismatch. Their absent gaps remain null rather than zero. The first gap includes the quote service's mandatory post-quote mint/network validation. The second includes fresh network/slot/mint observations before requesting the comparison quote. Both directions are recorded because the existing preflight minimum compares the packet with that later fresh reference. The runtime and final bounds remain separate from these provider timings.

Exact baseline minimum comparisons (required vs packet) were SOL 28872 vs 28859, SOL 28826 vs 28720 and USDC 277579 vs 277564. Their order-to-fresh dispatch gaps were 321.5, 323.8 and 323.4 ms. Post-change minimum comparison was SOL 28857 vs 28855 at 326.1 ms. Every original lower bound refused unchanged. This small sample does not establish a causal threshold for price movement.

The independent initial reads now start together and both must settle and validate before mint/quote work. They can share one transport batch, but still consume two method admissions. This removes their sequential dependency without reducing their pacing cost, so it has not established a meaningful latency improvement under the configured nine-method qualification budget. No additional performance claim or further production change is justified by these observations alone. Keep the change reviewable separately from the instrumentation and evidence.

The new unsupported writable-state refusal has no exact private account operands in this receipt and remains unresolved. Likewise the earlier incomplete simulation response lacks the original error/post-state operands. Do not infer a decoder bug or authorize a program from these generic errors. Clock bank equality and the 30000-ms time tolerance, custody, minimum, final code recheck, 32-slot limit, group serial reads and stock signing gate remain unchanged.

Verification: 25 related Vitest files / 521 tests together, seventeen Node tests, plain TypeScript, scoped typed lint, script lint/format, offline report recomputation and current-source/original-receipt hash checks pass. No new production build, full-suite, browser, signing or funded claim. Main's two unrelated dirty files are preserved. No push, deployment, hosted SQL, provider/credential/cron change or real wallet action. Stock signing remains off. Next work should diagnose exact writable-state/simulation operands and full-window latency without weakening their checks.
