# Durable unsigned group reviews and reservations

14 October 2026, based on 597e700. Adds append-only 0082 guards and a server-internal complete-group review store. Groups can be saved, read, paged and cancelled while unsigned. Approval, signature registration and submission remain disabled.

## Implemented

The service requires all four new guards before collection. It reads the authenticated owner's exact active saved project revision, resumes identical existing group terms without another provider call, and rejects another review reserving that project. New records use owned server preparation and its internal input capture; client-authored simulation or targets are not accepted. The complete immutable review contract is validated before one insert into the existing review table.

Existing unique project/payer/mint indexes and immutable history guards still apply. New SQL guards bind group identity, project/revision, saved document, deployer identity/revision/role, metadata release, complete holder slot identity and collected manifest/allowance/simulation scope. Every holder, including zero slots, requires its saved owned proof/role/revision/folder at insertion. The SQL guard protects the final insert race in addition to the preflight's owned rechecks.

An active group reserves its deployer and every active holder against existing launch reviews and shared warmup/imported/withdrawal reservations. Conflicts reject in both insertion directions. Zero allocation holders retain ownership requirements but do not reserve execution wallets. No separate reservation writes or partial-row cleanup are needed: the guarded review insert is the atomic reservation boundary.

At this stage group records can transition only from review to cancelled with no signatures, signature identifiers or receipt. A database stage guard rejects approval and execution transitions. Cancellation uses authenticated owner/format filtering and a compare-and-swap against the original immutable review; it releases active uniqueness/reservation predicates while retaining history. No history deletion or review replacement is permitted.

Complete-group history uses owner/project/type-bound keyset pagination. Legacy create/developer history and action readers now exclude the group format. The new store's public results always keep signingAllowed=false, executionAllowed=false and completeLaunch=false. Individual record reads reconstruct historical review integrity; paged history is a read-only view of immutable stored rows and is never signing authority.

## Verification

- Initial seven focused storage cases passed. The final eight-case storage file, owned preparation, group review, existing holder review/signing, keyset history and available create/holder route files passed 75 tests across eight files with two workers. One requested initial-buy route test path does not exist; no pass is claimed for it.
- Actual Turso/D1 adapter over disposable local SQLite exercises saved review persistence/idempotency, owner isolation, legacy history/action isolation, both-direction legacy launch conflicts, warmup/imported/withdrawal reservation conflicts, zero-slot reservation semantics, retained immutable cancellation history and approval blocking.
- Direct SQL insertion tests independently check the atomic holder proof guard, including a zero slot. Direct SQL history fixtures exercise 23 rows across timestamp ties without omissions or duplicates. These database-only fixtures deliberately bypass application crypto to test SQL and pagination; they are not signable reviews or program execution proof.
- Group preparation and collectors use real code with controlled account/economic data. Only create preflight is mocked; no actual provider request or real signature occurs.
- Owned database fixture was moved to test/pump-owned-group-fixture.ts; preparation test behavior is retained.
- Actual-source TypeScript, eight-file typed lint and whitespace checks passed.
- Final source passed Wrangler's real whole-file migrations apply --local: all 83 files applied and the local ledger exactly matched the journal. Final retained report: C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-zVvITL\report.json. A preliminary run preceded the added deployer-role/release checks and is superseded by this final run. Earlier journal entries and existing migration files were not rewritten.

- Production Next.js build passed. Ignored log: work/group-review-storage-build.log. Sanitized migration receipt is committed in docs/CODEX-PUMP-GROUP-MIGRATION-20261014.json; its hash describes the tested working-copy SQL bytes.

## Required continuation

Add qualified durable approval with fresh owned/source checks and exact consent, all-packet browser-local signatures and registration, then qualified one-attempt submission and complete/partial/unknown recovery/UI. The stage guard must be replaced only by tested append-only approval/signing/recovery guards; bypassing it is not an execution policy. Live full unsigned v1 replay, program/code/authority and tip/send transport qualification remain open. More than five packets still has no enabled execution policy.

No API/UI/protected Claude file, remote SQL/migration, actual provider request, provider/credential change, cron, push, deployment or real-wallet action changed. Migrations 0081 and 0082 remain local. Main's unrelated dirty files are preserved. Full Proxima parity remains unfinished.
