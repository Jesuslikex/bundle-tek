# Configured pacing and unsigned qualification isolation

Implementation: `3b094f6`, following Claude's review of `2f569d3` through `a0d03cf`.

## Fix

The service's default reader construction now uses `createPairReadRpc(endpoint, signal)` with configured pacing. It no longer selects the Helius-only profile. The public preparation path and approval reader already used their configured/default dependencies; the affected construction was the internal qualifier's dependency-free fallback. No client-selectable pacing or qualification flag was added.

Explicit Helius qualification admissions now have a separate `nextRead` schedule in the qualification profile. Ordinary `paceWalletRpc` calls do not inspect or join that profile, and explicit qualification calls do not mutate the ordinary `nextReads` queue. Creating a qualification profile therefore cannot impose a nine-unit budget or its spacing on unrelated wallet reads for the lifetime of the instance. Ordinary reads still obey `SOLANA_RPC_MIN_INTERVAL_MS` when configured, on every supported endpoint. Invalid configured intervals still fail closed.

The standalone script still explicitly chooses `unsigned-helius-qualification`. Its exact-host and method-count validation, actual rolling nine-method budget, cancellation and no-retry behavior remain unchanged. This budget describes explicitly opted-in calls, not aggregate account-wide traffic from unrelated processes. Continue running live qualification sequentially in isolation. Normal provider credentials, endpoints and configured intervals were not changed.

## Tests

Seven files / 140 Vitest tests pass together: wallet-rpc-pacing, pair-read-rpc, pair-order-first-qualification, pair-order-first-service, pair-runtime-ordering, imported-pair-runtime and pump-group-code-identity. New fake-clock cases verify ordinary reads remain immediate without configured pacing even after qualification begins, and configured ordinary reads retain their own 300/600/900 ms schedule while the qualification queue admits separately at 300 ms. Existing cancellation, delayed-timer and rolling-budget cases continue to pass. The service composition regression selects a non-Helius endpoint, intercepts reader construction and asserts exactly the two default arguments; it does not contact that fake endpoint or claim an end-to-end provider qualification.

Plain TypeScript, scoped type-aware lint and formatting pass. The offline evidence checker adds five passing Node tests. No full-suite, new production build, rendered browser or funded acceptance claim.

## New fixed live sample

Six fresh unsigned TSLAX attempts on implementation `3b094f6`, three alternating rounds, 14:40:55 through 14:41:26 UTC. The existing script uses SOL 0.001 and USDC 1 with public reference wallets in isolated in-memory storage. No replacement attempts or order/code-scan reuse.

| Round | Input | Refusal | Pipeline time |
| --- | --- | --- | --- |
| 1 | SOL | Candidate instructions/accounts/raw-spending review | 4.255 s |
| 1 | USDC | Chain clock inconsistent or stale | 2.038 s |
| 2 | SOL | Wallet balances/custody/rent changed; new preflight required | 2.053 s |
| 2 | USDC | Original minimum-output bound | 2.148 s |
| 3 | SOL | Original minimum-output bound | 2.210 s |
| 3 | USDC | Original minimum-output bound | 2.304 s |

**SOL 0/3, USDC 0/3. Repeatable 32-slot qualification is still not established.** Every attempt stopped before simulation, so this set supplies no new completed-runtime slot measurement. Maximum rolling RPC methods: nine; 188 HTTP responses, all 200; zero 429s. HTTP success does not establish chain-clock, account or economic validity. Public wallet references can move and do not establish user ownership or funded behavior.

`CODEX-PAIR-PACING-REPEATABILITY-20261016.json` retains all six original sanitized receipts, their hashes, source identities and the offline checker's complete denominator. The previous sample in `CODEX-STOCK-REPEATABILITY-20261016.json` is retained unchanged. Each source hash still matches the current implementation. No environment values, endpoint URLs, credentials or transaction bytes are included.

Next diagnose instruction/account differences and clock consistency using bounded sanitized diagnostics before another fixed sample. Keep the original minimum-output bound and 32-slot window, fresh final code observation, all custody/lifetime checks and the serial group default. The pacing fix does not resolve these earlier pipeline refusals. Trusted program policy and application reservations remain separate blockers.

Signing/execution remain hard-off. No UI or Claude-owned source changes, provider/credential/cron changes, remote SQL/migrations, push, deployment, wallet unlock, signing or submission. Main's two unrelated dirty files are preserved.
