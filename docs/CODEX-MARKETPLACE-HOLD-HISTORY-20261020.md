# Saved wallet holds: account recovery and history

20 October 2026. Source-only follow-up to `0e49132`. This closes the missing-ID recovery path; it does not implement purchase history or checkout.

## Server read

Authenticated GET `/api/marketplace/reservations?history=1` returns at most 20 saved holds belonging to the verified session buyer. Optional `beforeCreatedAt` and `beforeId` must appear together, with canonical UTC timestamps and lowercase UUIDs. Unknown selectors, buyer IDs, duplicate keys, incomplete cursors and malformed dates refuse before SQL. The existing exact-ID GET is unchanged.

Source-only migration `0121_marketplace_reservation_history` adds the `(buyer_id,created_at DESC,id DESC)` index. The service requires that index and the original reservation guards, uses a bounded indexed SQL query with a one-row lookahead and joins releases in the same statement. It replays each selected immutable receipt through the existing domain validator before publishing summaries. Corruption or cancellation refuses the page rather than returning a partial result. The shared decode extraction retains the original checks, using one captured clock per decoded read; no custody, financial, signing or lease rules are relaxed.

Summaries contain ID, creation/expiry/release timestamps, state at the history snapshot, count, SOL asking price and receipt hash. They omit full wallet/review contents and buyer identity. Solana and Bundle are explicit. All reserve/release/purchase/payment/delivery/signing authority flags are false. A full owned receipt must still be fetched and admitted before release consent is offered. A summary hash is not an authorization.

Pages sort newest first by the immutable creation time and ID; the next cursor is bound to the final returned entry. Client admission checks exact shape, authority flags, units, timestamps, five-minute duration, state-at-snapshot, duplicate/order/boundary rules and next cursor. A newly received history snapshot must be less than 60 seconds old. Displayed rows explicitly retain snapshot wording and time; they do not claim continuously refreshed status. Latest/Older are manual reads with no polling, automatic action or lease renewal.

## Buyer experience

Recover wallet hold now offers Find my saved holds without requiring session storage or a copied ID. Opening the dialog makes no request. History reads do not retain a new local ID or produce an approval. Opening a selected row clears the summary list, focuses the stable dialog panel, fetches the full owned receipt and presents the existing unchecked release acknowledgement. The manual-ID path remains available. History failure or missing migration does not turn a summary into permission to release.

The history list scrolls within a bounded area so pagination remains reachable. Buttons retain 44 px targets. The existing pending-request cancellation, strict full-receipt admission, one-write-per-approval behavior, safe errors and separate hold/release approvals remain intact. No protected shell/token layout, shared dialog or global CSS is changed.

## Verification

All 26 marketplace test files pass: 348 tests. New coverage includes 14 summary/cursor admission cases, three native route cases and four discovery/pagination/error UI cases. The final 16 buyer tests pass again after the final list/focus adjustment. Native tests seed actual drafts/publications/holds/releases through production services and the Turso adapter against disposable in-memory libSQL. They page 25 buyer receipts as 20 plus 5, exclude another buyer, require the intended index, capture SELECT-only history traffic, check auth/selector/cancellation admission, retain exact-ID recovery when the history index is missing and refuse corrupted saved receipts. No provider fetch is allowed.

The disposable local-file checksum runner upgrades 0120 to 0121, preserves the original 121 ledger rows and sentinel data, matches all 122 checksums, passes integrity/foreign-key checks and repeats with zero new migrations. Whole-file local Wrangler independently applies all 122 migrations. The upgrade runner's `--remote` flag is explicitly pointed at a sanitized disposable `file:` URL, not an application or hosted database.

Chrome uses actual buyer/catalog/history components with labelled synthetic public in-memory fixtures. Twenty-three seeded receipts appear as 20 plus 3. Latest/Older discovery plus full-receipt recovery make four reads and zero UI writes, payments or signatures. The recovered receipt clears the list and leaves release disabled until separately acknowledged. At 375 px, document client/scroll widths both375; the popup is343px with matching client/scroll widths, and the list also has matching widths. Desktop1440 and phone screenshots are in `docs/qa/20261020/marketplace-hold-history/`. This browser fixture is not evidence of production sign-in, durable backend persistence, real inventory or chain settlement.

Typed lint, formatting and final plain `tsc --noEmit --incremental false` pass. Final isolated `next build --webpack` exits0 on `0e49132` plus eleven owned source/test/migration overlays with all canonical/snapshot hashes unchanged. It uses a sanitized environment, no application `.env`, local font fixtures and a dependency junction. Evidence: `CODEX-MARKETPLACE-HOLD-HISTORY-BUILD-20261020.json`, `CODEX-MARKETPLACE-HOLD-HISTORY-UPGRADE-20261020.json` and `CODEX-MARKETPLACE-HOLD-HISTORY-WRANGLER-20261020.json`. Detailed final buyer tests remain in ignored `work/release-qa/marketplace-hold-history-final-ui-tests-20261020.json`. No whole-repository test run, production sign-in or funded qualification is claimed.

## Release boundaries and remaining work

No application/hosted migration, actual hold/publication, operator access configuration, provider/credential/cron change, wallet unlock/sign/send, funded action or deployment. The application migration remains a release prerequisite. The journal ends at0121; next free number is0122, subject to recheck. Git publication does not deploy this work.

Still open: fresh sale qualification, funded payment destination/authorization and finalized reconciliation, secure key delivery/import and actual purchase history. These are hold records, not acquired wallets, proof of exclusive custody or P&L. Broader Proxima parity remains unproven.
