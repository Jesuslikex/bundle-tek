# Pair custody, clock and instruction investigation

**Not repeatably qualified. Signing remains off.** The last fixed six-attempt campaign on source `a3a25d4` completed with SOL 0/3 and USDC 0/3, zero 429s and no simulation. This investigation fixes a real quote-router mismatch and qualifier admission accounting; it does not make changing balances, incoherent banks or deteriorated outputs acceptable.

## Commits for Claude

- `d8204a7`: private named instruction, clock and custody diagnostics, with unchanged rejection predicates and public errors. Diagnostics contain check names, numeric time/slot differences, booleans and changed account field names, never account bytes, wallet addresses or credentials. A non-enumerable cause preserves diagnostics through preflight error normalization.
- `b1ac079`: qualifier capture of these diagnostics and an optional bounded idle-public-reference selector. Candidates must have no observed signature in the prior 256 slots and still pass the existing two-read funding and all production custody checks. This is a harness selection improvement, not an ownership proof or exemption from live balance changes. Candidate activity lookup failure aborts rather than silently treating a wallet as idle.
- `ecb4845`: pair reference quotes now request and enforce the same Metis router set as wallet-bound pair preparation. Existing non-pair quote-only routing remains broader. There is still no taker, wallet, transaction preparation or signing permission in a pair reference quote. Exact input, asset, slippage, original minimum and absolute floor checks are unchanged.
- `377b8ac`: identify a late native balance change separately from system owner/executable/data changes. A deterministic changed-balance test proves the candidate still returns 409.
- `a3a25d4`: setup RPCs explicitly join the qualifier's existing method-counted Helius profile at the HTTP boundary; runtime batches continue to join it once at dispatch. All actual setup and runtime admissions now count in the receipt's rolling maximum. Ordinary wallet queues and production configured pacing remain isolated. New bounded campaign driver stops the entire campaign on a 429, records an incomplete denominator and a backoff time, and never retries or replaces an attempt. The offline checker recomputes setup/runtime pacing from actual timestamped request records.

## What the live diagnostics established

**Clock:** three fresh attempts returned a Clock account one slot ahead of the RPC context, with wall-time skew only 278..1,258 ms. This is a bank mismatch, not local wall-clock staleness. Example: context 457675753, Clock 457675754. We retain exact Clock/context equality and the 30-second wall-age check. A public [Agave issue](https://github.com/anza-xyz/agave/issues/4807) documents this behavior and a maintainer explains that response context is not an atomic account-set guarantee. It is corroborating upstream evidence, not proof of the precise implementation fault on this endpoint. Even matching Clock/context alone must not be advertised as an immutable historical bank proof.

**Custody:** the route-aligned USDC round 2 failed across only one slot with nativeBalanceChanged=true and no changed token-account fields. The SOL round 2 instruction refusal hit system-wallet-state, not an unsupported opcode. Later diagnostic detail and a controlled regression distinguish that guard's balance/owner/executable/data predicates. Do not discard balance changes or recalculate an old approved preflight silently. Active public reference wallets are a sampling limitation; production must continue requiring a new preflight after change.

**Other native-account instruction refusal:** the final USDC round 3 hit native-existing-rent. It failed the existing WSOL reserve/amount consistency or rent-floor predicate. The receipt does not distinguish those two subconditions, so it is not evidence of a specific valid WSOL layout that Bundle should accept. Supporting unsynced WSOL balances would need explicit instruction and simulation conservation modeling; this investigation does not normalize them away.

**Router mismatch, fixed:** a separate six-quote read-only diagnostic returned a USDC JupiterZ quote with slippageBps=0, causing the exact 50-bps parameter check to refuse. SOL quotes also selected OKX, while unsigned wallet-bound orders support Metis only. Narrowing pair reference requests to supported Metis routing removes that incompatible baseline selection. Tests reject provider responses that ignore the exclusions. A Metis order whose minimum is below the fresh protected baseline still refuses, as it should.

**Pacing accounting, fixed:** one pre-fix campaign hit a 429 despite the pipeline-only receipt maximum being nine. The setup calls had not participated in the same qualification admission budget. This was a real accounting gap; it is not proof that the gap alone caused the provider rate limit, since other clients may share an account. After the fix, the final campaign counted both phases, had maximum nine and zero 429s. Qualification's budget cannot constrain unrelated account-wide traffic. No automatic retry or provider rotation was added.

## All attempts retained

`CODEX-PAIR-MISMATCH-EVIDENCE-20261016.json` contains 32 original sanitized receipts, source identities and exact-file hashes, all fixed sample denominators, plus the six quote-only router diagnostics. No unsigned packet bytes, environment values or endpoint URLs are included. No historical pass is relabelled as a pass on later source.

| Sample | SOL | USDC | Interpretation |
| --- | --- | --- | --- |
| Initial named-diagnostic sample | 0/3 | 0/3 | Three exact Clock/context failures, one 33-slot failure, quote minimum and route refusal |
| Idle-reference sample | 0/3 | 0/3 | One SOL simulation with both code phases ended at 33 slots; two USDC runs lacked a funded quiet reference |
| Second named-diagnostic sample | 1/3 at 28 slots | 1/3 at 27 slots | Isolated full lifecycle observations, not repeatability |
| Metis-aligned sample | 0/3 | 1/3 at 26 slots | Also exposed native-balance churn and one 429; this used the earlier pipeline-only pacing accounting |
| Final full-budget campaign | 0/3 | 0/3 | All six refused; no simulation, no new latency measurement, zero 429s |

Two additional reserve-reference setup experiments timed out at getLargestAccounts. They are not inserted into a successful six-attempt denominator. The second has sourceUnchanged=false because the harness was edited while its setup read was stalled; it is explicitly invalid for qualification and retained for completeness. The first four sample source hashes are historical; the final campaign's hashes match `a3a25d4` and current source. Later documentation changes do not change them.

Final campaign order: SOL original-minimum refusal; USDC original-minimum refusal; SOL unsupported writable custody/executable state; USDC original-minimum refusal; SOL no route/provider availability; USDC existing native reserve/rent refusal. No limit was loosened to force acceptance.

## Verification and next work

24 relevant Vitest files / 537 tests pass together, including quote routing, native-balance diagnosis, mint/wallet/clock checks, runtime ordering, qualification, RPC pacing and unchanged group code identity. Eight Node tests pass for fixed-denominator checking, complete setup/runtime admission accounting and stopping on 429 without another request. Plain TypeScript, scoped typed lint/format and the production webpack build pass. This is not a full-suite, rendered browser, signed-in or funded acceptance claim.

To reproduce the bounded final campaign, run `node scripts/run-stock-repeatability.mjs --live-readonly`. It reads ignored local provider configuration in child processes, performs exactly three alternating SOL 0.001 / USDC 1 attempts unless stopped by a rate limit, and saves all receipts under work. Honor a returned retryNotBefore; do not launch repeated campaigns in a loop. Use the optional idle selector on individual qualifier invocations only, and label that as a separate sample.

The next qualification prerequisite is a stable, suitable public reference with supported WSOL state and coherent provider observations, followed by a fixed sample that actually reaches simulation and the final code/custody/lifetime checks. Continue diagnosing failed fields rather than changing values, dropping checks or reusing final code evidence. Market deterioration can correctly require a new review even with a mechanically healthy pipeline. Trusted program policy and application reservations remain separate release gates.

No UI or Claude-owned source was edited. Group signing retains serial default reads. The 32-slot bound, full fresh final code recheck, custody, lifetime, fee, original minimum and consent protections remain. No provider account/credential/endpoint configuration, cron, hosted SQL/migration, push, deployment, wallet unlock/sign/send or signing enablement. Main's two unrelated dirty files are preserved.
