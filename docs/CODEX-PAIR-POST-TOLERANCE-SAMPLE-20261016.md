# Stock-pair sample after the approved fresh-reference tolerance

This is one fixed, alternating six-attempt read-only sample at source commit `889ac66`, on 16 October 2026 at 16:52-16:53 UTC. The complete receipts and recomputed summary are retained in CODEX-PAIR-POST-TOLERANCE-SAMPLE-20261016.json. No refused attempt was retried, replaced or dropped. The existing pinned public references stayed unchanged before/after all six attempts. Their inactivity is observed evidence, not guaranteed future inactivity.

| Round | Asset | Result and exact refusal |
| --- | --- | --- |
| 1 | SOL | Code scan observed slot 457710984 against floor 457710951: 33-slot span, refused before simulation. 24 first-scan reads, no final scan. |
| 1 | USDC | Full simulation and both 13-read code scans ran, then runtime snapshot 457711005..457711039 exceeded 32 slots (34). |
| 2 | SOL | Jupiter unsigned-order request returned HTTP 400. No order or simulation; no retry. |
| 2 | USDC | Strict initial minimum required 279601 raw, order encoded 279573. Refused before the fresh reference. The fresh-only tolerance cannot override this. |
| 3 | SOL | Clock context 457711116, raw Clock slot 457711117, wall skew 483 ms. One simulation ran; final code scan incomplete. |
| 3 | USDC | Clock context 457711138, raw Clock slot 457711139, wall skew 938 ms. Refused before simulation. |

Pass counts: SOL 0/3, USDC 0/3. There were no writable-custody refusals in this sample; that does not resolve the historical refusal. The two Clock failures again arrive with exactly +1 slot and remain rejected under the current rule. The standard-validator probe from the preceding checkpoint used a different endpoint and time; its 12 matching responses do not establish that the trading endpoint is now consistent or justify changing providers.

The initial-quote completion to order dispatch gap was 85.7..98.2 ms. The four reached fresh quotes were dispatched 312.8..473.0 ms after order completion. One strict early minimum refusal remains, and neither timing series establishes a latency improvement. No fresh-reference-tolerance failure was observed; this is not evidence that the entire flow qualifies.

Transport accounting: 203 HTTP 200, one Jupiter HTTP 400 and one admitted account read with no completed response status after cancellation. Zero 429. The aborted read is retained, not counted as HTTP success. Maximum admission was at most nine RPC methods per rolling second. All tracked source hashes match the live sample, and the offline summary was recomputed with the actual validator.

Environment limitation: the shell resolved Node v26.4.0 for this diagnostic, while production declares Node 24.x. This is retained as refusal/latency evidence, not a successful production-engine qualification. Fourteen current offline campaign/summary/Clock-wire tests pass under that same local runtime. No production code changed in this checkpoint, so the prior 553-test implementation result remains a prior checkpoint result, not a new test run claimed here.

The 32-slot rule, strict initial minimum, approved fresh-reference-only 10 bps tolerance, exact Clock equality and 30000-ms bound, custody/owner policy, final full code recheck and serial group defaults are unchanged. Stock signing remains hard off. No browser/UI file, provider configuration, credential, cron, hosted SQL, wallet unlock, signature, broadcast, push or deployment changed. Full Proxima parity and repeatable SOL/USDC stock qualification remain incomplete. The next engineering target is the remaining full-scan latency; Clock +1 policy is still awaiting the user's decision.
