# Launch setup review presentation, 21 October 2026

Before editing UI: Codex claims the existing pump-layer-planner review and its CSS, a new display-only summary component/CSS/test, and bounded review tests. Claude-owned parent/layout/token components remain untouched. Reference is the user-supplied Launch Setup screenshot; no fresh browser behavior or execution semantics are inferred.

Current source: LaunchSetupDialog exists but has no production caller. The actual connected LayerBudgetReview already has immutable role budgets, quote, three delays, filters and paging. Improve that connected review rather than add a disconnected modal. Show bound configuration only, preserve all existing totals, source terms/hashes, filtering, consent and actions. A declared native ceiling is not verified required funding, current balance or a supply allocation. Settings absent from layer terms cannot be fabricated from current mutable draft options.

## Implemented display

The connected draft/saved review now shows validated snapshot token name/symbol (explicitly saved name), launchpad, quote, mode, preset, all six wallet roles, layer delays and buy timings. Omitted timing uses the existing zero convention and is labelled 0s (none saved); absent Back/temporary stages say Not used. Invalid or mismatched bound plan JSON shows an unavailable notice rather than using the mutable draft. Mint addresses stay behind an accessible disclosure. Rewards/slippage/fee sharing are explicitly unconfirmed here.

Wallet rows separate quote buy ceiling from exact SOL ceiling with explicit includes/excludes-buy labels, and retain fee/rent/reserve details with wallet-specific accessible names. Headings separate Configuration, Ceilings and Wallets. Draft/saved region names differ, each configuration heading has a unique ID, desktop tiles switch to two columns by container width, and phone wallet rows stack. Original filters, paging, role numbers, totals, term/hash/state/request/consent guards and handlers remain. The only non-review source changes are two display-only contextLabel props in the same owned component.

## Verification

Final delivery tests pass153 cases/14files with zero failures/skips. Plain TypeScript, four-file typed lint and six-file format checks pass. Tests cover exact fractional delay, bound metadata, corrupted/venue/quote/holder mismatch refusal, omitted and explicitly saved timings, duplicate draft/saved sections, collapsed address details, native/token separation and original filter/paging/unchanged terms. Existing real planner/service/terms tests remain in the related cohort. These tests do not establish live execution or visual fidelity.

Actual pinned Claude Opus5.5 completed two read-only reviews with unchanged copies and zero denials; no Haiku/fallback was used. Its first review caught missing Funder, status/units ambiguity, headings/disclosures and container width. The follow-up found no high-severity issue, raised omitted-timing wording and smaller source/display caveats. Those were independently corrected and tested. Final small wording/heading/native-output accessibility changes and extra tests were not rereviewed. The first isolated build compiled but its delivery hash check correctly refused it after these review changes; it is superseded by the final exact-source build result in companion evidence.

The final isolated production build passes on unchanged overlays with no copied environment files. All2,362 selected source files remain unchanged through delivery checks; see the companion evidence.

Chrome control still times out, so no final rendered/signed-in/live provider or deployed screenshot-match claim. No protected Claude parent/layout/token file, financial logic, schema/migration/application or hosted SQL, API, provider, credential, cron, real wallet action or deployment change.

## Remaining full Launch Setup requirements

This connects and improves an existing layer budget review, not a complete execution review for every screenshot option. Layer terms do not bind artwork/socials, launch slippage, reward/creator-fee/fee-share settings, selected funding order, finalized funding receipts, live balances or supply buy percentages. Those must be composed from their exact existing source revisions and qualified packets/receipts before a single final approval can represent them. No value is copied from the screenshot as a default and no protocol/backend behavior is inferred from its labels. Full Proxima parity remains open.
