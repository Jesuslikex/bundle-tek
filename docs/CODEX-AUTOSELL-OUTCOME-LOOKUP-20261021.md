# Read-only Auto Sell saved-outcome lookup

Source base: `40ec795fb5deb39701ce67fc95a3601a19cac1c1`. Source-only checkpoint; no deploy or real wallet action. The broader Proxima goal remains open.

## Change and boundary

New Auto Sell activity entries can retain the original project/revisions, preparation, approval, wallet, mint, raw input amount, unsigned packet hash and local signature. The executor constructs and freezes this lookup object immediately after the original signing step, before registration. It is not frozen at executor construction: existing dependency/session reads are intentionally unchanged. It accompanies either the original successful return or the existing uncertain error. Old three-argument error callers and returns without metadata remain compatible. Invalid lookup coordinates are omitted without changing token accounting or retry decisions. The runner owns a copied, frozen reference and keeps its original bounded log retention.

A collapsed activity disclosure identifies that exact original record. Opening the disclosure makes no request. An explicit Read saved outcome button makes one GET to the existing signed-in project/intent history endpoint. There is no new API, provider or chain query, database write, receipt capture, signature, submission, resend, financial callback or counter reconciliation. The existing endpoint and its ownership checks are unchanged.

The browser uses the original approval-page parser, then requires one matching record, no cursor, exact original IDs/revisions/wallet/Sell/mints/input/hash and any stored signature. Null signatures are allowed only in the original parser's unsigned states. Old expired and archived history remains readable without importing current authorization. The returned display projection contains no packet and fixes finalityVerified/signingAllowed/submissionAllowed to false. Stored finalized status is explicitly not loaded receipt proof. Accounted amounts never clear from a lookup result.

Read cancellation, timeout, context changes and unmount reject late results without automatic retry. HTML/parser failures stay controlled. Lookup rows use original intent plus kind keys, so a newly appended log no longer remounts an open disclosure or cancels a pending read. Activity scope is explicitly the latest20entries; a row that leaves that list or a closed tab loses this new lookup. The original approval remains in normal preparation history. No persistent reminder store or durable recovery is newly claimed.

## Verification

A frozen combined pinned Node24 run passes **236 tests in22files**, zero failures/skips, terminal exit0, at unchanged source digest fde83e16e35766ede815881d9a4915df0302aa97e38d5b879da25415552c0dce. Afterward only two test files received stronger assertions (Pause really appended a note; each saved state has its exact label). Their13tests pass again on final source. No product code changed after the combined run. Final2,812-file digest ba4935aacdd754a4444142908c287e83cda313cac702c115da93cdf979ff6088 is unchanged through final checks/build. This is236distinct tests, not249.

Tests cover original source mismatch fields, arbitrary local data stripped from references, copy/freeze ownership, legacy and invalid metadata, unchanged accounted amounts/no resell, unknown registration/submit outcomes, no second wallet or send after uncertain registration, no mount/disclosure fetch, GET-only request, stale/late/cancel/timeout/unmount refusal, HTML sanitization and exact labels without finality. An actual AutoSell modal plus real runner with synthetic vault/feed/executor keeps the exact open DOM node and pending request alive when Pause appends a new activity entry.

A new disposable native SQLite read-side projection composes the actual existing GET and new parser: original expired/archived/prior-revision approval succeeds without writes; missing sign-in runs no SQL; wrong owner/project refuses404. Non-SELECT requests throw. This proves the saved read path, not financial write admission or application/hosted schema. The unchanged40-test signing route and4-test approval parser suites are included, with disposable Miniflare/synthetic provider/signing evidence.

Final whole-project plain TypeScript,13-file typed lint,14-file formatting and the isolated production build pass. The build uses committed40ec795 plus14exact overlays, no application environment files or production credentials, with canonical/copy hashes unchanged. Expected isolated-copy lockfile/no-cache warnings remain. No new full-repository full-suite claim.

## Opus5.5 review

Two actual claude-opus-5-5 read-only reviews completed, copied source unchanged, zero denials and no model fallback. Initial review found the log-key remount issue; follow-up confirmed the correction and no critical/high/medium issue. Its low notes led to stronger final assertions and corrected wording about when the lookup object freezes, independently verified and not rereviewed. Reviewer never ran tests/build/browser. Complete raw logs remain ignored locally; the portable companion contains sanitized status, model and source-count evidence.

## Rendered QA and remaining product work

Chrome control remains unavailable on the previously selected existing connection. No new browser, competing dev server, lower-level automation, provider setting or browser-debug launch was used. The earlier40ec795 final compact-status render check remains open, as do this new disclosure's actual desktop/phone/keyboard and signed-in live read checks. Component DOM/unit/native source evidence must not be presented as browser/live proof. First resume those checks when the connection is available.

No new automatic warmup, financial reservation, short browser authorization, finalized action advancement, durable orchestration or qualified alternative routing is enabled. Full live/funded/provider qualification and marketplace fulfillment remain separate unachieved requirements. No protected Claude shell/layout/global file, migration/db, application/hosted SQL, provider/credential/cron setting, real wallet unlock/sign/send, funded test or deployment changed.0136 remains unclaimed subject to journal/claim recheck.
