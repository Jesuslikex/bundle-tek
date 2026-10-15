# Immutable complete signed-group registration

15 October 2026, based on 8d19fad. Adds a server-internal store for already-signed complete groups. Registration does not access keys, authorize signing, reapprove economics or broadcast transactions.

## Implemented

The service requires installed signature guards, authenticated owner/format, the exact recorded whole-group consent and matching immutable approval context. It accepts only transaction strings; the server reconstructs and cryptographically verifies all packets rather than accepting client-authored signature evidence. Incomplete, reordered, altered or invalidly signed groups reject before storage.

Append-only 0084 adds pump_group_signatures, one immutable record per review with a parent foreign key. Insert guards bind owner, approved parent, consent context/manifest, complete ordered packet count and unsigned hashes, signed evidence format/digest and disabled execution flags. An AFTER INSERT trigger updates the parent to signed in the same atomic statement; transition failure rolls back the signature row as well. Direct parent transitions require that exact immutable stored evidence. Existing review, approval and wallet reservation guards remain in force.

The parent's legacy scalar signature is the first packet ID only. It is not a group receipt or proof of completion. Complete ordered transaction IDs, signed packet bytes and the signed-group digest are retained together and returned in authenticated signedEvidence. Legacy launch readers continue to exclude groups.

Exact repeated registration resumes the original evidence without a second row. Different signed data cannot overwrite it. Signature records cannot be updated/deleted, and the parent cannot move to submitting or release its reservation as unsigned. Public signingAllowed, executionAllowed and completeLaunch remain false.

Registration uses historical review validation so expired, already-created signatures can be retained for recovery. It does not treat signature validity as live blockhash validity or fresh ownership permission. The SQL registration boundary intentionally checks current insertion time, not the original review's expiry. Actual new signing/submission still requires qualification and fresh authorization; current APIs/UI expose neither.

## Verification

Six selected test files passed all 73 tests, retained in ignored work/group-registration-tests.json. Current-source TypeScript and four-file typed lint passed. All 85 whole-file local Wrangler migrations and their ledger passed; all 85 also applied to a fresh local libSQL database. Production Next.js build passed. The sanitized local migration receipt is docs/CODEX-PUMP-GROUP-REGISTRATION-MIGRATION-20261015.json.

Controlled tests use generated synthetic keys only. They cover complete retention/idempotency, immutable history, blocked submission, retained wallet reservations, wrong owner/missing approval, partial packet rejection, missing migration guards and rollback of both rows when the signed-parent transition fails. The application-clock expiry case exercises historical validation; it does not change SQLite's clock and is not an on-chain expiry proof. Existing review, approval, ownership and signature regressions remain included.

No actual provider request, real wallet signature or submission is made. Create preflight and account data remain controlled fixtures; these checks do not execute BPF or qualify live v1/transport behavior. The new schema snapshot adds one table without modifying the preceding 94 table definitions; prior migration SQL and journal entries remain unchanged.

## Next

Implement qualified browser-local full-group signing, complete/partial/unknown receipt and final-lifetime recovery, one-attempt submission and API/UI integration. Runtime/code/authority and transport/tip qualification remain open. Signed evidence alone must not enable execution or release reservations. More than five packets still has no enabled execution policy.

No API/UI/protected Claude file, remote SQL/migration, credentials/provider settings, cron, push, deployment or real-wallet action changed. Migrations 0081 through 0084 remain local. Main's two unrelated dirty files are preserved. Full Proxima parity remains unfinished.
