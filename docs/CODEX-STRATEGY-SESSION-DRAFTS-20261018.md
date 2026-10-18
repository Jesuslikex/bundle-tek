# Owned multi-strategy draft workflow, 18 October 2026

## Scope and reference

REA reconnected to the user's existing dedicated Proxima Chrome target after the reboot, using the previously approved loopback WSL relay. No new browser/profile or provider setting. The live AutoBuy configuration showed optional amount/time stops for each strategy and separate optional amount/time stops for the whole session. These are observed UI terms, not evidence of Proxima's executor, settlement, accounting or safety guarantees.

Private evidence stays outside Git under `/opt/rea/results/`:

| Capture | Evidence | SHA-256 |
| --- | --- | --- |
| `strategy-group-20261018.json` | `ev_46f4ac994b0da16206e802d36651505daa82379809686a4436a129497172fb53` | `e4cfa81fc89565943b15f985a6879564260ce5edefab378dffe58270e17cfe28` |
| `strategy-group-current-20261018.json` | `ev_f170c4ed99eb29e44e5eb0f7ed0e56501812da3b3aa5bb60869bbe5f6de69753` | `5b3ad22e4df6f89940d47b8248466a3e77cafa3e45b1581197da92e521d9c46c` |
| `strategy-group-restore-20261018.json` | `ev_cb94cd72ac386184373728ab0a7c85bf60f622c2c570d0a656775400ccba5729` | `2e192320340ef21b9a192a9d7994d5ac73e611b8acb687a2fef51df43ab85dbe` |

The first capture partially completed: an outdated Advanced button locator timed out. The corrected four-step capture completed Configure, End Conditions, Advanced Options and Close. Final restoration to the original account page completed. No reference amount entry, strategy addition, Run, estimate, funding, approval or transaction action.

## Implementation

Imported Solana projects now offer a separate draft planner for one to eight finite DCA/Limit strategies. Optional independent and shared input/time caps are preserved as null when absent. Buy inputs use SOL; Sell inputs use exact imported token units. The review includes normalized wallet addresses, kind, input amounts, cadence/cycles or market-cap threshold/direction, separate caps and effective shared deadlines. Candidate bounds use integer atoms and exclude DCA cycles at or after the deadline. Budget warnings compare bounded finite candidate inputs, not loose declared caps; they do not allocate funds or predict trigger order.

An immutable `strategy-session-draft-v1` document always retains planningOnly=true and funding/signing/executionAllowed=false. No executor accepts the format. New authenticated API and storage adapter support owned save, paginated history, reopen-as-new-copy, archive and restore. Saves bind current project document/revision and active wallet revisions atomically. Same-attempt retries keep their ID and captured start, including ambiguous cancellation; explicit reopening resets the copy ID. Historical idempotent saves return retained terms, never refresh or reactivate them. Archive/restore uses revision guards and immutable SQL terms. Cursor anchors remain usable after archive, within their original owner/project.

Client requests have bounded transport/body-read deadlines, cancellation, actionable authentication/storage errors, exact response identity/terms checks and ignored late results. Review is invalidated by selected wallet/project/lock changes. Optional hidden limits have accurate empty labels. The shared DurationInput change is only a backwards-compatible emptyLabel prop. The imported session parent only mounts the new planner.

Migration 0108 creates the disabled draft table and immutability guards. New rows are capped at 100 active/1,000 total per owned project; pages hold 20 records. No hosted migration or real account database write was performed. New draft saves against an unmigrated connected database remain unavailable until a separately authorized release applies the migration.

## Verification

- Final focused selection: 10 files, 131 tests passed. Includes mounted planner, authenticated route, actual libSQL/Turso adapter and 0108 SQL guards, client deadlines/body parsing, pure plan arithmetic, existing DCA/conditional sessions, parent Counter integration and DurationInput. Not a full repository suite.
- Standalone TypeScript and scoped typed lint passed. Final formatting/build/migration results are recorded below after completion.
- Independent read-only review found three P2 issues: reopened ID reuse, overstated budget warning, omitted material review terms. All three corrected and covered by regressions, including precise token input/threshold rendering and short deadlines.
- Real component/browser fixture uses a synthetic account, public fixture addresses and the actual draft service with disposable in-memory SQLite. It never accesses a vault/provider or the user's real account. Mobile review/save, archive/restore, retry of an archived record, reload/reopen with exact retained UTC start, and distinct new-copy saves were verified. Initial fixture omitted global CSS; that harness issue was corrected before final styled checks. With actual built styles, 320/375/1440 widths have client/scroll widths 305/305, 360/360 and 1425/1425, including an 80-character unbroken name. Proof: ignored `work/release-qa/strategy-drafts-mobile-final-20261018.png`.
- Initial full-file disposable Wrangler attempt applied 0108 but failed concurrent 0109 with `too many terms in compound SELECT`. The launch-layer owner is correcting 0109; this failure is retained, not reported as a successful full-chain migration check.

## Remaining boundaries

This is saved planning, not active multi-strategy execution. Shared atomic admission/reservations, trigger scheduling, continuous strategies, settlement and recovery, additional strategy/quote-asset coverage, marketplace/vendor qualification, production program qualification and funded end-to-end acceptance remain separate work. Broad Proxima parity and superiority are not established. Claude's isolated token UI remains unmerged pending real client-shell evidence; the concurrent launch-layer backend/migration is owned and committed separately. No credentials, private captures, generated assets, provider changes, remote SQL, push, deployment, funding, wallet unlock, signature or submission in this checkpoint.

## Final build and checkpoint

Full-file Wrangler rerun passed all 110 migrations with the exact 110-entry ledger after the launch-layer owner corrected 0109. Receipt: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-heLkMR\report.json`; 0109 SHA-256 `fea93f24147d201cd5dea4423ac4d5bf5cad7780ac3e3ee0e7f4d2f384e49cbd`. The independent full-chain Miniflare/SQLite schema test also passed (13.28 seconds). Both checks cover the combined frozen working tree, including the other chat's separately owned 0109.

Combined production webpack build completed with exit 0: compilation 39.5 seconds, build TypeScript 42 seconds, page generation and traces completed. Scoped typed lint and formatting check passed on final owned sources/tests. The existing trusted-certificate HTTPS helper was restored at `https://localhost:3443`; sign-in returns 200 and anonymous draft history returns 401. No TLS warning bypass or certificate/provider change. The local guard still blocks unrelated writes and all transaction paths; authenticated persistence acceptance here is the disposable actual-service browser fixture, not a hosted or real-account migration/save claim.

Local checkpoint contains 20 owned strategy files/hunks, including only 0108 and its schema/journal entries. Concurrent 0109, launch-layer service/API/schema and coordination notes remain unstaged for their owner. Runtime captures, screenshots, temporary fixture files and SQLite databases are excluded. Production release remains unchanged.
