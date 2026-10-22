# Warmup retained execution-source checkpoint

22 October 2026. Source base `04e8a512692054c306adfd9406050a9e44c594e8`. This adds a server-internal advisory source snapshot, not automatic activity execution or signing admission.

## Source and currentness

`readWarmupExecutionSource` accepts a server-verified owner and exact retained review ID/context digest. It replays the original retained session review, validates canonical raw documents and their separate hashes, and enforces original review/creation/expiry timestamps on the server and SQL clocks. UTF8 byte limits, cancellation and exact rereads apply. The snapshot digest excludes observation time so checking again cannot renew the review.

The exported current-source SQL predicate binds all eleven retained row fields. It compares the owned current plan, wallet revisions, shared reservations and existing wallet-family busy predicate. Exact receipt counts and membership compare the original loader's thirteen buy fields and seven sell fields, including raw documents, signature-derived verification and remaining-amount COALESCE semantics. Changing a receipt while retaining its row count refuses. Old historical reviews remain readable; they do not become current execution evidence.

This SELECT is advisory. A future publisher must repeat the predicate inside its atomic write, together with real asset, rent, gross-budget and exact approval checks. Changes after observation remain possible. The returned scope is `retained-source-currentness-only`; signing, execution and automatic-execution flags are all false. Raw retained documents are internal and must not become a public DTO.

## Verification

- 209 tests pass across seven physical files, zero failures/skips. The new source file has 48 cases. Report: ignored `work/release-qa/warmup-execution-source-delivery-20261022.json`.
- Native SQLite and Miniflare D1 apply all 139 unchanged migrations with production guards intact. D1 tests exercise the sold-history and maximum-buy variants. Maximum uint64 token amounts remain exact TEXT and replay exactly on both engines. Fixtures use synthetic signed transfer envelopes and controlled token metadata, not real DEX/funded proof.
- Tests cover changed plan/wallet/receipts, owner isolation, wallet-family holds, both clock fences, cancellation, raw/replayed source mismatch, self-consistent substituted sources, final reread drift, UTF8 bounds and absence of writes.
- Plain `tsc --noEmit`, three-file typed lint and formatting pass. `git diff --check` passes.
- Actual `claude-opus-5-5` completed a Read/Glob/Grep-only review with sixteen unchanged source copies, zero permission denials and no blocker. The final functional source matches that copy byte for byte. The later maximum-amount test/fixture additions were independently verified by Codex, not rereviewed. The reviewer did not run tests or inspect every migration. Review artifacts remain ignored under `work/release-qa/opus-warmup-execution-source-20261022/`.

The earlier frozen `3bb015f` full suite passed 8,559 tests with six skipped, across 794 executed files and five wholly skipped files, plus 46 native script cases. It predates this checkpoint and the intervening identity/terms work; it is not a latest-source full-suite result.

## Remaining work and boundaries

Fresh verified asset/program/decimal/account-size/rent facts and conservative gross fee/rent authority are still required. Retained replay is not fresh provider or chain proof. Immutable approval/root publication, atomic reservations, runtime qualification, short authorization, browser signing, one-send recovery and actual integrated UI remain unfinished. Full Proxima parity is unproven.

No API/UI/provider caller, storage write, migration, protected Claude layout, setting/credential/cron change, application or hosted SQL, real wallet unlock/sign/send, strategy, funded test or deployment occurred. Migration 0139 remains unclaimed. Preserve the earlier unrelated archive handoff dirt in AGENTS.md. Git deployment remains disabled; the source checkpoint may be pushed for collaboration without a deploy.
