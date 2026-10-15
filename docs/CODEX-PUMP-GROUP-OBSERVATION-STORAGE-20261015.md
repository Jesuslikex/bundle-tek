# Owned immutable Pump group observation history

15 October 2026, based on bbf67cc. Append-only migration 0085 adds an immutable observation ledger, and a server-internal owned service collects and pages complete group recovery observations. It never accepts caller-authored receipts or changes the launch parent state.

Collection requires installed observation guards, the authenticated owner and exact group review, recorded canonical consent, and matching immutable approval context. Signed parents additionally require the exact immutable signature registration. Approved parents must have no signed evidence or scalar signature. Historical observation does not establish fresh signing permission.

The server invokes the complete-group observer itself and rechecks the parent after the RPC reads. Its single insert is also guarded against approval/signature/source-state changes at the SQL boundary. Context, manifest, signed digest, original packet count/order/hashes/IDs, outcome counts, classification, unresolved-fee flag and disabled permission/release flags are checked. A failed insert stores no partial observation and does not undo a concurrent legitimate signature registration.

Observations cannot be updated or deleted. Owner/review/timestamp/id ordering supports pages of 20 with a bound position for the next page. Each returned observation is rehashed and checked against the immutable review. Historical unsigned observations remain readable if a later observation is signed. No seed or private key enters this ledger.

All results retain wallet reservations. The existing parent stage guard still rejects finalization, cancellation of approved groups and submission. Complete receipt coverage is not an economic-settlement or atomicity attestation. Guarded terminal transitions, release policy and API/UI wiring remain unfinished.

## Verification

- Three selected files passed 47 tests: eight new storage cases, 18 observer cases and 21 existing review/approval/signature storage regressions. Report: work/group-observation-storage-tests.json.
- Real local libSQL guards cover owner isolation, approved and signed history, partial/complete observations, cancellation/provider failure with no writes, SQL context/packet/classification/release tampering, immutable history, pagination, state changes during RPC and registration races at the exact insert boundary.
- Current-source TypeScript, three-file typed lint and production Next.js webpack build passed. A test-only record inference annotation was corrected after TypeScript caught it; the executed JavaScript behavior did not change.
- All 86 whole-file Wrangler migrations and their ledger passed. All 86 also applied through the actual Turso runner to a fresh disposable local libSQL database.
- Prior 95 schema table definitions and journal entries remain unchanged. The new migration is explicitly LF-stable in .gitattributes. Sanitized local receipt: CODEX-PUMP-GROUP-OBSERVATION-MIGRATION-20261015.json.

No protected UI/Claude files, actual provider request, real-wallet action, remote migration, credentials/provider configuration, cron, push or deployment changed. A read-only hosted ledger check still matched its 85 applied checksums; 0085 is local only. Production remains b58355d. Main's unrelated Jito note and 0068 SQL edits remain excluded.

A separate release portability audit found that Git normalizes historical SQL line endings while the old migration runner hashes raw working-copy bytes. Seventy-six files are CRLF variants and 0082-0084 are mixed variants of unchanged committed SQL. The compatibility fix will be a separate checkpoint; no applied SQL or hosted ledger record will be rewritten.
