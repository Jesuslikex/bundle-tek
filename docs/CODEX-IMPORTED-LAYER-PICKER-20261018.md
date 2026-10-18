# Production imported-token layer picker

18 October 2026. Completes the visible picker missing from c77ba2d; layer funding, signing and execution remain unavailable.

## User flow

The saved Solana PumpFun/StonkFun Block-0 metadata review now includes Plan an existing imported token, separate from new-token preparation. A saved scheduled launch is required. The picker starts empty and performs no automatic read. Load imported tokens reads active owned Solana records; the user must explicitly choose a record. Each option and selected detail identifies the token, full mint, record ID and revision. No first-result default or arbitrary mint input is used.

The selected record is passed into the existing lazy planner with the exact source ID/update and imported ID/revision/mint. StonkFun uses its Front-only entry. Scheduling and platform admission are independently enforced by the saved source on the server, so unsaved UI changes cannot authorize another context. The planner still requires explicit context/history loading and a new review before saving ceilings.

Reloading clears the list, selection and mounted planner before reading. Changing selection or saved source revision disposes the old planner. Reads have a synchronous in-flight guard, manual cancellation and a 30-second abort race that settles even when transport ignores cancellation. Late responses cannot restore an old selection. Sign-in, timeout, gateway, empty list and malformed evidence have safe actionable messages; server bodies/parser diagnostics are not displayed. Buttons remain disabled with a scheduling explanation until applicable.

## Compact read boundary

The existing authenticated layers GET now supports exactly one bounded targets query (maximum2048decoded UTF-8bytes). A new service checks the owned saved source, exact update time, archive state, Solana/Block-0/PumpFun-or-StonkFun and scheduled flag. It projects only target ID/revision, public mint, name and symbol, rather than returning entire trading documents. It excludes foreign, archived and non-Solana imports and rechecks source identity/document after the list read. Inconsistent visible records withhold the list rather than exposing partial choices.

The endpoint returns the newest100active Solana imports and a hasMore flag based on a101st row. The UI explicitly discloses that window; it does not claim complete coverage. The client requires exact source binding, unique record IDs, valid public addresses/revisions and all funding/signing/execution flags false. A hasMore response must contain a full100record window. Selection still goes through the server's exact imported context resolver before planning. No provider, SQL mutation, schema/migration, financial handler, protected layout or signing gate was added.

## Verification

Final offline Vitest: 11 files / 135 tests passed together, zero failed/pending/todo. Evidence work/release-qa/imported-picker-final-20261018.json and matching config. The initial related run passed133tests; the final adds pending-source-change and401message cases, with original evidence retained. Six new service/actual-authenticated-GET tests cover ownership/chain/archive filtering, no-store responses, compact projection, no SQL writes via total_changes, exact query/size/auth/source requirements,100/101coverage, inconsistent records, concurrent source change and malformed client responses. Eight actual picker tests cover explicit second-record selection, real lazy planner, change/reload disposal, forged evidence, empty/window disclosure, ignored-abort timeout, cancellation, source change and safe sign-in messages. Existing metadata, layer API/service/client/planner and Pump/Stonk/holder reviews run in the same selection.

Eight-file type-aware lint, nine-file formatting and whitespace checks pass. Whole-project TypeScript first passed after test-only unknown-response/generic-query typing corrections, then a later final whole-checkout run failed in the other chat's new payment-accounting drafts (pump-group-payments and its fixture). Those files were not edited here. An isolated final TypeScript run at committed c77ba2de973d5048e0b6d0d5aec871679b44c907 plus these nine owned overlays passed code0, with all copied/source hashes unchanged. Evidence work/release-qa/imported-picker-typecheck-20261018.exit.json/source.json, pinned snapshot and runner. No ignored env/credential files were copied. This is not a claim that the concurrently changing whole checkout passes, nor a new Next production build or full-suite green result.

Chrome rendered the actual picker and planner with two synthetic owned records and current theme CSS. It made zero reads on mount, loaded choices without selecting one, opened the explicitly chosen second record/revision, and loaded its exact planner context without a developer. Reload after a synthetic HTML error removed the previous selection/planner and displayed the curated retry message. Client/scroll widths were1440/1440,360/360at375px and305/305at320px. Fixture source/screenshots: work/imported-picker-qa-20261018, including final-mobile.png, narrow.png and error.png. Provider/unrelated requests, writes and wallet actions were blocked. Tabs/server stopped and viewport reset. The fixture bundle builds. Metadata wiring is also covered by the actual component test; the browser fixture does not prove signed-in production behavior or funded execution.

## Remaining work

The list window is capped at100 and lacks search/pagination for older records. Staged distribution, fresh required-funding obligations, supported execution/recovery and funded qualification remain separate. Stonk creation/signing and stock signing stay unavailable. An integrated full-source build/test/browser release pass is still needed once the other chat's changes are committed and stable.

The account/payment owner's files and the user's uncommitted AGENTS record remain intact. No push, deployment, hosted SQL, provider/credential/cron change, real wallet unlock, signature or funded trade occurred.
