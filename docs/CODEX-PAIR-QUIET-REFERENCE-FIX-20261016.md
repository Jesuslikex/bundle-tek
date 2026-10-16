# Quiet public reference policy, after diagnosis

Diagnosis was committed first as `d450853`. This separate fix changes the read-only qualification harness, not application acceptance rules.

`run-stock-repeatability.mjs` now always passes `--idle-reference`. Each selected address must have a valid latest observed signature at least 256 slots old, must pass both existing exact funding snapshots, and must pass all normal candidate checks. Selection is bounded to the existing candidate set; malformed/unavailable candidate activity is counted and excluded, not treated as quiet or retried. The activity scan is anchored by a subsequent confirmed getSlot. No user wallet is used.

After every selected-reference attempt, the script closes the runtime reader, then performs a bounded latest-signature and slot audit on the same endpoint, with minContextSlot at least as new as all observed runtime slots. Both requests explicitly use the qualifier budget, so configured production wallet pacing remains independent. New activity, a backwards observation, missing/malformed evidence, cancellation or audit failure cannot produce a successful quiet-reference claim. On a 429, the campaign still stops immediately; the audit is not attempted after cancellation. This is observed inactivity in provider coverage, not a guarantee of no unobserved transaction or immutable historical bank state. [Solana's method contract](https://solana.com/docs/rpc/http/getsignaturesforaddress) supports minContextSlot and newest-first signature lookup.

For successful runtime observations, the later activity-audit slot is included in an additional qualification span, which must also be <=32. The original runtime hash and span are retained unchanged. The offline checker verifies both the unchanged signature/slot evidence and the full qualification span. This tightens the harness; it does not reset or widen a freshness window, reuse a code scan, rebase wallet balances, adjust Clock tolerance or change the original minimum.

Before/after activity slots and signature hashes are retained, together with exact custody values when a custody check fails. A deterministic helper test rejects changed signatures even at the same slot, future/missing/malformed history, insufficient idle duration and backwards observations. The offline test also rejects an audit at 33 slots or an unavailable/changed quiet reference. Eleven Node tests pass across activity selection, campaign stop behavior and evidence summarization; scoped script lint/format passes. Live results are recorded in a separate evidence checkpoint after the code commit.

No new instruction decoder or program allowlist was added. None of the newly diagnosed refusals establishes a missing opcode decoder: the observed token-state failure was an exact custody-state guard. Its historical operands were not captured, so it remains unresolved rather than being assumed a real on-chain balance change. The expanded diagnostic now captures those operands for the next run. If a new unsupported route is observed, capture its complete instruction context and implement full decoding and tests separately before permitting it.

Signing remains off. No UI/Claude-owned source, credentials, provider endpoint configuration, cron, remote SQL/migrations, push, deployment or real wallet action.

## Live verification on 0aa9a93

The separate `CODEX-PAIR-QUIET-REFERENCE-EVIDENCE-20261016.json` retains all six original receipts and their hashes, a refusal classification for every attempt and the computed operands for the freshness/fixture guards. Classification annotations do not rewrite historical receipts. Source hashes match this commit and current source.

| Attempt | Check and exact comparison | Classification |
| --- | --- | --- |
| SOL round 1 | Protected minimum 28895; packet minimum 28893; observed activity unchanged | Correct economic-bound refusal |
| USDC round 1 | Protected minimum 277007; packet minimum 276984; observed activity unchanged | Correct economic-bound refusal |
| SOL round 2 | Context 457685682..457685731: 49 slots against 32 | Correct freshness refusal; one simulation and both 27-read code phases completed, but no qualification |
| USDC round 2 | Required at least one suitable stable funded reference; observed zero | Fixture unavailable; no reference selected and no applicable wallet-balance comparison |
| SOL round 3 | Required at least one suitable stable funded reference; observed zero | Fixture unavailable; no reference selected |
| USDC round 3 | Required at least one suitable stable funded reference; observed zero | Fixture unavailable; no reference selected |

The SOL round-2 reference also became active during the attempt: its latest activity changed from slot 457685405 to 457685716, and its signature hash changed. The script correctly records activity-changed and cannot qualify this address as quiet. An idle-before selection is not a guarantee about future behavior by another owner. The first two selected references had unchanged latest activity before/after; no new custody or opcode refusal occurred on them. Neither their quiet state nor the single SOL simulation permits replacing the original minimum or freshness check.

There were zero 429s. Twenty Clock observations had server/chain skew 429..1785 ms and zero Clock/context mismatches, below the unchanged 30000 ms tolerance. Together with the diagnosis campaign's 30 observations at 487..1568 ms, there is no measured basis for a wider Clock bound. No proposal or tolerance change was made. The earlier selected-token-state refusal remains historically unresolved because its old operands were unavailable; the new diagnostic and synthetic changed-units regression cover that gap for future observations, not retroactively.

Final verification: 25 related Vitest files / 540 tests together, eleven Node tests, standalone TypeScript, scoped typed lint and formatting pass. Exact receipt hashes, source hashes and credential scans pass. No new production build, full-suite, rendered browser, funded or signing acceptance claim. Result: SOL 0/3, USDC 0/3; repeatability remains unproven. Do not retry fixture/market failures until selecting suitable evidence for a new explicitly bounded campaign; do not replace failed attempts in this denominator.
