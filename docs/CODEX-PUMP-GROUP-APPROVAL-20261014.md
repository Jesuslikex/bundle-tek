# Immutable consent and durable group approval

Started 14 October and completed 15 October 2026, based on 072b455. Adds a server-internal approval service and append-only 0083 consent ledger/guards. Recorded approval still grants no signing or submission permission.

## Implemented

Approval requires the group storage and approval guards, authenticated owner/format, a live complete review and exact consent binding the review, manifest, context, original simulation digest, whole-group scope and acknowledged simulation limits. Missing guards or mismatched consent reject before fresh provider reads.

The server revalidates the original complete group against fresh owned configuration, sources, deployment metadata and economics. The ledger stores the exact canonical consent and immutable fresh evidence with its fresh simulation digest, separately from the originally reviewed simulation digest. It never accepts a client-authored fresh simulation.

0083 creates pump_group_approvals, with one immutable record per review and a parent foreign key. Its insert guard matches the owner, live original review, all consent digests/scope/acknowledgements, disabled signing/execution flags, fresh manifest/expiry and bounded database-clock observation/creation freshness. Current project bytes/revision, deployer role/proof/revision, metadata release and every selected holder proof/role/revision/folder are checked at the database boundary. The existing parent transition guard also checks the deployer folder and live context.

The AFTER INSERT trigger transitions the parent to approved inside the same statement, then asserts that the transition succeeded. A final guard failure rolls back both the consent row and parent update. The previous stage guard is replaced only in this append-only migration: it allows exact evidenced review-to-approved or never-approved review-to-cancelled transitions. Signing, submission and approved cancellation remain blocked. Wallet reservations stay active after approval.

Duplicate approval revalidates fresh sources and resumes the matching immutable consent without another ledger row. Approval records cannot be updated or deleted. An approved review cannot be released by the unsigned cancellation service; lifetime/receipt recovery is still required before releasing a possibly approved offline signing context.

Public review results can report approvalRequired=false for the approved state, but signingAllowed=false, executionAllowed=false and completeLaunch=false remain unconditional. This state records consent, not live v1/transport/code qualification or actual transaction execution. No API/UI exposes the new action yet.

## Verification

- Initial focused storage/approval file passed fifteen cases.
- Final six selected group service/preparation/review, existing holder review, paged history and holder-route files passed 65 tests with two workers, including the added parent-transition rollback case.
- Disposable SQLite through the real Turso/D1 adapter proves exact approval persistence/idempotency, immutable ledger, retained wallet reservation, signing/cancellation blocking, missing-migration/incorrect-consent rejection before RPC, zero-slot proof revocation at insertion and rollback when the parent transition itself aborts.
- Existing group revalidation, ownership, storage, pagination and holder compatibility cases remain passing. Controlled collectors and economics use real code; only create preflight is mocked. No live provider/BPF/funded execution proof is implied.
- Actual-source TypeScript, three-file typed lint and whitespace checks passed.

- Final source passed Wrangler's real whole-file migrations apply --local: all 84 migrations applied and the disposable ledger matched the journal. Sanitized receipt: docs/CODEX-PUMP-GROUP-APPROVAL-MIGRATION-20261015.json. Its hash identifies the tested working-copy SQL bytes. Full retained report: C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-qM8HhQ\report.json.
- Production Next.js build passed. Ignored log: work/group-approval-build.log. Drizzle generated the new table migration/snapshot from its schema; existing journal entries and SQL files were not rewritten.

## Required continuation

Implement full-group browser-local signing and complete signature verification/registration with qualified live authorization, then one-attempt submission and complete/partial/unknown recovery/UI. Approval alone must never bypass source, program/code/authority or transport/tip qualification. Full unsigned v1 replay and send transport remain unverified. Groups above five packets still need an explicit execution policy. Approved but unsigned groups also need final-lifetime recovery before reservations can be released safely.

No remote SQL/migration, API/UI/protected Claude file, actual provider request, credential/provider change, cron, push, deployment or real-wallet action occurred. Migrations 0081/0082/0083 remain local; main's two unrelated dirty files are preserved. Full Proxima parity remains unfinished.
