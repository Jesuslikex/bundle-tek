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

Final plain TypeScript (	sc --noEmit --incremental false) passes. Scoped typed lint and formatting pass on the final three TypeScript files. Opus review is pending against the following committed checkpoint; no completed review is claimed yet.
