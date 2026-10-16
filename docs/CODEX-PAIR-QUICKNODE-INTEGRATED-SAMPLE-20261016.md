# Integrated QuickNode fixed sample, 16 October 2026

Source checkpoint: 14eae2f. One fixed Node 24.19.0 sample, alternating SOL and USDC three times, with the original pinned quiet reference fixture. All six outcomes are retained. SOL 0/3, USDC 0/3. No retry, replacement, HTTP 429, signature or broadcast. All reference before/after activity checks stayed unchanged; every source vector was identical and unchanged during its attempt. Signing remains off and nothing was deployed.

| Attempt | Asset | Outcome |
| --- | --- | --- |
| 1 | SOL | Partitions did not share one context and complete Clock. No simulation. |
| 2 | USDC | Measured rolling pacing reached 10 methods. Simulation reached, final scan incomplete. |
| 3 | SOL | Measured rolling pacing reached 10 methods. No simulation. |
| 4 | USDC | Runtime span 457760060 to 457760095, 35 slots. Final scan incomplete. |
| 5 | SOL | Partitions did not share one context and complete Clock. No simulation. |
| 6 | USDC | Runtime span 457760155 to 457760188, 33 slots. Final scan incomplete. |

The five-account profile was selected on every attempt. The previous oversized wallet request did not recur. Actual partition evidence, both wire Clocks, effective floors and completed collection hashes are retained. No pass or repeatability claim is available. Code-read counts in the JSON are the harness logical-read counters, not a claim that full scans completed.

The original campaign runner threw while validating attempt 2 before writing its combined report, because the pacing evidence exceeded its nine-method gate. Individual receipts were already durable. The campaign is recovered explicitly as `work/stock-repeatability-2026-10-16T19-49-54-547Z/campaign-recovered.json`, with all original receipts and summary null. The committed companion JSON contains receipt hashes, source vectors, Clock observations, completed collection scopes and exact peak windows. It is diagnostic evidence, not a validated qualification summary.

The runner now retains raw receipts with a fixed, secret-free summary error even when summary validation fails, and returns failure status. It still invokes the same validator; no rejected evidence is admitted. The qualifier will retain its original refusal separately if pacing later overrides the displayed reason. Twelve focused offline campaign/summary tests, scoped lint and formatting pass. No new live campaign was run after this reporting-only change.

Next diagnosis: the USDC pacing peak includes an indexer audit alongside runtime reads, while the SOL peak consists entirely of runtime reads. Inspect actual dispatch timing and shared admission scope before any pacing fix. Same-context partition failures and the 35/33-slot refusals remain intact. Do not loosen the 32-slot, Clock, custody, minimum-output, final-code or signing gates. No provider settings, credential, cron, SQL, UI or deployment changes.
