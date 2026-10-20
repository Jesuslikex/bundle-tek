# Marketplace reservation API and availability

20 October 2026. Follow-up to source-only reservation storage `9a69c80`.

## Implemented

`/api/marketplace/reservations` authenticates through the existing verified session. GET accepts exactly one UUID `id` and recovers only that buyer's receipt. POST accepts only `reserve` or `release`, requires same origin and JSON, streams a maximum 512 KiB request and admits strict action schemas. Buyer IDs, roles, payment operations and extra fields cannot be supplied through the body. All responses disable caching; cancellation, malformed input, conflicts and storage failures have safe messages.

Reserve requires the complete exact cart and the separate acknowledgement already defined by the domain contract. Release requires its own acknowledgement and exact saved ID/hash. The route calls the tested immutable storage functions. Payment, purchase, signing and delivery flags remain false.

New IDs pass a buyer-scoped 15-second database gate using the existing `market_read_gates` table with a distinct `marketplace-reservation:` plus buyer digest key. Ordinary market reads keep their existing keys. Database time controls the gate. A failed new-hold attempt can consume this cooldown. It returns HTTP 429 and Retry-After 15; neither client nor server retries automatically. The route also asks the buyer to recover/release an existing active hold before creating another. Address overlap remains enforced atomically by migration 0120, independently of this convenience check. Same-ID recovery and release bypass the new-ID cooldown.

The first-party catalog now excludes addresses in unexpired, unreleased reservations, including a replacement publication under a new ID. Release restores still-eligible inventory on the next explicit catalog read; expired holds are likewise excluded from the blocking predicate. Both the catalog and storage require the reservation guards. Missing migration 0120 or missing guards refuse availability rather than silently exposing held wallets. Other buyers' reservation identities are not returned in the catalog.

No UI component or protected shell/layout is edited. The future buyer screen must supply a fresh unchecked acknowledgement, keep the same request ID through unknown outcomes, recover before another write, show expiry/release status and refresh inventory explicitly. API exposure alone is not a finished checkout flow.

## Verification

The 24 marketplace test files pass together: 315 tests. The six new real-route tests rerun after adding strict typed response admission, all passing. They use verified-auth fixtures with the production domain/services, real in-memory libSQL and actual 0118/0119/0120 schema. Outbound provider fetch refuses. They cover unauthorized reads/writes before SQL, extra buyer selectors, exact consent, malformed/oversized/cancelled requests, buyer-isolated recovery/release, catalog disappearance/restoration, idempotence, scoped pacing, missing guards and safe failures. Existing storage tests retain the independent SQL overlap assertion even though a fresh catalog now rejects an already-held selection earlier.

Fixture-only migration lists in the existing cart/publication route tests include unchanged 0120. No migration file or journal changes in this checkpoint. The preceding 121-migration whole-file Wrangler and checksum upgrade results remain the migration evidence; they are not a hosted ledger check.

Scoped type-aware lint, formatting and final plain `tsc --noEmit --incremental false` pass. The first TypeScript run saw the old untyped test-response shape; that test-only typing issue was corrected with strict schema parsing and checked again. Final isolated `next build --webpack` exits 0 on baseline `9a69c80` plus seven owned source/test overlays with all hashes unchanged. It uses a sanitized environment, no application `.env`, local font fixtures and a dependency junction. Evidence: `CODEX-MARKETPLACE-RESERVATION-API-BUILD-20261020.json`. No new browser result is claimed: these changes are API/storage integration with no buyer UI yet.

## Boundaries and remaining work

No application/hosted SQL, actual reservation or publication, real operator access, provider/credential/cron setting, wallet unlock/sign/send, funded action or deployment. Native fixtures are disposable and do not use application data. Migration 0120 remains a release prerequisite; the next migration number stays 0121, subject to recheck.

Still needed: reservation approval/recovery/release UI and saved-order discovery; qualified sale inventory; payment destination and exact user authorization; finalized one-payment reconciliation; secure delivery/import and history. A hold does not prove exclusive key custody or current balances, and it cannot authorize any of those financial operations.
