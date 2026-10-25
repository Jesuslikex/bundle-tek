# Expiring read-only project shares

25 October 2026. Source base `b63af28`. This adds genuine collaboration expiry; it does not add wallet roles, edit rights or signing delegation.

Owners can create access lasting 1 hour, 24 hours (default) or 7 days. The same deadline applies before and after acceptance. Accepted members receive the deadline with their read-only saved-plan projection. SQL-time filtering blocks subsequent reads after expiry, and both the conditional acceptance update and an independent database trigger reject an expired invite. Expiry is immutable, including legacy NULL values.

Existing shares keep their original no-expiry behavior and are explicitly labelled legacy. There is no backfill or silent conversion. Owners can still revoke; members can leave. Already viewed/copied data cannot be recalled. The old ten-share cap and unique membership index remain unchanged: expired shares still occupy those slots until explicitly revoked. Re-inviting an expired collaborator gives a specific revoke-first explanation, without automatically changing the older share.

The owner list now cancels obsolete reads and rejects late responses after a mutation refresh. A manual GET refresh recovers inspection after an unknown invite response; lost bearer tokens are not reconstructed. Successful invite responses require an admitted token and deadline. Cached member snapshots disappear at their local display deadline without automatic writes or requests; the server's SQL time remains authoritative for access. Missing expiry from an older server is labelled unknown, not silently treated as unlimited.

## Additive migration and coordination

`0148_project_share_expiry.sql` adds one nullable column and insert/update guards. Committed `0100` and all older migrations are unchanged. No application or hosted database was migrated.

Claude PR60 reserves `0147_marketplace_orders` with journal timestamp `1794860000008`. This slice uses `0148` and `1794860000009`; the local journal has 147 entries because reserved `0147` is not yet on main. On merge, put Claude's entry before 0148 and adjust only journal indices as needed. Do not renumber either SQL file or change a published timestamp/checksum. PR60 still needs its separately reported checkout/recovery fixes. The next unclaimed migration is 0149, subject to recheck.

## Verification

- 92 tests across seven files pass, including actual Miniflare route/database tests, the duration helper, transport projection, owner race/recovery and member expiry UI tests. Historic-expiry fixtures temporarily remove/recreate the exact guard only inside a disposable test database to model elapsed time or migrated legacy rows; production guards are never disabled.
- Actual whole-file Wrangler CLI applies all 147 journal files in a fresh disposable D1 with an exact filename ledger and exit 0. Native SQLite separately upgrades the prior 146-file chain after seeding an existing project/two shares: original values remain intact, new expiry is NULL, legacy access remains, new expiry/immutability checks pass, integrity is OK and foreign-key checks are clean. This is not a hosted checksum audit. The first private native assertion compared object prototypes incorrectly; correcting that assertion and rerunning native only passed. The original failure is retained.
- Existing Chrome rendered the actual compiled components against the actual sharing route and production Turso adapter backed by a disposable local SQLite file. Fixture authentication supplied two synthetic actors. Owner invite → member accept → inspect saved plan → owner revoke → member refresh completed with HTTP 200/201. The member snapshot disappeared after revocation. Desktop1920 and phone375 showed no horizontal overflow. No real account, provider or wallet was used.
- Actual Opus 5.5 source-only review read ten unchanged isolated copies with zero denials. It identified the expired-member unique-index explanation gap; the explicit revoke-first flow and tests address it. Final error, timer and effect-cleanup follow-ups were independently checked, not rereviewed. No claim of a full-suite, production-authentication or hosted release check.

TypeScript, scoped typed lint and formatting results are recorded in the companion JSON. No protected parent, Claude PR57/59/60 file, frozen warmup draft, provider, credential, cron, real signing/send or funded operation changed. No deploy.
