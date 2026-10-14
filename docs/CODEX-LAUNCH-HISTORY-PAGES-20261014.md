# Paged launch recovery

14 October 2026, based on 4847b64. Older launch outcomes are now accessible beyond the previous twenty-record window.

## Implementation

All three authenticated launch GET routes accept opt-in page=1 and an optional cursor. Existing requests without paging keep their legacy response shape and service path. The new response includes at most twenty public records and a nextCursor or null. The shared SQL reader fetches twenty-one records to determine whether another page exists; it orders by created_at DESC and id DESC, and advances by that exact pair. Identical timestamps do not skip records. Newer insertions between reads do not shift older pages.

Cursor decoding is canonical, bounded and tied to project/type. Duplicate, malformed, noncanonical and wrong-scope cursors return 400 before the page read. A cursor is a position only, never authority: each SQL query binds authenticated owner, project and a fixed launch-type predicate. Public service projections remain unchanged. No signed bytes, vault or credentials are returned by pagination.

The recovery panel requests paged histories and exposes independent Load older buttons. Pages append existing rows; final cursors remove the button. Failed reads preserve rows/cursor for retry. Duplicate/overlapping records and repeated next cursors are refused. Existing project-change abort/remount and exact selected-record recovery remain intact. This panel never prepares, approves, signs, registers, cancels or submits packets.

## Verification

- Eight selected local SQL/route/UI files passed 94 tests. Final focused pagination/model and panel files passed all ten tests again after test typing and responsive wrapping changes.
- Actual libSQL and real authenticated route handlers traversed forty-five records for each of create/developer/holder types, with tied timestamps, a newer insertion between pages, owner/project/type isolation and exact terminal exhaustion. Additional cases cover legacy shape, malformed/duplicate/wrong-project/type cursors, signed-out rejection and cursor reuse by another owner returning only that owner's rows.
- UI regressions prove append/exhaustion, failed HTML page retention, cursor loops/overlap rejection and existing recovery/context behavior.
- Actual-source TypeScript, ten-file typed lint, diff whitespace checks and final production Next build pass. No remote database or migration runner used.
- Existing Chrome rendered the actual panel with a loopback-only controlled response harness. Loading an older holder page appended an unresolved submitted record and retained all first-page records. Desktop and 390 by 844 phone were inspected; document width equals 390. Screenshots: ignored work/launch-history-pages-desktop-20261014.png and work/launch-history-pages-mobile-20261014.png. All mutation calls were blocked and no provider/wallet API invoked. Harness stopped, viewport reset, tab closed.

The first focused run's isolation expectation incorrectly expected no rows for Bob, although Bob had his own fixture row; corrected expectation explicitly verifies his own row is returned and Alice's are absent. Test response types were then made explicit. Final tests/type/lint/build are green.

## Scope and remaining work

Pagination itself is complete for the retained launch table and these three route types. It does not restore an old review into the signing composer or independently audit the reported chain state. Direct saved-review navigation, larger launch groups, scheduling, StonkFun, full authenticated browser/provider/funded proof and broader Proxima parity remain open. The Solana v1 4096-byte premise was checked against https://solana.com/docs/core/transactions/versioned-transactions ; large groups still require a distinct execution design.

No SQL schema/history, protected Claude file or global CSS changed. No remote SQL, provider/credential change, cron, push, deployment, vault unlock, signature or broadcast occurred. Migration 0081 is still local only. Production remains 11ad20b. Main's unrelated dirty Jito note and 0068 migration remain preserved.
