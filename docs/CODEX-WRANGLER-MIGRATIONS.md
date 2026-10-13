# Actual Wrangler migration verification, 13 October 2026

Claude correctly identified a whole-file splitter failure in main's `0058_imported_trade_sessions.sql`. The `trade_session_intent_transition` trigger used `json_extract(r.document,'$.mint')=CASE`. Wrangler 4.127.1 fails to count that nested CASE block without preceding whitespace and prematurely splits the trigger. The correction adds exactly one space: `= CASE`. SQL meaning and Drizzle statement breakpoints are unchanged.

Verified using the installed CLI's actual `d1 migrations apply DB --local` command, with copied migration files, a dummy database ID, a fresh temporary configuration and isolated persistence. No project configuration or secret file was copied. No remote database was queried or changed.

- Original files: exit 1, `incomplete input: SQLITE_ERROR`. Retained log/report: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-QcXZHe`.
- Corrected files: exit 0. The actual `d1_migrations` ledger contains every one of the 74 expected migration filenames. Retained log/report: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-16n2Cg`.
- Existing `test/migration-chain.test.ts`: one test passed, comparing breakpoint-applied D1 schema with SQLite. This is complementary schema verification, not proof of Wrangler splitting.
- `node --check scripts/check-wrangler-migrations.mjs`: passed.

Run `npm run db:check-migrations` for future whole-file regression checks. The script copies the journal's SQL files byte-for-byte, invokes the real installed Wrangler CLI, checks the resulting ledger against the journal, and retains disposable logs/state and per-file SHA-256 hashes. It never runs against the application's database. A failed CLI command or incomplete ledger fails the check.

This local source correction changes migration bytes and therefore changes any hash calculated over the full SQL text. It does not reconcile an existing checksum-based deployment ledger. Do not copy it over applied hosted migration history as a recovery step.

The CROP candidate's corresponding `0065_imported_trade_sessions.sql` already has `= CASE`. That candidate remains untouched. Its partially applied hosted migration failure is a separate unresolved issue; this successful local check neither identifies its runner nor proves hosted recovery. No push, deployment, signing, funded transaction or scheduler activation occurred.

Claude's `070ad61` is already the parent of the preceding Codex checkpoint `603784a`. Its six workspace/launch files were inspected through Git and left unchanged. Existing unrelated whitespace changes in `docs/CODEX-JITO-ATOMIC-BUNDLES.md` and `drizzle/0068_remarkable_frightful_four.sql` remain outside this checkpoint.
