# Next release preparation, 19 October 2026

Status: local candidate prepared and verified within the scope below. Production migration/deployment approval and signed-in release QA remain separate. No production migration, deployment, cron/provider/credential change, real wallet unlock, signing, submission or funded trade is authorized or performed by this preparation.

## Frozen source

Candidate application source: `69467d685c7a27e0f10ddf6eb1196370162c5eb5` on main, including merged PR27 (`ad08571`) and the new read-only migration auditor. The latter changes release tooling only. Local verification uses a Git archive of this committed source, with no working-tree overlays and no environment files copied. The final documentation checkpoint may be later; application and migration blobs must remain identical to this candidate before release.

Ignored evidence and source manifest: `work/release-qa/next-release-20261019/`. The manifest hashes every archived tracked file. No other agent's account-session or UI files were edited. The other Bundle chat was notified to keep its implementation on a separate branch during verification.

## Production migration audit

At `2026-10-19T00:12:43.762Z`, Bundle's production database had **108 migrations**, through `0107_volume_bundle_recovery`. All 108 applied checksums match the committed migration files under the existing checksum/explicit historical-alias rules. No migration gaps, unknown entries or checksum mismatches were found. Source has 117 migrations. Nine are pending:

1. `0108_strategy_session_drafts`
2. `0109_launch_layer_plans`
3. `0110_strategy_review_capacity`
4. `0111_trade_amount_preferences`
5. `0112_trade_preset_keyboard`
6. `0113_pump_group_receipt_evidence`
7. `0114_pump_purchase_cost_sources`
8. `0115_imported_sale_receipt_evidence`
9. `0116_launch_sale_allocations`

The saved database endpoint was compared in memory with the decrypted `TURSO_DATABASE_URL` from the `bundle-tek` Production environment using matching SHA256 identity fingerprints. No endpoint or token was printed or committed. The auditor uses only SELECTs in a read transaction and rolls it back; it never invokes the migration runner, creates a missing ledger, repairs a checksum or applies a pending migration. Schema metadata was read; private account/wallet rows were not read or copied. A final read-only check at `2026-10-19T00:22:49.499Z` confirmed identical ledger, pending hashes and schema object metadata. The audit did not change production.

The 603 production schema object names and types exactly match a disposable local database built through0107. This compares object presence, not full SQL definitions or production row integrity. Production data-dependent readiness is not proven by this check.

## Exact local upgrade rehearsal

The unchanged checksum runner built a fresh disposable local0107 baseline, then exercised its existing-database branch against an explicit `file:` URL with a dummy local-only token. External Node fetch/socket calls were blocked. All nine migrations applied. All117 resulting checksums match, the original108 ledger rows remained identical, a synthetic preservation marker survived, integrity was `ok`, and foreign-key violations were zero. A repeat applied zero migrations. No production records were copied. This independently supplements the earlier0101-to0116 proof.

Committed sanitized report: `docs/qa/20261019/local-upgrade-0107-0116.json`. The pending SQL adds tables, indexes and guards;0112 replaces two trade-preference triggers transactionally. Do not rewrite any committed migration or skip a checksum refusal.

## Hosting and live read-only checks

Vercel project: `bundle-tek`, `prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS`, team `team_M6GTUdujU7FPO7CZq29qETrG`. The connector lists latest production deployment `dpl_77EbCVYdQ1paeNetY4R9BvVXfHw8`, READY, created `2026-10-18T04:23:24.905Z`, source `cli`. Its metadata does not provide a source commit, so that deployed commit is not claimed verified. No new deployment was created. Git-triggered deployment remains disabled in committed `vercel.json`.

Signed-out HTTP checks at `2026-10-19T00:16:03.824Z`: home200, sign-in200, group API `/api/launch/pump/groups`401. `/launch`404 is recorded honestly: source has no standalone launch page, and launch is an in-app view inside `app/page.tsx`. These HTTP checks do not verify signed-in launch/token screens, sale capture against real receipts or funded execution.

## Verification results

Verified on the frozen candidate: **15 targeted Vitest files,189 unique tests;46 native script tests; plain TypeScript and production webpack build passed**. All2316 archived tracked files retain their original SHA256 hashes. This preparation covers every changed Vitest test file since the prior full-suite baseline0008fb8, plus acquisition/evidence integration and migration checksum coverage. Test configuration disables environment-file loading; unmocked external Node fetch/socket calls are blocked for tests. Build permits loopback and the two existing Google Fonts hosts only and loads no production credentials.

The first combined run passed186/189 tests. Three checksum tests failed because the isolated PATH omitted Git (`spawnSync git ENOENT`). The harness was corrected by adding the pinned Git executable and pinning snapshot Git HEAD to69467d6 using local object metadata. The unchanged checksum test file then passed9/9, including a fresh117-migration local application. The other14 files'180 passing tests were not repeated. This is a corrected multi-run verification, not a single all-green combined run. UI tests retain React `act()` warnings. Build emits local snapshot/multiple-lockfile and cache warnings. No source edits were needed to resolve these harness failures.

Report: `docs/qa/20261019/release-verification.json`. It retains the initial failures and corrected result, source archive/manifest hashes, final production audit time and explicit no-deploy/no-funded flags. The new audit's five native tests cover ledger gaps/order/checksum refusals, pending hashes, read-only SQL/cleanup and preservation against real disposable libSQL.

The earlier full-suite result (603files/5329tests) belongs to0008fb8. It must not be reported as a fresh full-suite pass for this candidate. Any release decision should assess this baseline plus the exact current delta coverage; a new full suite is a separate remaining check if required before authorization.

## Future release sequence, not executed

1. Obtain separate approval for applying these nine production migrations and deploying the frozen committed release. Recheck main, claims, production target and actual ledger because this report can become stale.
2. Use existing secure production database configuration. Run `node scripts/audit-turso-migrations.mjs --check-only`; require the same108-entry prefix and nine expected pending hashes, or stop and reassess. Confirm a provider-supported recovery/backup point before writes; this preparation did not create or verify a production backup.
3. Only after approval, use the existing `scripts/migrate-turso.mjs --remote` runner. It checks prior checksums and transacts each migration with its ledger record. Never execute SQL piecemeal or alter applied history. If it refuses, stop before deploy and inspect the safe migration/statement diagnostic.
4. Rerun the read-only auditor. Require117 applied entries,117 matching checksums and zero pending. Archive a sanitized report. Deployment must wait for this result.
5. Deploy committed source only to the verified Vercel project. Resolve the candidate from its Git commit in a fresh directory; do not include current working-tree files or ignored secrets. Preserve existing settings, providers, stock signing gate, cron and consent/signing safeguards. Do not target CROP, Sites or pulseforge-legacy.
6. Record deployment ID and source commit, verify alias/READY, signed-out home/sign-in/group API, then inspect launch and token/account sale-review screens through the actual signed-in workspace. Do not claim `/launch` works as a route. Funded proof and any real signing/submission require separate trade-specific approval.

This document is a release preparation and evidence record, not permission to run the future steps.
