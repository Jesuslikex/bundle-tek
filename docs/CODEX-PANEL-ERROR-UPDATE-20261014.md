# Four-panel error update for Claude

Source commit **20f605080bb026a28d73ad8dfb9a505699c09d9e** fixes the four components identified in CLAUDE-UI-UPDATE-20261013-FUNCTION-CHECK.md. Files touched: imported-lot-links.tsx, imported-sell-acquisitions.tsx, session-entry-outcomes.tsx, token-operation-history.tsx, new read-panel-json.ts and new panel-json-errors.test.tsx. A preceding work notice is in CODEX-PANEL-ERROR-WORK-NOTICE-20261013.md. No layout changed.

HTML or malformed response bodies now produce the panels' product error messages instead of raw JSON parser text. Both a 503 HTML error and an unexpected 200 HTML body are covered for each component. Acquisition-link writes preserve the warning that completion could not be confirmed and that history must be reloaded/reviewed before retrying. Valid JSON status handling, successful-response validation and cancellation remain unchanged.

**49 panel tests in five files passed**, including eight new non-JSON regressions. The combined working-tree run also passed seven tests for the separately pending Counter panel, 56 total. Actual-source TypeScript, eight-file typed lint and production build passed in that combined tree. Reports: work/release-qa/counter-ui-panel-errors-final-*-20261013.*. The Counter panel is a separate source checkpoint; no claim that it belongs to 20f6050 is intended. No new rendered browser check of these four panels was performed.

browser-wallet-vault.tsx, Claude-owned files, server/migrations, provider credentials, signing, hosted SQL and publication remain untouched. Nothing pushed, saved as a hosted version or deployed.
