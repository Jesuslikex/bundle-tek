# Imported-token picker search and paging

18 October 2026. Follow-up to ff0dacb. Older owned imports are now reachable instead of being hidden beyond the newest100.

## Behavior and query boundary

Users can search active owned Solana imports by name, symbol or mint, with an80-character limit. Search is manual through the button or Enter; Enter prevents parent-form submission. Inputs are bound as SQL parameters with literal substring matching, so percent/underscore and SQL-looking text do not become wildcard expressions or SQL. Matching is case-insensitive and search text is trimmed.

Next/Previous browse100records per page using updated_at descending and ID ascending keyset order. The continuation includes format version, exact source project/update, exact search, and the last record's ID/revision/update time. Before continuing, the service verifies the anchor is still an active owned matching Solana import. Changed, archived, foreign, wrong-source or wrong-search anchors refuse; reload returns to page one. Every source is still rechecked after the list read, and the strict read-only/authority-off response remains.

The client checks source/search/page echoes, hasMore/nextCursor agreement, a full100record continuation page, the exact tail ID/revision and absence of repeated identities/anchor. The original2048byte decoded request limit and100item response bound remain. Server mint resolution and revision checks still happen before actual layer planning.

Searching, paging, selecting another record or reloading clears the previous selection and mounted planner. No first result is chosen automatically. Page status is announced; focus moves to the returned choices after the user's read action. Buttons have normal navigation labels and disabled states. The picker warns that imports may change while browsing. This is live keyset navigation, not an immutable inventory snapshot or proof that a mutating collection was exhaustively observed; stale anchors require an explicit reload.

## Verification

Final offline related run: 11 files / 141 tests passed, zero failures/pending/todo. JSON/config work/release-qa/imported-picker-paging-final-20261018. An earlier focused3file/31test pass is retained separately and not added to the final count.

The real API/database service tests now cover101tied-timestamp records across two pages with no duplication, search reaching record101 directly, changed revisions, foreign/archived and cross-source/search anchors, literal/injection-looking search, bound lengths and substituted cursor/page responses. Actual picker tests cover forward/back navigation, explicit selection, query/source cancellation, discarded late results, Enter preventing parent submission and returned-choice focus, plus existing empty/error/timeout/authority cases. The same final selection includes metadata wiring and existing layer/new-token/Stonk/holder reviews. Existing planner act warnings remain disclosed; this patch does not resolve them.

Five-file type-aware lint, six-file formatting/whitespace and whole-project TypeScript passed at the current checkpoint. The other chat's payment drafts were present and not edited. This passing command is not a frozen all-source build qualification. No new Next production build or full-suite green result is claimed.

Chrome rendered the actual picker/planner with101synthetic public records. The first load showed100choices and a blank selection; Next exposed the101st, Previous returned to a blank first page, and typing T100 then Enter found that older record directly without automatically choosing it. Explicit selection opened its exact imported ID/revision/mint planner. The counter showed manual reads only. Client/scroll widths were1440/1440,360/360at375px and305/305at320px. Fixture/source/screenshots: work/imported-picker-paging-qa-20261018, including page-two.png, desktop.png, mobile.png and narrow.png. Provider/unrelated reads, writes and wallet actions were blocked. Tab/server stopped and viewport reset. This synthetic renderer is not signed-in production/provider/funded evidence; ownership/cursor behavior is separately tested against the actual local route and SQLite.

## Scope and remaining work

Only layer-target model/service/tests and the imported picker component/CSS/tests changed. No route authority, schema/migration, protected layout, account/payment file, provider/credential/cron, wallet unlock/sign/send, hosted SQL, push or deployment change. Stock signing and staged funding/execution remain unavailable. Broader Proxima parity, integrated stable-source release checks and actual supported funding/execution evidence remain open.
