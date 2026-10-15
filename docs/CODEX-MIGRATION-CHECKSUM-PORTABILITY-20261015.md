# Portable Turso migration checksums

15 October 2026, based on 87812ea. Fixes a verified release problem: 79 historical SQL working copies differ from their committed Git objects only in physical line endings. Seventy-six are CRLF variants; 0082, 0083 and 0084 contain mixed physical endings. The old raw-byte hash check rejected a clean LF checkout even though the SQL content was unchanged.

The migration runner now writes a stable checksum for new migrations by normalizing physical LF/CRLF outside SQL quotes. It accepts exact historical bytes, equivalent outside-quote LF/CRLF hashes, or an explicitly audited mixed-ending alias anchored to the exact current canonical SQL and migration tag. Existing ledger rows are never rewritten, and already-applied SQL is never rerun.

The byte-oriented scanner preserves every byte inside single-quoted strings, double-quoted identifiers/values, backticks and bracketed identifiers, including escaped quotes. It also preserves bare CR, non-UTF8 bytes and all non-EOL whitespace/comments/content. Newlines inside SQL values therefore remain meaningful checksum differences. No text-decoding replacement, SQL reformatting or semantic guessing is used.

The source-controlled alias file contains only three exact legacy hashes for 0082-0084 and their canonical content hashes. Each was verified against its unchanged Git SQL object and the existing hosted ledger. An unknown mixed layout, wrong tag or any changed canonical content remains an error. Fresh SQL checkouts are pinned to LF through .gitattributes; historical SQL source files were not edited.

## Verification

- Nine checksum tests passed, retained in work/migration-portability-tests.json. They cover raw/LF/CRLF compatibility, all three audited mixed aliases, modified SQL/comments/whitespace/literals, invalid hashes, quoted line breaks/escaped quotes, comment boundaries, bare CR, invalid UTF8 bytes, malformed aliases and unknown layouts.
- Every one of the 86 current working-copy migrations has the exact same safe canonical checksum as its committed Git SQL object. Historical working-copy hashes match the clean Git objects under the restricted compatibility rules.
- The actual migrate-turso command applied all 86 migrations from an isolated clean-LF Git-source copy into a fresh disposable local database. Its 86 ledger rows match the new canonical checksums. No environment secrets were copied into that source copy.
- A fresh read-only hosted SELECT verified all 85 existing ledger entries against clean Git SQL with the new checker. No ledger or schema writes occurred. 0085 is still pending remotely.
- Both CLI modules pass Node syntax checks; three-file typed lint and actual-source TypeScript pass.
- This changes only CLI verification/metadata and Git attributes, not application runtime code. The preceding storage checkpoint's production build and 47 regression tests remain applicable; no redundant application rebuild was run for this CLI-only follow-up.

The two original dirty main files, including the edited 0068 migration, were not staged or changed. The new checksum logic does not ignore that file's non-EOL content differences. No remote migration, CROP/Sites operation, provider/credential change, cron activation, push, deployment, user signature or transaction submission occurred. Production remains b58355d. Next continue guarded recovery/release transitions and owned API/UI integration for complete launch groups.
