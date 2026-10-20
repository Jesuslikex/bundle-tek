# Immutable warmup session review storage

20 October 2026. Follows `b7a58f4`. Source-only backend foundation for Generate Activity. No automatic session starts, execution approval, signatures or broadcasts are introduced.

## Retention and recovery

New migration `0117_wallet_warmup_session_reviews` retains owner-scoped immutable review snapshots, their exact original plan/receipt source, SHA-256 bindings and review lifetime. Saving requires an explicit save intent, the exact reviewed context digest and a current review younger than 60 seconds. The service rebuilds the review from owned database evidence rather than accepting a submitted manifest. It limits UTF-8 document/source/combined bytes to 1 MiB/1 MiB/1.5 MiB respectively, with no truncation.

Insertion-time guards fence plan and wallet revisions, raw source documents, receipt membership and remaining units, active wallet reservations, false authority flags and action dependencies. UPDATE, DELETE and replacement INSERT attempts are refused. Missing guard installation refuses storage. Reads reconstruct the original review and verify both source and context digests; later plan archival or review expiry does not erase historical recovery. Lost-response recovery reads only the same immutable identity and never sends a replacement INSERT. Raw source/context keys are not returned in the retained DTO.

The shared progress loader now uses stable receipt ordering and explicit plan field order for repeatable replay. Its additional raw source stays server-internal; the existing progress and review endpoints still return only their explicit public fields.

## Verification before the source checkpoint

- 22 new local D1 storage tests pass: owner isolation, exact replay, expiry/intent/hash refusals, historical recovery, identity conflicts, lost-response recovery, five insertion races, partial lots/linked sells, three authority-flag bypass attempts, dependency/source mutation, replacement/update/delete refusal, missing guards, corrupt-source replay, cancellation and UTF-8 capacity.
- Related review API/domain/client/component tests pass. The separate existing plan/preparation/receipt/workflow cohort passes 68 tests in five files, including four synthetic signing-mode buy-to-sell cases with no live RPC.
- Plain TypeScript, four-file typed lint/format and an isolated production build pass. Final build source hashes remain unchanged. The build includes the repository's existing nested-workspace warning.
- Real whole-file Wrangler local migration apply passes all 118 migrations and verifies the complete local ledger. Native SQLite/local D1 migration-chain comparison passes.
- An unchanged checksum-checked runner, confined to a fresh disposable local file, applies the 117-migration baseline then upgrades by exactly one migration. All 118 checksums match; the old ledger and synthetic sentinel are preserved, integrity is `ok`, foreign-key violations are zero, and a repeat applies zero migrations. Its `--remote` entry point is used only with an explicitly constructed `file:` URL and synthetic token, never a hosted database.
- The initial 102-test cohort passed 101 cases. Its Git-HEAD historical checksum case cannot inspect an uncommitted migration, so it requires a repeat after the source checkpoint. No SQL or test predicate was weakened to bypass this check.

Local evidence: `work/release-qa/warmup-session-storage-build-20261020/result.json`, `work/release-qa/warmup-session-upgrade-20261020/report.json`, and the disposable Wrangler report at `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-mLAPTq\report.json`. These generated artifacts are ignored, not application sources.

## Still open

The retaining service is not yet connected to a write API or a Save/Recover panel. Execution consent, a scheduler, fresh per-transaction authorization, cancellation and session-level recovery remain separate follow-ups. Stored reviews always have `executionAllowed`, `signingAllowed` and `automaticExecutionAllowed` false. This is not full Proxima execution parity or funded proof.

No protected UI, provider, credential, cron, application/hosted database, actual wallet or deployment changed. No new browser check was needed for this backend-only checkpoint. Migration numbering now ends at 0117; next free is 0118, subject to recheck.
