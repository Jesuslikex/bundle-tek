# Exact unsigned warmup packet recovery

The live Proxima completion screen exposes a completed session and per-wallet transaction counts and volume. This checkpoint closes a prerequisite for Bundle's durable workflow: a lost preparation response must not lose the exact unsigned packet the user would later review. No live Proxima backend or signing architecture is inferred from that screen.

## Implementation

- The trusted server callback may return `{summary, transaction}`. Its transaction passes the original `reviewUnsignedSwapEnvelope`: canonical bounded v0 bytes, exactly one expected payer, zero signatures and valid account indexes. Hash, byte count, instruction count and lookup count must match the saved summary exactly. This checks identity, not DEX execution safety.
- Additive source-only migration 0129 stores an owner/preparation-bound immutable packet envelope, including the hash of the original owned preparation wrapper. Parent matching and update/delete/replacement guards apply in SQL. The old summary-only callback remains historical and supplies no packet or signing authority.
- Packet and existing preparation INSERTs execute in one atomic D1 batch / Turso write batch. Existing 0128 triggers still create and guard the ordinary preparation and journal-action binding. A second-statement refusal rolls everything back. There is no second write attempt.
- Same-ID recovery reparses the saved canonical unsigned bytes and both retained hashes without another quote. Recovery remains available after expiry or Stop, without renewing expiry, user consent or authority. Exact first-result recovery and owner isolation remain unchanged.
- No private key, seed phrase or signed transaction is stored. Existing session signing prohibition remains unchanged.

## Verification

The 23-file related suite passed 554 tests. After a test-only incomplete D1 mock assertion correction and two extra corruption/schema-guard cases, the final preparation file passed all 45 tests. These comprise 556 distinct cases across the two runs, not a new full-repository suite. Native packets and signature fixtures are synthetic, not funded swaps.

All 130 migrations apply with the checksum runner in a fresh disposable local database (732 schema objects), and through the real whole-file Wrangler migration command. Wrangler report: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-m37QH4\report.json`. Neither command used the application or hosted database. Scoped typed lint passes. Final plain TypeScript and focused Opus review are recorded below when complete.

## Remaining integration

This is server-internal packet retention. The real provider callback, bounded authenticated preparation/journal APIs, safe client DTO, request deduplication/pacing, wallet/lot reservation, short authorization, browser signing, multi-wallet orchestration and full running/completed UI still need integration and verification. Missing legacy packet material must remain held, never reconstructed from another quote. Automatic signing stays off. No deploy, application/hosted SQL, provider/credential/cron change or real wallet action.

Final plain TypeScript (tsc --noEmit --incremental false) passes. Scoped typed lint and formatting pass on the final three TypeScript files. This was the initial checkpoint; completed review and final follow-up are below.

## Completed Opus review and follow-up

Actual `claude-opus-5-5` reviewed committed `b0ae50d` using only Read, Glob and Grep, with no delegation, edits, tests, network or MCP tools. Final result succeeded with zero permission denials and unchanged hashes for all 2131 copied source files. Logs and status remain under ignored `work/release-qa/opus-packet-recovery-review-b0ae50d-20261021/`. The review found no critical/high/medium defect within this unmounted storage boundary. Its test results are Codex's, not Claude's.

Accepted low follow-up, independently implemented and verified by Codex rather than rereviewed:

- The exported packet statement builder is replaced with a complete preparation+packet atomic write operation. Additive 0130 refuses attachment after packet/session expiry or a changed journal head. The committed 0129 file is unchanged. This enforces the atomic-creation claim through the trusted service path; arbitrary privileged SQL is not cryptographically trusted, and every recovered envelope is still checked.
- Packet validation and integrity failures expose a stable fixed 503. Reads require all four immutable/freshness triggers. Absent packet material now explicitly reports `summary-only` or `storage-unavailable`; retained bytes report `retained`. Neither missing case can authorize anything, and summary-only retries never quote or attach replacement bytes.
- New real libsql write-batch tests cover different packets competing under the same ID, distinct IDs competing for one action, and Stop/plan/wallet drift immediately before the batch. They prove one winning exact packet or full rollback. Direct validator coverage reaches the envelope payer check independently of plan validation; partial-schema and restored-guard corruption cases check recovery refusal.

Read coverage: full diff, packet module, preparation module/tests, migrations0126..0129 and Turso adapter; partial original unsigned parser and history validator. The reviewer did not reread fixture bodies, journal/binding TypeScript, signing route or migration runners. D1 batch runtime rollback has not been separately exercised here: batch behavior is tested through the production Turso adapter, while real Wrangler verifies whole-file migration application. No broader runtime or full-product parity claim follows from this review.

## Final checkpoint

All 23 related files pass together: **564 tests, zero failures**. Final plain TypeScript, three-file typed lint and four-file format checks pass. The checksum runner applies all131 migrations to a fresh disposable database (733 schema objects), and the real whole-file Wrangler CLI applies all131 with a matching ledger and exit0. Final Wrangler report: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-Fv8dyd\report.json`.

The final source freeze is `work/release-qa/warmup-packet-recovery-final-freeze-20261021.json` (2693 files; digest `41813da99b0a1aa27c8be55def7b89ebcae048752ccd9df463f53cb6c1b50540`). Verify it before committing. This is source-only progress: neither migration was applied to the application/hosted database, no new signed-in Bundle browser or live-provider execution check is claimed, automatic signing remains disabled, and nothing was deployed.
