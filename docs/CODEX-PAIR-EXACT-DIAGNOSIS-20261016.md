# Exact refusal diagnosis before further fixes

This checkpoint changes diagnostic capture only. It does not relax custody, Clock, instruction, minimum-output, 32-slot or signing checks. Private non-enumerable errors now preserve exact decimal raw units and expected/observed fields; the qualifier explicitly captures these values. These are public reference accounts, not user wallets. No credentials, private keys, URLs or signed bytes are captured. API error messages and their JSON exposure are unchanged.

The attached `CODEX-PAIR-EXACT-DIAGNOSIS-20261016.json` retains all five original receipts and hashes from the bounded campaign beginning 15:12:40 UTC. It stopped on the first 429; there was no sixth attempt, replacement or immediate retry. Its source was the in-progress diagnostic instrumentation on base `8421de9`; hashes identify that exact source. Subsequent additions complete the token-state comparison capture and fix one lint escape without changing rejection predicates. Do not relabel the historical receipt as containing values it did not capture.

| Attempt | Check | Exact values | Classification |
| --- | --- | --- | --- |
| SOL round 1 | minimum-output | Protected minimum 28925; packet minimum 28924 | Correct economic-bound refusal |
| USDC round 1 | minimum-output | Protected minimum 275859; packet minimum 275790 | Correct economic-bound refusal |
| SOL round 2 | Complete | 29 slots, one simulation and fresh code phases | Isolated observation, not repeatability |
| USDC round 2 | selected-token-state | Old capture named the guard but omitted its operands | Unresolved custody comparison, not proof of an unsupported opcode; exact-value capture added and tested for the next run |
| SOL round 3 | HTTP rate limit | Provider returned 429; candidate cancellation was the public wrapper | Provider refusal; no on-chain before/after result available |

The new exact token-state capture records all four operands of that guard: source hash, account lamports, status and raw token amount. A regression changes 20000000 to 19999999 raw units after preflight, checks the exact diagnostic and still requires 409. Native custody capture records both wallet balances and all compared token-account fields. WSOL capture records the encoded reserve, lamports minus token amount and the required rent floor. Unknown setup refusals retain the exact instruction program, index, data hex and account privileges for decoding; no program is admitted by ID.

Thirty Clock observations in this campaign record chain slot/time and response server time. The measured wall-time skew is 487..1568 ms, well inside the unchanged 30000 ms limit. Bank equality is checked separately. Earlier retained failures were one-slot Clock/context mismatches, not evidence that 30 seconds is too narrow. **No Clock bound change is supported or proposed.** If future measurements justify one, send a measured proposal to Claude before implementing it.

Historical boolean-only custody receipts cannot establish the exact raw balance delta retroactively. Treat those as incomplete evidence. A new quiet-reference qualification must retain both pre/post activity and exact custody values; do not excuse actual balance changes or replace an old preflight silently.

Verification before this checkpoint: six targeted files / 138 tests, standalone TypeScript and scoped lint. Tests cover u64 precision above Number.MAX_SAFE_INTEGER, private diagnostic serialization, exact changed token units, existing Clock and custody rejection, quote bounds and complete unsigned qualification. No application acceptance rule or decoder changed.

Next, as a separate fix: require the qualification campaign to select quiet public references and recheck their observed activity after each attempt. If a new receipt identifies an unsupported route/program, implement its full decoding and negative tests in a separate commit; never bypass unknown instructions. Keep signing off and do not deploy.
